import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import { decisionKey, type CandidateDecision } from "../review/types";
import type { GedNode } from "../gedcom/types";
import { inferMainProfile } from "../normalize/profile";
import { normalizeDataset } from "../normalize/normalize";
import { materializeEventSources, mergeDecisions } from "./merge";
import { rowCanKeepBoth } from "./applyFields";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}
const tr = (key: string) => key;
const NO_MATCHES = { individuals: [], families: [] };
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;

// Main lacks a birth place and has a differing given name from incoming.
const MAIN = wrap(
  "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n" +
    "0 @I2@ INDI\n1 NAME Ana /Kos/\n1 SEX F\n1 BIRT\n2 DATE 1855\n",
);
const COMPARE = wrap(
  "0 @P1@ INDI\n1 NAME Jan;ez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n2 PLAC Kranj\n",
);

function confirmed(fields: Record<string, "main" | "incoming" | "both"> = {}): Map<string, CandidateDecision> {
  const m = new Map<string, CandidateDecision>();
  m.set(decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields });
  return m;
}

describe("mergeDecisions", () => {
  const main = dataset(MAIN);
  const compare = dataset(COMPARE);

  it("fills in a field the main is missing (default = incoming)", () => {
    const { records, report } = mergeDecisions(main, compare, confirmed(), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("1 BIRT\n2 DATE 1850\n2 PLAC Kranj");
    const change = report.changes.find((c) => c.to === "Kranj");
    expect(change).toBeDefined();
    // A plain, un-chosen copy of the incoming value — the preview should color
    // this like other incoming-sourced data, not like something the user edited.
    expect(change!.unedited).toBe(true);
  });

  it("leaves a conflicting field on main unless explicitly chosen", () => {
    const { records } = mergeDecisions(main, compare, confirmed(), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("1 NAME Janez /Novak/"); // main name kept
    expect(out).not.toContain("Jan;ez");
  });

  it("takes a conflicting field when the user chose incoming", () => {
    const { records } = mergeDecisions(main, compare, confirmed({ given: "incoming" }), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("1 NAME Jan;ez /Novak/");
  });

  it("carries the incoming _UID onto a merged record (skipping ones already present)", () => {
    const mainUid = dataset(wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 _UID {AAAABBBBCCCCDDDD}\n1 BIRT\n2 DATE 1850\n",
    ));
    const compareUid = dataset(wrap(
      "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 _UID AAAABBBBCCCCDDDD\n1 _UID 1111222233334444\n1 BIRT\n2 DATE 1850\n2 PLAC Kranj\n",
    ));
    const { records } = mergeDecisions(mainUid, compareUid, confirmed(), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    // The new lineage id is carried; the brace-spelled duplicate is not re-added.
    expect(out).toContain("1 _UID 1111222233334444");
    expect(out).toContain("1 _UID {AAAABBBBCCCCDDDD}");
    expect(out).not.toContain("1 _UID AAAABBBBCCCCDDDD\n");
  });

  it("places a carried _UID beside the existing one, ahead of the CHAN audit stamp", () => {
    const mainUid = dataset(wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 _UID {AAAABBBBCCCCDDDD}\n1 BIRT\n2 DATE 1850\n1 CHAN\n2 DATE 1 JAN 2020\n",
    ));
    const compareUid = dataset(wrap(
      "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 _UID 1111222233334444\n1 BIRT\n2 DATE 1850\n2 PLAC Kranj\n",
    ));
    const { records } = mergeDecisions(mainUid, compareUid, confirmed(), NO_MATCHES, tr);
    const lines = serializeGedcom(records).split("\n");

    const firstUid = lines.findIndex((l) => l.startsWith("1 _UID {AAAA"));
    const carried = lines.findIndex((l) => l === "1 _UID 1111222233334444");
    const chan = lines.findIndex((l) => l === "1 CHAN");
    // Grouped with its sibling, and never stranded after the record's audit tags.
    expect(carried).toBe(firstUid + 1);
    expect(carried).toBeLessThan(chan);
  });

  it("carries an incoming FamilySearch id in the main's tag dialect (default = incoming)", () => {
    const mainFs = dataset(wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n1 CHAN\n2 DATE 1 JAN 2020\n",
    ));
    const compareFs = dataset(wrap(
      "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 _FSFTID gpzg-cxl\n1 BIRT\n2 DATE 1850\n2 PLAC Kranj\n",
    ));
    const { records } = mergeDecisions(mainFs, compareFs, confirmed(), NO_MATCHES, tr);
    const lines = serializeGedcom(records).split("\n");
    const fsid = lines.findIndex((l) => l === "1 _FSFTID GPZG-CXL");
    const chan = lines.findIndex((l) => l === "1 CHAN");
    // Uppercased to the canonical form, and never stranded after the audit tags.
    expect(fsid).toBeGreaterThan(-1);
    expect(fsid).toBeLessThan(chan);
  });

  it("replaces a conflicting FamilySearch id in place when the user chose incoming", () => {
    const mainFs = dataset(wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 _FID GW82-GKR\n1 SEX M\n1 BIRT\n2 DATE 1850\n",
    ));
    const compareFs = dataset(wrap(
      "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 _FSFTID GPZG-CXL\n1 BIRT\n2 DATE 1850\n",
    ));
    const kept = mergeDecisions(mainFs, compareFs, confirmed(), NO_MATCHES, tr);
    // Conflicting ids stay on main unless explicitly chosen.
    expect(serializeGedcom(kept.records)).toContain("1 _FID GW82-GKR");
    expect(serializeGedcom(kept.records)).not.toContain("_FSFTID");

    const mainFs2 = dataset(wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 _FID GW82-GKR\n1 SEX M\n1 BIRT\n2 DATE 1850\n",
    ));
    const taken = mergeDecisions(mainFs2, compareFs, confirmed({ fsid: "incoming" }), NO_MATCHES, tr);
    const out = serializeGedcom(taken.records);
    // The main's own tag and position survive; only the value changes.
    expect(out).toContain("1 _FID GPZG-CXL");
    expect(out).not.toContain("GW82-GKR");
    expect(out).not.toContain("_FSFTID");
  });

  it("does not touch _UID on a confirmed match that took no fields (minimal diff)", () => {
    const mainUid = dataset(wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n2 PLAC Kranj\n",
    ));
    const compareUid = dataset(wrap(
      "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 _UID 1111222233334444\n1 BIRT\n2 DATE 1850\n2 PLAC Kranj\n",
    ));
    const { records } = mergeDecisions(mainUid, compareUid, confirmed(), NO_MATCHES, tr);
    expect(serializeGedcom(records)).not.toContain("_UID");
  });

  it("changes only the merged record (minimal diff)", () => {
    const before = serializeGedcom(main.records);
    const { records } = mergeDecisions(main, compare, confirmed(), NO_MATCHES, tr);
    const after = serializeGedcom(records);

    const diff = lineDiff(before, after);
    // Only the added PLAC line should appear; nothing removed, @I2@ untouched.
    expect(diff.added).toEqual(["2 PLAC Kranj"]);
    expect(diff.removed).toEqual([]);
    expect(after).toContain("0 @I2@ INDI\n1 NAME Ana /Kos/");
  });

  it("ignores non-confirmed decisions", () => {
    const m = new Map<string, CandidateDecision>();
    m.set(decisionKey("individual", "@I1@", "@P1@"), { status: "deferred", fields: {} });
    const { records, report } = mergeDecisions(main, compare, m, NO_MATCHES, tr);
    expect(report.changes).toHaveLength(0);
    expect(serializeGedcom(records)).toBe(serializeGedcom(main.records));
  });
});

describe("mergeDecisions — event TYPE and CAUS sub-fields", () => {
  const main = dataset(wrap(
    "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 DEAT\n2 DATE 1900\n",
  ));
  const compare = dataset(wrap(
    "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 DEAT\n2 TYPE natural\n2 DATE 1900\n2 CAUS Pljučnica\n",
  ));

  it("fills in an incoming CAUS and TYPE the main lacks (default = incoming)", () => {
    const { records, report } = mergeDecisions(main, compare, confirmed(), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("2 CAUS Pljučnica");
    expect(out).toContain("2 TYPE natural");
    expect(report.changes.some((c) => c.to.includes("Pljučnica"))).toBe(true);
  });

  it("leaves a conflicting main CAUS unless explicitly chosen", () => {
    const mainWithCaus = dataset(wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 DEAT\n2 DATE 1900\n2 CAUS Starost\n",
    ));
    const { records } = mergeDecisions(mainWithCaus, compare, confirmed(), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("2 CAUS Starost");
    expect(out).not.toContain("2 CAUS Pljučnica");
  });

  it("takes a conflicting CAUS when the user chose incoming", () => {
    const mainWithCaus = dataset(wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 DEAT\n2 DATE 1900\n2 CAUS Starost\n",
    ));
    const { records } = mergeDecisions(mainWithCaus, compare, confirmed({ "DEAT.cause": "incoming" }), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("2 CAUS Pljučnica");
    expect(out).not.toContain("2 CAUS Starost");
  });
});

describe("mergeDecisions — place reshaping to a structured-addr main", () => {
  // Place reshaping now happens when the incoming file is loaded (normalizeDataset),
  // not inside mergeDecisions — so these tests normalize the compare dataset first,
  // exactly as the app does after loading main + incoming.
  //
  // Main writes structured PLAC ("A,B,C") + separate ADDR, so its layout is
  // detected as structured-addr. @I1@'s birth has no place yet, so the incoming
  // (packed Brother's Keeper) place fills it — reshaped to the main's layout.
  const main = dataset(
    wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n" +
        "0 @I2@ INDI\n1 NAME Ana /Kos/\n1 SEX F\n1 BIRT\n2 DATE 1855\n" +
        "2 PLAC Kuželj,Kostel,Slovenia\n2 ADDR Kuželj 22\n" +
        "1 DEAT\n2 PLAC Kranj,Gorenjska,Slovenia\n",
    ),
  );
  const compare = dataset(
    wrap(
      "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n" +
        "2 PLAC Kranj (Slovenija), Kidričeva 38/a (porodnišnica)\n",
    ),
  );

  it("splits the packed place into PLAC and ADDR, keeping facility in parens in ADDR", () => {
    const { dataset: normalizedCompare } = normalizeDataset(compare, inferMainProfile(main));
    const { records } = mergeDecisions(main, normalizedCompare, confirmed(), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    // The main's own DEAT for @I2@ attests "Kranj,Gorenjska,Slovenia" — the
    // learned place hierarchy fills in that municipality level here too.
    expect(out).toContain(
      "1 BIRT\n2 DATE 1850\n2 PLAC Kranj,Gorenjska,Slovenia\n2 ADDR Kidričeva 38/a (porodnišnica)",
    );
    expect(out).not.toContain("2 NOTE porodnišnica");
  });

  it("does not rewrite existing PLAC when only ADDR is new (minimal diff)", () => {
    // @I2@ already has a BIRT PLAC that matches the incoming after reshape.
    // Only the new ADDR should be added — the existing PLAC must not change.
    const mainWithPlac = dataset(
      wrap(
        "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n" +
          "0 @I2@ INDI\n1 NAME Ana /Kos/\n1 SEX F\n1 BIRT\n2 DATE 1855\n" +
          "2 PLAC Kranj,Slovenija\n" +
          "1 DEAT\n2 PLAC Kuželj,Kostel,Slovenia\n2 ADDR Kuželj 22\n",
      ),
    );
    // Incoming has the same place in packed form plus an ADDR component.
    const compareWithAddr = dataset(
      wrap(
        "0 @P2@ INDI\n1 NAME Ana /Kos/\n1 SEX F\n1 BIRT\n2 DATE 1855\n" +
          "2 PLAC Kranj (Slovenija), Kidričeva 5\n",
      ),
    );
    const { dataset: normalizedCompareWithAddr } = normalizeDataset(compareWithAddr, inferMainProfile(mainWithPlac));
    const decisions = new Map<string, CandidateDecision>();
    decisions.set(
      decisionKey("individual", "@I2@", "@P2@"),
      { status: "confirmed", fields: {} },
    );
    const before = serializeGedcom(mainWithPlac.records);
    const { records } = mergeDecisions(mainWithPlac, normalizedCompareWithAddr, decisions, NO_MATCHES, tr);
    const after = serializeGedcom(records);
    const diff = lineDiff(before, after);
    // Only the new ADDR line should be added; the existing PLAC must stay unchanged.
    expect(diff.added).toEqual(["2 ADDR Kidričeva 5"]);
    expect(diff.removed).toEqual([]);
  });
});

describe("mergeDecisions — family structure (driven by the confirmed spouse)", () => {
  // Main has the people but the family @F1@ only links the husband.
  const main = dataset(
    wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @F1@\n" +
        "0 @I2@ INDI\n1 NAME Marija /Kos/\n1 SEX F\n" +
        "0 @I3@ INDI\n1 NAME Ana /Novak/\n1 SEX F\n" +
        "0 @F1@ FAM\n1 HUSB @I1@\n1 MARR\n2 DATE 1900\n",
    ),
  );
  // Incoming family adds the wife, the existing child, and a brand-new child.
  const compare = dataset(
    wrap(
      "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @G1@\n" +
        "0 @P2@ INDI\n1 NAME Marija /Kos/\n1 SEX F\n1 FAMS @G1@\n" +
        "0 @P3@ INDI\n1 NAME Ana /Novak/\n1 SEX F\n1 FAMC @G1@\n" +
        "0 @P4@ INDI\n1 NAME Tone /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1925\n1 FAMC @G1@\n" +
        "0 @G1@ FAM\n1 HUSB @P1@\n1 WIFE @P2@\n1 CHIL @P3@\n1 CHIL @P4@\n",
    ),
  );
  const matches = {
    individuals: [
      { mainId: "@I1@", compareId: "@P1@" },
      { mainId: "@I2@", compareId: "@P2@" },
      { mainId: "@I3@", compareId: "@P3@" },
    ],
  } as never;

  // Confirming the husband stitches in the spouse/marriage; children are opt-in,
  // so the matched child and the brand-new one are taken explicitly by id.
  const decisions = new Map<string, CandidateDecision>([
    [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: {}, takenChildren: ["@P3@", "@P4@"] }],
  ]);

  const { records, report } = mergeDecisions(main, compare, decisions, matches, tr);
  const out = serializeGedcom(records);

  it("links the missing spouse to the existing main person", () => {
    expect(out).toContain("0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@");
    expect(out).toContain("0 @I2@ INDI\n1 NAME Marija /Kos/\n1 SEX F\n1 FAMS @F1@");
  });

  it("links an existing matched child without duplicating the person", () => {
    expect(out).toContain("1 CHIL @I3@");
    expect(out).toContain("0 @I3@ INDI\n1 NAME Ana /Novak/\n1 SEX F\n1 FAMC @F1@");
    // @I3@ appears once as a record (not duplicated).
    expect(out.match(/0 @I3@ INDI/g)).toHaveLength(1);
  });

  it("adds a brand-new child as a fresh record with a back-pointer", () => {
    expect(out).toContain("0 @I4@ INDI\n1 NAME Tone /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1925\n1 FAMC @F1@");
    expect(out).toContain("1 CHIL @I4@");
    expect(report.changes.some((c) => c.newRecord && c.to === "Tone Novak")).toBe(true);
  });

  it("keeps unrelated records and the trailer intact", () => {
    expect(out.trimEnd().endsWith("0 TRLR")).toBe(true);
  });

  it("takes only the children whose ids are listed, leaving the rest out", () => {
    // Only the brand-new child is opted in; the matched existing child isn't.
    const partial = new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: {}, takenChildren: ["@P4@"] }],
    ]);
    const { records: recs } = mergeDecisions(main, compare, partial, matches, tr);
    const text = serializeGedcom(recs);
    expect(text).toContain("1 CHIL @I4@"); // Tone (@P4@) taken
    expect(text).not.toContain("1 CHIL @I3@"); // Ana (@P3@) left out
  });

  it("stitches in no children by default (children are opt-in)", () => {
    const noKids = new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: {} }],
    ]);
    const { records: recs } = mergeDecisions(main, compare, noKids, matches, tr);
    const text = serializeGedcom(recs);
    // The spouse is still linked, but neither child is added to the family.
    expect(text).toContain("1 WIFE @I2@");
    expect(text).not.toContain("1 CHIL");
  });
});

describe("mergeDecisions — an explicitly taken child outranks a suggested match", () => {
  // Main's family already has a son Matija born 1829; the incoming family has a
  // son of the same name born (and died) in 1826. The matcher suggested the two
  // are one person, but the review — which aligns children by name and birth
  // year — showed the incoming one as an addition, and the user took it.
  const main = dataset(
    wrap(
      "0 @I1@ INDI\n1 NAME Matija /Slobodnik/\n1 SEX M\n1 FAMS @F1@\n" +
        "0 @I2@ INDI\n1 NAME Ana /Cernetic/\n1 SEX F\n1 FAMS @F1@\n" +
        "0 @I3@ INDI\n1 NAME Matija /Slobodnik/\n1 SEX M\n1 BIRT\n2 DATE 1829\n1 FAMC @F1@\n" +
        "0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n1 CHIL @I3@\n",
    ),
  );
  const compare = dataset(
    wrap(
      "0 @P1@ INDI\n1 NAME Matija /Slobodnik/\n1 SEX M\n1 FAMS @G1@\n" +
        "0 @P2@ INDI\n1 NAME Ana /Cernetic/\n1 SEX F\n1 FAMS @G1@\n" +
        "0 @P4@ INDI\n1 NAME Matija /Slobodnik/\n1 SEX M\n1 BIRT\n2 DATE 1826\n1 DEAT\n2 DATE 1826\n1 FAMC @G1@\n" +
        "0 @G1@ FAM\n1 HUSB @P1@\n1 WIFE @P2@\n1 CHIL @P4@\n",
    ),
  );
  const matches = {
    individuals: [
      { mainId: "@I1@", compareId: "@P1@" },
      { mainId: "@I2@", compareId: "@P2@" },
      { mainId: "@I3@", compareId: "@P4@" }, // suggested, never confirmed
    ],
  } as never;
  const decisions = new Map<string, CandidateDecision>([
    [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: {}, takenChildren: ["@P4@"] }],
  ]);
  const { records, report } = mergeDecisions(main, compare, decisions, matches, tr);
  const out = serializeGedcom(records);

  it("imports the taken child as a person of its own instead of dropping the pick", () => {
    expect(report.newPersons).toBe(1);
    expect(out).toMatch(/0 @I\d+@ INDI\n1 NAME Matija \/Slobodnik\/\n1 SEX M\n1 BIRT\n2 DATE 1826\n1 DEAT\n2 DATE 1826\n1 FAMC @F1@/);
    expect(out).toContain("1 CHIL @I3@\n1 CHIL @I4@");
  });

  it("leaves the suggested main child untouched", () => {
    expect(out).toContain("0 @I3@ INDI\n1 NAME Matija /Slobodnik/\n1 SEX M\n1 BIRT\n2 DATE 1829\n1 FAMC @F1@");
  });

  it("keeps the incoming record so the preview can show the new person's facts", () => {
    const added = Object.entries(report.newIndividuals ?? {});
    expect(added).toHaveLength(1);
    expect(added[0][1].id).toBe("@P4@");
    expect(added[0][1].events.map((e) => e.tag)).toEqual(["BIRT", "DEAT"]);
  });

  it("says so when a taken child is a record the main file already had", () => {
    // Same suggestion, but this time the matched person isn't in the family:
    // reusing it is right (no duplicate), and the report labels it as a link.
    const mainElsewhere = dataset(
      wrap(
        "0 @I1@ INDI\n1 NAME Matija /Slobodnik/\n1 SEX M\n1 FAMS @F1@\n" +
          "0 @I2@ INDI\n1 NAME Ana /Cernetic/\n1 SEX F\n1 FAMS @F1@\n" +
          "0 @I3@ INDI\n1 NAME Matija /Slobodnik/\n1 SEX M\n1 BIRT\n2 DATE 1826\n" +
          "0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n",
      ),
    );
    const { records: recs, report: rep } = mergeDecisions(mainElsewhere, compare, decisions, matches, tr);
    expect(rep.newPersons).toBe(0);
    expect(serializeGedcom(recs)).toContain("1 CHIL @I3@");
    expect(rep.changes.some((c) => c.field === "merge.field.childLinked")).toBe(true);
  });
});

describe("mergeDecisions — second partner becomes its own family", () => {
  // Main: Janez (@I1@) is already married to Marija (@I2@) in @F1@. Ana (@I3@)
  // exists but is single. The incoming file marries the same Janez to Ana.
  const main = dataset(
    wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @F1@\n" +
        "0 @I2@ INDI\n1 NAME Marija /Kos/\n1 SEX F\n1 FAMS @F1@\n" +
        "0 @I3@ INDI\n1 NAME Ana /Hribar/\n1 SEX F\n" +
        "0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n",
    ),
  );
  const compare = dataset(
    wrap(
      "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @G1@\n" +
        "0 @P5@ INDI\n1 NAME Ana /Hribar/\n1 SEX F\n1 FAMS @G1@\n" +
        "0 @G1@ FAM\n1 HUSB @P1@\n1 WIFE @P5@\n",
    ),
  );

  it("creates a new family for a confirmed second partner instead of colliding", () => {
    // Ana is a confirmed match to the existing single @I3@, so the incoming
    // marriage is a genuine second union for Janez.
    const matches = {
      individuals: [
        { mainId: "@I1@", compareId: "@P1@" },
        { mainId: "@I3@", compareId: "@P5@" },
      ],
    } as never;
    const decisions = new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: {} }],
    ]);
    const { records, report } = mergeDecisions(main, compare, decisions, matches, tr);
    const out = serializeGedcom(records);

    // Janez's first marriage is untouched...
    expect(out).toContain("0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@");
    // ...and the second union pairs Janez with Ana in a brand-new family.
    expect(out).toMatch(/0 @F\d+@ FAM\n1 HUSB @I1@\n1 WIFE @I3@/);
    expect(report.newFamilies).toBe(1);
    // No "different spouse" conflict was raised.
    expect(report.deferred).toHaveLength(0);
  });

  it("joins the second marriage main already records, rather than adding another", () => {
    // Main knows both wives and both marriages. The incoming union names the
    // second wife, so it pairs with *her* family — the first marriage is never
    // a candidate, and nothing new is created.
    const bothUnions = dataset(
      wrap(
        "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @F1@\n1 FAMS @F2@\n" +
          "0 @I2@ INDI\n1 NAME Marija /Kos/\n1 SEX F\n1 FAMS @F1@\n" +
          "0 @I3@ INDI\n1 NAME Ana /Hribar/\n1 SEX F\n1 FAMS @F2@\n" +
          "0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n" +
          "0 @F2@ FAM\n1 HUSB @I1@\n1 WIFE @I3@\n",
      ),
    );
    const withPlace = dataset(
      wrap(
        "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @G1@\n" +
          "0 @P5@ INDI\n1 NAME Ana /Hribar/\n1 SEX F\n1 FAMS @G1@\n" +
          "0 @G1@ FAM\n1 HUSB @P1@\n1 WIFE @P5@\n1 MARR\n2 PLAC Kranj\n",
      ),
    );
    const matches = {
      individuals: [
        { mainId: "@I1@", compareId: "@P1@" },
        { mainId: "@I3@", compareId: "@P5@" },
      ],
    } as never;
    const decisions = new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: { "fam.@G1@.MARR.place": "incoming" } }],
    ]);
    const { records, report } = mergeDecisions(bothUnions, withPlace, decisions, matches, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("0 @F2@ FAM\n1 HUSB @I1@\n1 WIFE @I3@\n1 MARR\n2 PLAC Kranj");
    expect(out).toContain("0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n");
    expect(report.newFamilies).toBe(0);
    expect(report.newPersons).toBe(0);
  });

  it("reuses a second wife main already has as a person, without duplicating her", () => {
    // Ana is in main but married to nobody. The matcher pairs the two Anas
    // (it does so readily — same name is enough), so she is linked into the
    // new family rather than imported a second time.
    const matches = {
      individuals: [
        { mainId: "@I1@", compareId: "@P1@" },
        { mainId: "@I3@", compareId: "@P5@" },
      ],
    } as never;
    const decisions = new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: {} }],
    ]);
    const { records, report } = mergeDecisions(main, compare, decisions, matches, tr);
    expect(serializeGedcom(records)).toMatch(/0 @F\d+@ FAM\n1 HUSB @I1@\n1 WIFE @I3@/);
    expect(report.newPersons).toBe(0);
    expect(report.newFamilies).toBe(1);
  });

  it("gives an unmatched second partner their own family too", () => {
    // Ana is NOT matched to anyone in main. She is still plainly not Marija, so
    // the review put her union in a family of its own and the user ticked her
    // there: she joins as a new person in a new family. (Collapsing her into
    // Marija's marriage instead only ever produced a "different spouse"
    // deferral — the tick doing nothing at all.)
    const matches = { individuals: [{ mainId: "@I1@", compareId: "@P1@" }] } as never;
    const decisions = new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: {} }],
    ]);
    const { records, report } = mergeDecisions(main, compare, decisions, matches, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@");
    expect(out).toMatch(/0 @F\d+@ FAM\n1 HUSB @I1@\n1 WIFE @I\d+@/);
    expect(report.newFamilies).toBe(1);
    expect(report.deferred).toHaveLength(0);
  });

  it("defers when a union paired by its children names a different partner", () => {
    // The two unions share their child, so they are the same marriage however
    // the mother is written — but here the incoming mother is matched to a main
    // person other than the one in the WIFE slot. That is a real conflict, and
    // it is still reported rather than overwritten.
    const withChild = dataset(
      wrap(
        "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @F1@\n" +
          "0 @I2@ INDI\n1 NAME Marija /Kos/\n1 SEX F\n1 FAMS @F1@\n" +
          "0 @I3@ INDI\n1 NAME Ana /Hribar/\n1 SEX F\n" +
          "0 @I4@ INDI\n1 NAME Ota /Novak/\n1 SEX F\n1 BIRT\n2 DATE 1880\n1 FAMC @F1@\n" +
          "0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n1 CHIL @I4@\n",
      ),
    );
    const rival = dataset(
      wrap(
        "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @G1@\n" +
          "0 @P5@ INDI\n1 NAME Ana /Hribar/\n1 SEX F\n1 FAMS @G1@\n" +
          "0 @P6@ INDI\n1 NAME Ota /Novak/\n1 SEX F\n1 BIRT\n2 DATE 1880\n1 FAMC @G1@\n" +
          "0 @G1@ FAM\n1 HUSB @P1@\n1 WIFE @P5@\n1 CHIL @P6@\n",
      ),
    );
    const matches = {
      individuals: [
        { mainId: "@I1@", compareId: "@P1@" },
        { mainId: "@I3@", compareId: "@P5@" },
      ],
    } as never;
    const decisions = new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: { "fam.@G1@.partner": "incoming" } }],
    ]);
    const { report } = mergeDecisions(withChild, rival, decisions, matches, tr);
    expect(report.deferred.some((d) => d.reason === "merge.reason.mainHasSpouse")).toBe(true);
  });
});

describe("mergeDecisions — import whole subtrees from the compare tree", () => {
  const NO_DECISIONS = new Map<string, CandidateDecision>();

  it("grafts a person's descendants (spouse, child, and the child's own family) recursively", () => {
    // Main has only the anchor; everything below comes from the incoming file.
    const main = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n"));
    const compare = dataset(
      wrap(
        "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @G1@\n" +
          "0 @P2@ INDI\n1 NAME Marija /Kos/\n1 SEX F\n1 FAMS @G1@\n" +
          "0 @P3@ INDI\n1 NAME Tone /Novak/\n1 SEX M\n1 FAMC @G1@\n1 FAMS @G2@\n" +
          "0 @P4@ INDI\n1 NAME Ema /Hribar/\n1 SEX F\n1 FAMS @G2@\n" +
          "0 @P5@ INDI\n1 NAME Mojca /Novak/\n1 SEX F\n1 FAMC @G2@\n" +
          "0 @G1@ FAM\n1 HUSB @P1@\n1 WIFE @P2@\n1 CHIL @P3@\n" +
          "0 @G2@ FAM\n1 HUSB @P3@\n1 WIFE @P4@\n1 CHIL @P5@\n",
      ),
    );
    const matches = { individuals: [{ mainId: "@I1@", compareId: "@P1@" }] } as never;

    const { records, report } = mergeDecisions(main, compare, NO_DECISIONS, matches, tr, [
      { incomingId: "@P1@", direction: "descendants" },
    ]);
    const out = serializeGedcom(records);

    // Spouse + child of the anchor's union, and the grandchild two hops down.
    expect(out).toContain("Marija /Kos/");
    expect(out).toContain("Tone /Novak/");
    expect(out).toContain("Ema /Hribar/");
    expect(out).toContain("Mojca /Novak/"); // proves the recursion went a second generation deep
    expect(report.newPersons).toBe(4);
    // The anchor is now wired into a family (spouse + child) without being duplicated.
    expect(out.match(/0 @I1@ INDI/g)).toHaveLength(1);
    expect(out).toMatch(/0 @I1@ INDI[\s\S]*1 FAMS/);
  });

  it("grafts a person's ancestors and reuses a matched ancestor as a join point", () => {
    // Main already has the anchor and a father that matches an incoming person.
    const main = dataset(
      wrap(
        "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n" +
          "0 @I2@ INDI\n1 NAME Oce /Novak/\n1 SEX M\n",
      ),
    );
    const compare = dataset(
      wrap(
        "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMC @G1@\n" +
          "0 @P2@ INDI\n1 NAME Oce /Novak/\n1 SEX M\n1 FAMS @G1@\n1 FAMC @G2@\n" +
          "0 @P3@ INDI\n1 NAME Mati /Kos/\n1 SEX F\n1 FAMS @G1@\n" +
          "0 @P4@ INDI\n1 NAME Ded /Novak/\n1 SEX M\n1 FAMS @G2@\n" +
          "0 @G1@ FAM\n1 HUSB @P2@\n1 WIFE @P3@\n1 CHIL @P1@\n" +
          "0 @G2@ FAM\n1 HUSB @P4@\n1 CHIL @P2@\n",
      ),
    );
    // Both the anchor and the father are matched to existing main people.
    const matches = {
      individuals: [
        { mainId: "@I1@", compareId: "@P1@" },
        { mainId: "@I2@", compareId: "@P2@" },
      ],
    } as never;

    const { records, report } = mergeDecisions(main, compare, NO_DECISIONS, matches, tr, [
      { incomingId: "@P1@", direction: "ancestors" },
    ]);
    const out = serializeGedcom(records);

    // The matched father is reused (not duplicated); mother and grandfather are new.
    expect(out.match(/0 @I2@ INDI/g)).toHaveLength(1);
    expect(out).not.toMatch(/Oce \/Novak\/[\s\S]*Oce \/Novak\//); // father appears once
    expect(out).toContain("Mati /Kos/");
    expect(out).toContain("Ded /Novak/"); // grandfather, one hop above the matched father
    expect(report.newPersons).toBe(2); // mother + grandfather only
    // The anchor sits in a child family with the matched father as husband.
    expect(out).toMatch(/0 @I1@ INDI[\s\S]*1 FAMC/);
    expect(out).toContain("1 HUSB @I2@");
    // Who fills a family's spouse slot is flagged, so the preview can leave it
    // off a new family's card — the header already names both spouses there.
    expect(report.changes.filter((c) => c.spouseSlot).map((c) => c.to)).toEqual([
      "Oce Novak",
      "Ded Novak", // the grandfather fills the father's own child family
      "Mati Kos",
    ]);
  });

  it("stops the ancestor walk where the main file already records a different parent", () => {
    // Main knows the anchor's father (Stari Novak) and mother. The incoming file
    // names a *different*, unmatched couple as his parents — and hangs three more
    // generations off them. Grafting those in would drop a whole rival lineage
    // into the file connected to nothing, so the walk stops at the disagreement.
    const main = dataset(
      wrap(
        "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMC @F1@\n" +
          "0 @I2@ INDI\n1 NAME Stari /Novak/\n1 SEX M\n1 FAMS @F1@\n" +
          "0 @I3@ INDI\n1 NAME Stara /Novak/\n1 SEX F\n1 FAMS @F1@\n" +
          "0 @F1@ FAM\n1 HUSB @I2@\n1 WIFE @I3@\n1 CHIL @I1@\n",
      ),
    );
    const compare = dataset(
      wrap(
        "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMC @G1@\n" +
          "0 @P2@ INDI\n1 NAME Tujec /Kovac/\n1 SEX M\n1 FAMS @G1@\n1 FAMC @G2@\n" +
          "0 @P3@ INDI\n1 NAME Tujka /Zupan/\n1 SEX F\n1 FAMS @G1@\n" +
          "0 @P4@ INDI\n1 NAME Praded /Kovac/\n1 SEX M\n1 FAMS @G2@\n" +
          "0 @G1@ FAM\n1 HUSB @P2@\n1 WIFE @P3@\n1 CHIL @P1@\n" +
          "0 @G2@ FAM\n1 HUSB @P4@\n1 CHIL @P2@\n",
      ),
    );
    const matches = { individuals: [{ mainId: "@I1@", compareId: "@P1@" }] } as never;

    const { records, report } = mergeDecisions(main, compare, NO_DECISIONS, matches, tr, [
      { incomingId: "@P1@", direction: "ancestors" },
    ]);
    const out = serializeGedcom(records);

    // Neither the rival parents nor the generation above them come in.
    expect(report.newPersons).toBe(0);
    expect(out).not.toContain("Tujec /Kovac/");
    expect(out).not.toContain("Tujka /Zupan/");
    expect(out).not.toContain("Praded /Kovac/");
    // The main file's own parents are untouched.
    expect(serializeGedcom(records)).toBe(serializeGedcom(main.records));
    // Both slots are reported, and the father — who has a lineage above him —
    // says so, while the mother (a leaf on the incoming side) does not.
    expect(report.deferred.map((d) => [d.recordId, d.field, d.reason])).toEqual([
      ["@F1@", "merge.field.father", "merge.reason.parentKeptAncestors"],
      ["@F1@", "merge.field.mother", "merge.reason.parentKept"],
    ]);
    // The family is named in the preview rather than shown as a bare xref.
    expect(report.recordLabels["@F1@"]).toBe("Stari Novak + Stara Novak");
  });

  it("does nothing when there are no import requests", () => {
    const main = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n"));
    const compare = dataset(wrap("0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n"));
    const matches = { individuals: [{ mainId: "@I1@", compareId: "@P1@" }] } as never;
    const { records, report } = mergeDecisions(main, compare, NO_DECISIONS, matches, tr, []);
    expect(report.newPersons).toBe(0);
    expect(serializeGedcom(records)).toBe(serializeGedcom(main.records));
  });
});

describe("mergeDecisions — family touched via both confirmed spouses", () => {
  // Both spouses already exist in main and are independently confirmed as
  // matches to the incoming pair, so the shared family is visited twice (once
  // per spouse) while stitching in their marriage facts.
  const main = dataset(
    wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @F1@\n" +
        "0 @I2@ INDI\n1 NAME Marija /Kos/\n1 SEX F\n1 FAMS @F1@\n" +
        "0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n1 MARR\n2 DATE 1900\n",
    ),
  );
  const compare = dataset(
    wrap(
      "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @G1@\n" +
        "0 @P2@ INDI\n1 NAME Marija /Kos/\n1 SEX F\n1 FAMS @G1@\n" +
        "0 @G1@ FAM\n1 HUSB @P1@\n1 WIFE @P2@\n1 MARR\n2 DATE 1900\n2 NOTE Civil ceremony\n",
    ),
  );
  const matches = {
    individuals: [
      { mainId: "@I1@", compareId: "@P1@" },
      { mainId: "@I2@", compareId: "@P2@" },
    ],
  } as never;

  // Confirm both spouses, each choosing "both" for the marriage note — an
  // append-style choice, so applying it twice would duplicate the NOTE line.
  const decisions = new Map<string, CandidateDecision>([
    [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: { "fam.@G1@.MARR.note": "both" } }],
    [decisionKey("individual", "@I2@", "@P2@"), { status: "confirmed", fields: { "fam.@G1@.MARR.note": "both" } }],
  ]);

  const { records, report } = mergeDecisions(main, compare, decisions, matches, tr);
  const out = serializeGedcom(records);

  it("applies the append-style marriage note only once, not per spouse", () => {
    expect(out.match(/2 NOTE Civil ceremony/g)).toHaveLength(1);
  });

  it("labels the family husband + wife, in that order", () => {
    expect(report.recordLabels["@F1@"]).toBe("Janez Novak + Marija Kos");
    expect(report.familySpouses["@F1@"]).toEqual([
      { id: "@I1@", name: "Janez Novak" },
      { id: "@I2@", name: "Marija Kos" },
    ]);
  });
});

describe("mergeDecisions — the freshest family-row choice wins across spouses", () => {
  // Both spouses' cards show the same fam.* rows; the merge collects them all
  // and, on disagreement, honours the decision that iterates LAST — which the
  // app keeps meaning "updated most recently" via withFreshDecision. This
  // pins the contract from the engine's side.
  const mainFor = () => dataset(
    wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @F1@\n" +
        "0 @I2@ INDI\n1 NAME Marija /Kos/\n1 SEX F\n1 FAMS @F1@\n" +
        "0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n1 MARR\n2 DATE 1900\n",
    ),
  );
  const compare = dataset(
    wrap(
      "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @G1@\n" +
        "0 @P2@ INDI\n1 NAME Marija /Kos/\n1 SEX F\n1 FAMS @G1@\n" +
        "0 @G1@ FAM\n1 HUSB @P1@\n1 WIFE @P2@\n1 MARR\n2 DATE 1901\n",
    ),
  );
  const matches = {
    individuals: [
      { mainId: "@I1@", compareId: "@P1@" },
      { mainId: "@I2@", compareId: "@P2@" },
    ],
  } as never;
  const husband = decisionKey("individual", "@I1@", "@P1@");
  const wife = decisionKey("individual", "@I2@", "@P2@");
  const confirmedWith = (date: "main" | "incoming"): CandidateDecision =>
    ({ status: "confirmed", fields: { "fam.@G1@.MARR.date": date } });

  it("the later-iterating decision's pick applies", () => {
    const wifeLast = new Map([[husband, confirmedWith("main")], [wife, confirmedWith("incoming")]]);
    expect(serializeGedcom(mergeDecisions(mainFor(), compare, wifeLast, matches, tr).records)).toContain("2 DATE 1901");
    const husbandLast = new Map([[wife, confirmedWith("incoming")], [husband, confirmedWith("main")]]);
    expect(serializeGedcom(mergeDecisions(mainFor(), compare, husbandLast, matches, tr).records)).toContain("2 DATE 1900");
  });
});

describe("mergeDecisions — a conflicting parent choice defers instead of applying", () => {
  // Both files name a father, and they disagree. The merge never replaces a
  // linked parent: an explicit "incoming" on the father row must change
  // nothing and surface in the report — which is why the review panel offers
  // only "main" on such rows.
  const main = dataset(
    wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMC @F1@\n" +
        "0 @I5@ INDI\n1 NAME Stari /Novak/\n1 SEX M\n1 FAMS @F1@\n" +
        "0 @F1@ FAM\n1 HUSB @I5@\n1 CHIL @I1@\n",
    ),
  );
  const compare = dataset(
    wrap(
      "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMC @PF@\n" +
        "0 @P5@ INDI\n1 NAME Drugi /Oce/\n1 SEX M\n1 FAMS @PF@\n" +
        "0 @PF@ FAM\n1 HUSB @P5@\n1 CHIL @P1@\n",
    ),
  );

  it("keeps the main's father, imports nothing, and reports the disagreement", () => {
    const decisions = new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: { father: "incoming" } }],
    ]);
    const { records, report } = mergeDecisions(main, compare, decisions, NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("0 @F1@ FAM\n1 HUSB @I5@");
    // The refused link used to still import the incoming father — a
    // disconnected record nobody chose to add.
    expect(out).not.toContain("Drugi /Oce/");
    expect(report.deferred.some((d) => d.reason === "merge.reason.mainHasSpouse")).toBe(true);
  });
});

describe("mergeDecisions — family custom EVEN", () => {
  const main = dataset(
    wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @F1@\n" +
        "0 @I2@ INDI\n1 NAME Marija /Kos/\n1 SEX F\n1 FAMS @F1@\n" +
        "0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n1 MARR\n2 DATE 1900\n",
    ),
  );
  const compare = dataset(
    wrap(
      "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @G1@\n" +
        "0 @P2@ INDI\n1 NAME Marija /Kos/\n1 SEX F\n1 FAMS @G1@\n" +
        "0 @G1@ FAM\n1 HUSB @P1@\n1 WIFE @P2@\n1 MARR\n2 DATE 1900\n" +
        "1 EVEN\n2 TYPE Civil Partnership\n2 DATE 18 APR 1998\n2 PLAC Preddvor\n",
    ),
  );
  const matches = { individuals: [{ mainId: "@I1@", compareId: "@P1@" }] } as never;

  it("stitches the incoming EVEN onto the main family, even with no MARR/spouse choice", () => {
    const decisions = new Map<string, CandidateDecision>([
      [
        decisionKey("individual", "@I1@", "@P1@"),
        {
          status: "confirmed",
          fields: {
            "fam.@G1@.EVEN.type": "incoming",
            "fam.@G1@.EVEN.date": "incoming",
            "fam.@G1@.EVEN.place": "incoming",
          },
        },
      ],
    ]);
    const { records, report } = mergeDecisions(main, compare, decisions, matches, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("1 EVEN\n2 TYPE Civil Partnership\n2 DATE 18 APR 1998\n2 PLAC Preddvor");
    // The change report names the event by its TYPE, like the review does.
    expect(report.changes.some((c) => c.group === "Civil Partnership" || c.field.includes("Civil Partnership"))).toBe(true);
  });
});

describe("mergeDecisions — individual relations (parents & partners)", () => {
  // Main has the people but @I1@ has no parents and no spouse linked.
  const main = dataset(
    wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n" +
        "0 @I2@ INDI\n1 NAME Jakob /Novak/\n1 SEX M\n" +
        "0 @I3@ INDI\n1 NAME Neza /Kos/\n1 SEX F\n",
    ),
  );
  // Incoming has @I1@'s father, mother, and a (new) wife via families.
  const compare = dataset(
    wrap(
      "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMC @PF@\n1 FAMS @PM@\n" +
        "0 @P2@ INDI\n1 NAME Jakob /Novak/\n1 SEX M\n1 FAMS @PF@\n" +
        "0 @P3@ INDI\n1 NAME Neza /Kos/\n1 SEX F\n1 FAMS @PF@\n" +
        "0 @P4@ INDI\n1 NAME Ana /Horvat/\n1 SEX F\n1 FAMS @PM@\n" +
        "0 @PF@ FAM\n1 HUSB @P2@\n1 WIFE @P3@\n1 CHIL @P1@\n" +
        "0 @PM@ FAM\n1 HUSB @P1@\n1 WIFE @P4@\n",
    ),
  );
  const matches = {
    individuals: [
      { mainId: "@I1@", compareId: "@P1@" },
      { mainId: "@I2@", compareId: "@P2@" },
      { mainId: "@I3@", compareId: "@P3@" },
    ],
    families: [],
  } as never;

  const decisions = new Map<string, CandidateDecision>([
    [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: {} }],
  ]);

  const { records } = mergeDecisions(main, compare, decisions, matches, tr);
  const out = serializeGedcom(records);

  it("creates a child-family linking the matched father and mother", () => {
    // A new FAM with the child and both parents (existing main people).
    expect(out).toMatch(/0 @F\d+@ FAM\n1 HUSB @I2@\n1 WIFE @I3@\n1 CHIL @I1@/);
    expect(out).toContain("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMC @");
    expect(out).toContain("0 @I2@ INDI\n1 NAME Jakob /Novak/\n1 SEX M\n1 FAMS @");
  });

  it("adds a new partner as a couple family with a new person record", () => {
    expect(out).toContain("0 @I4@ INDI\n1 NAME Ana /Horvat/"); // new spouse added
    // A couple family pairing @I1@ (husband) with the new wife @I4@.
    expect(out).toMatch(/0 @F\d+@ FAM\n1 HUSB @I1@\n1 WIFE @I4@/);
  });

  it("imports a rejected-match parent as a new record instead of reusing the wrong main person", () => {
    // The mother candidate @I3@/@P3@ is a false positive the user rejected; the
    // father @I2@/@P2@ stays a confirmed-as-plausible match.
    const rejectMother = new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: {} }],
      [decisionKey("individual", "@I3@", "@P3@"), { status: "rejected", fields: {} }],
    ]);
    const { records: recs } = mergeDecisions(main, compare, rejectMother, matches, tr);
    const rejected = serializeGedcom(recs);
    // Father is still the existing @I2@; mother is a freshly added record (@I4@),
    // not the rejected @I3@.
    expect(rejected).toMatch(/0 @F\d+@ FAM\n1 HUSB @I2@\n1 WIFE @I4@\n1 CHIL @I1@/);
    expect(rejected).toContain("0 @I4@ INDI\n1 NAME Neza /Kos/");
    expect(rejected).not.toMatch(/1 WIFE @I3@/);
  });
});

describe("mergeDecisions — links", () => {
  it("adds a new incoming link the main lacks", () => {
    const main = dataset(MAIN);
    const compare = dataset(
      wrap("0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 WWW https://example.com/new\n"),
    );
    const { records, report } = mergeDecisions(main, compare, confirmed(), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("1 WWW https://example.com/new");
    expect(report.changes.some((c) => c.links?.includes("https://example.com/new"))).toBe(true);
  });

  it("doesn't duplicate a link the main already has (even with a trailing slash)", () => {
    const main = dataset(
      wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 WWW https://example.com/old/\n"),
    );
    const compare = dataset(
      wrap("0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 WWW https://example.com/old\n"),
    );
    const { records, report } = mergeDecisions(main, compare, confirmed(), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out.match(/WWW/g)).toHaveLength(1);
    expect(report.changes).toHaveLength(0);
  });

  it("adds a new incoming link as a _WEBTAG block when the main uses that format", () => {
    const main = dataset(
      wrap(
        "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n" +
          "1 _WEBTAG\n2 NAME rojstvo\n2 URL https://data.matricula-online.eu/sl/slovenia/ljubljana/kranj/01/\n",
      ),
    );
    const compare = dataset(
      wrap("0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 WWW https://example.com/new\n"),
    );
    const { records, report } = mergeDecisions(main, compare, confirmed({ links: "both" }), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("1 _WEBTAG\n2 URL https://example.com/new");
    expect(out).not.toMatch(/^1 WWW/m);
    const change = report.changes.find((c) => c.links?.includes("https://example.com/new"));
    expect(change).toBeDefined();
    // Explicitly chosen "both" (kept alongside main's link) isn't a plain
    // incoming copy, so it should keep the normal "added" preview color.
    expect(change!.unedited).toBeFalsy();
  });

  it("adds a new incoming link as an OBJE/FILE record when the main uses that format", () => {
    const main = dataset(
      wrap(
        "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 OBJE @O3@\n" +
          "0 @O3@ OBJE\n1 FILE https://data.matricula-online.eu/sl/slovenia/ljubljana/kranj/01/\n1 FORM jpeg\n",
      ),
    );
    const compare = dataset(
      wrap("0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 WWW https://example.com/new\n"),
    );
    const { records, report } = mergeDecisions(main, compare, confirmed({ links: "both" }), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("1 OBJE @O4@");
    expect(out).toContain("0 @O4@ OBJE\n1 FILE https://example.com/new");
    expect(out).not.toMatch(/^1 WWW/m);
    expect(report.changes.some((c) => c.links?.includes("https://example.com/new"))).toBe(true);
  });

  it("adds an incoming record-level SOUR citation the main lacks (and imports the source)", () => {
    const main = dataset(MAIN);
    const compare = dataset(
      wrap(
        "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 SOUR @CS9@\n2 PAGE 12\n" +
          "0 @CS9@ SOUR\n1 TITL Rodbinska kronika\n",
      ),
    );
    const { records, report } = mergeDecisions(main, compare, confirmed(), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("1 SOUR @CS9@\n2 PAGE 12");
    expect(out).toContain("0 @CS9@ SOUR\n1 TITL Rodbinska kronika");
    expect(report.changes.some((c) => c.sources && c.sources.length > 0)).toBe(true);
  });

  it("attaches a same-book incoming link as a SOUR citation instead of a plain link", () => {
    const main = dataset(
      wrap(
        "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n2 SOUR @S1@\n3 PAGE 56\n" +
          "0 @S1@ SOUR\n1 TITL Krstna knjiga - Šenčur\n1 OBJE @O1@\n" +
          "0 @O1@ OBJE\n1 FILE https://data.matricula-online.eu/sl/slovenia/ljubljana/sencur/03173/?pg=56\n",
      ),
    );
    const compare = dataset(
      wrap(
        "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n" +
          "1 WWW https://data.matricula-online.eu/de/slovenia/ljubljana/sencur/03173/?pg=58\n",
      ),
    );
    const { records, report } = mergeDecisions(main, compare, confirmed(), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).not.toMatch(/^1 WWW/m);
    expect(out).toContain("1 SOUR @S1@\n2 PAGE 58");
    expect(out).toContain("1 FILE https://data.matricula-online.eu/de/slovenia/ljubljana/sencur/03173/?pg=58");
    // The new page joins the existing book's SOUR rather than minting a new one.
    expect(out.match(/0 @S\d+@ SOUR/g)).toHaveLength(1);
    expect(report.changes.some((c) => c.links?.some((l) => l.includes("pg=58")))).toBe(true);
  });

});

describe("mergeDecisions — SOUR/REPO import", () => {
  // Compare has a source record and an individual citing it.
  // @P1@ must carry 1 FAMS @PF@ so applyIndividualFamilies processes the family.
  const compareWithSour = wrap(
    "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n1 FAMS @PF@\n" +
      "0 @P4@ INDI\n1 NAME Tone /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1925\n1 SOUR @CS1@\n2 PAGE Birth register p.42\n1 FAMC @PF@\n" +
      "0 @PF@ FAM\n1 HUSB @P1@\n1 CHIL @P4@\n" +
      "0 @CS1@ SOUR\n1 TITL Matična knjiga rojstev Kranj\n1 AUTH Župnija Kranj\n",
  );
  const mainFamily = wrap(
    "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @F1@\n" +
      "0 @F1@ FAM\n1 HUSB @I1@\n",
  );

  it("imports the SOUR record when a new child referencing it is added", () => {
    const main = dataset(mainFamily);
    const compare = dataset(compareWithSour);
    const matches = {
      individuals: [{ mainId: "@I1@", compareId: "@P1@" }],
    } as never;
    const decisions = new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: {}, takenChildren: ["@P4@"] }],
    ]);
    const { records } = mergeDecisions(main, compare, decisions, matches, tr);
    const out = serializeGedcom(records);
    // The new child carries a SOUR citation; the referenced SOUR record must
    // appear in the merged output.
    expect(out).toContain("1 SOUR @CS1@");
    expect(out).toContain("0 @CS1@ SOUR\n1 TITL Matična knjiga rojstev Kranj");
  });

  it("handles an xref collision: imports the compare SOUR under a fresh xref", () => {
    // Main already has @CS1@ pointing to a different source.
    const mainWithClash = wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @F1@\n" +
        "0 @F1@ FAM\n1 HUSB @I1@\n" +
        "0 @CS1@ SOUR\n1 TITL Župnijska matica — Domžale\n",
    );
    const main = dataset(mainWithClash);
    const compare = dataset(compareWithSour);
    const matches = {
      individuals: [{ mainId: "@I1@", compareId: "@P1@" }],
    } as never;
    const decisions = new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: {}, takenChildren: ["@P4@"] }],
    ]);
    const { records } = mergeDecisions(main, compare, decisions, matches, tr);
    const out = serializeGedcom(records);
    // Main's @CS1@ must be preserved unchanged.
    expect(out).toContain("0 @CS1@ SOUR\n1 TITL Župnijska matica — Domžale");
    // Compare's source ("Matična knjiga rojstev Kranj") must also appear, but
    // under a different xref since @CS1@ was already taken.
    expect(out).toContain("1 TITL Matična knjiga rojstev Kranj");
    // The new child's citation must point to the remapped xref (not @CS1@).
    const newChildMatch = out.match(/0 @I\d+@ INDI\n1 NAME Tone \/Novak\//);
    expect(newChildMatch).not.toBeNull();
    // Extract the citation xref from the new child's record.
    const childSection = out.slice(out.indexOf(newChildMatch![0]));
    const sourXref = childSection.match(/1 SOUR (@[^@]+@)/)?.[1];
    expect(sourXref).toBeDefined();
    expect(sourXref).not.toBe("@CS1@"); // must have been remapped
    // That remapped xref must correspond to the compare source.
    expect(out).toContain(`0 ${sourXref} SOUR\n1 TITL Matična knjiga rojstev Kranj`);
  });

  it("reuses an existing main SOUR for a compare source with the same content under a different xref", () => {
    // Main already cites this exact register, just under a different xref.
    const mainWithSameSource = wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @F1@\n" +
        "0 @F1@ FAM\n1 HUSB @I1@\n" +
        "0 @S9@ SOUR\n1 TITL Matična knjiga rojstev Kranj\n1 AUTH Župnija Kranj\n",
    );
    const main = dataset(mainWithSameSource);
    const compare = dataset(compareWithSour); // compare's @CS1@ has the same TITL/AUTH
    const matches = {
      individuals: [{ mainId: "@I1@", compareId: "@P1@" }],
    } as never;
    const decisions = new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: {}, takenChildren: ["@P4@"] }],
    ]);
    const { records } = mergeDecisions(main, compare, decisions, matches, tr);
    const out = serializeGedcom(records);
    // No new SOUR record was minted — the import reused main's existing @S9@.
    expect(out.match(/0 @[^@]+@ SOUR/g)).toHaveLength(1);
    expect(out).toContain("1 SOUR @S9@");
  });

  it("transitively imports a REPO referenced by an imported SOUR", () => {
    const compareWithRepo = wrap(
      "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n1 FAMS @PF@\n" +
        "0 @P4@ INDI\n1 NAME Tone /Novak/\n1 SEX M\n1 SOUR @CS1@\n1 FAMC @PF@\n" +
        "0 @PF@ FAM\n1 HUSB @P1@\n1 CHIL @P4@\n" +
        "0 @CS1@ SOUR\n1 TITL Matična knjiga rojstev Kranj\n1 REPO @CR1@\n" +
        "0 @CR1@ REPO\n1 NAME Nadškofijski arhiv Ljubljana\n",
    );
    const main = dataset(mainFamily);
    const compare = dataset(compareWithRepo);
    const matches = {
      individuals: [{ mainId: "@I1@", compareId: "@P1@" }],
    } as never;
    const decisions = new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: {}, takenChildren: ["@P4@"] }],
    ]);
    const { records } = mergeDecisions(main, compare, decisions, matches, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("0 @CS1@ SOUR\n1 TITL Matična knjiga rojstev Kranj\n1 REPO @CR1@");
    expect(out).toContain("0 @CR1@ REPO\n1 NAME Nadškofijski arhiv Ljubljana");
  });
});

describe("mergeDecisions — custom tag detection", () => {
  it("records a non-standard tag copied in with an imported SOUR record, keyed by tag name", () => {
    const compareWithSour = wrap(
      "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n1 FAMS @PF@\n" +
        "0 @P4@ INDI\n1 NAME Tone /Novak/\n1 SEX M\n1 SOUR @CS1@\n1 FAMC @PF@\n" +
        "0 @PF@ FAM\n1 HUSB @P1@\n1 CHIL @P4@\n" +
        "0 @CS1@ SOUR\n1 TITL Matična knjiga rojstev Kranj\n1 _ITALIC Y\n",
    );
    const mainFamily = wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @F1@\n0 @F1@ FAM\n1 HUSB @I1@\n",
    );
    const main = dataset(mainFamily);
    const compare = dataset(compareWithSour);
    const matches = { individuals: [{ mainId: "@I1@", compareId: "@P1@" }] } as never;
    const decisions = new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: {}, takenChildren: ["@P4@"] }],
    ]);
    const { records, report } = mergeDecisions(main, compare, decisions, matches, tr);
    expect(Object.keys(report.customTags)).toEqual(["_ITALIC"]);
    expect(report.customTags["_ITALIC"]).toHaveLength(1);

    // Simulates the save preview: unchecking "_ITALIC" strips it before download.
    for (const { parent, node } of report.customTags["_ITALIC"]) {
      parent.children = parent.children.filter((c) => c !== node);
    }
    const out = serializeGedcom(records);
    expect(out).toContain("1 TITL Matična knjiga rojstev Kranj");
    expect(out).not.toContain("_ITALIC");
  });

  it("does not flag a custom tag that already existed in the main file", () => {
    // @CS1@ is already present in main (with _ITALIC); the merge only adds
    // a citation pointer to it, so its pre-existing _ITALIC isn't "copied in".
    const mainWithSour = wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n1 SOUR @CS1@\n" +
        "0 @CS1@ SOUR\n1 TITL Matična knjiga rojstev Kranj\n1 _ITALIC Y\n",
    );
    const compareWithBirt = wrap(
      "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n2 PLAC Kranj\n",
    );
    const main = dataset(mainWithSour);
    const compare = dataset(compareWithBirt);
    const matches = { individuals: [{ mainId: "@I1@", compareId: "@P1@" }] } as never;
    const decisions = new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: { "BIRT.place": "incoming" } }],
    ]);
    const { report } = mergeDecisions(main, compare, decisions, matches, tr);
    expect(report.customTags).toEqual({});
  });
});

describe("mergeDecisions — event source citations", () => {
  // Main's BIRT has no citation; incoming's does.
  const mainNoSour = wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n");
  const compareWithSour = wrap(
    "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n2 SOUR Birth register p.42\n",
  );

  it("fills in a missing citation by default", () => {
    const main = dataset(mainNoSour);
    const compare = dataset(compareWithSour);
    const { records } = mergeDecisions(main, compare, confirmed(), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("1 BIRT\n2 DATE 1850\n2 SOUR Birth register p.42");
  });

  it("leaves a conflicting citation on main unless explicitly chosen", () => {
    const mainWithOwnSour = wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n2 SOUR Krstna knjiga\n",
    );
    const main = dataset(mainWithOwnSour);
    const compare = dataset(compareWithSour);
    const { records } = mergeDecisions(main, compare, confirmed(), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("2 SOUR Krstna knjiga");
    expect(out).not.toContain("Birth register p.42");
  });

  it("replaces main's citation when incoming is chosen", () => {
    const mainWithOwnSour = wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n2 SOUR Krstna knjiga\n",
    );
    const main = dataset(mainWithOwnSour);
    const compare = dataset(compareWithSour);
    const { records } = mergeDecisions(main, compare, confirmed({ "BIRT.sources": "incoming" }), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("2 SOUR Birth register p.42");
    expect(out).not.toContain("Krstna knjiga");
  });

  it("keeps both citations when both is chosen", () => {
    const mainWithOwnSour = wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n2 SOUR Krstna knjiga\n",
    );
    const main = dataset(mainWithOwnSour);
    const compare = dataset(compareWithSour);
    const { records } = mergeDecisions(main, compare, confirmed({ "BIRT.sources": "both" }), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("2 SOUR Krstna knjiga");
    expect(out).toContain("2 SOUR Birth register p.42");
  });

  // An event's own plain link (not a SOUR citation) rides along on the same
  // ".sources" row/decision as the citations, shown as an icon next to them.
  const compareWithLink = wrap(
    "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n2 WWW https://example.com/birth\n",
  );

  it("adds a missing event link by default", () => {
    const main = dataset(mainNoSour);
    const compare = dataset(compareWithLink);
    const { records } = mergeDecisions(main, compare, confirmed(), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("1 BIRT\n2 DATE 1850\n2 WWW https://example.com/birth");
  });

  it("leaves main's own event link alone unless explicitly chosen", () => {
    const mainWithOwnLink = wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n2 WWW https://example.com/old\n",
    );
    const main = dataset(mainWithOwnLink);
    const compare = dataset(compareWithLink);
    const { records } = mergeDecisions(main, compare, confirmed(), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("2 WWW https://example.com/old");
    expect(out).not.toContain("https://example.com/birth");
  });

  it("keeps both event links when both is chosen", () => {
    const mainWithOwnLink = wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n2 WWW https://example.com/old\n",
    );
    const main = dataset(mainWithOwnLink);
    const compare = dataset(compareWithLink);
    const { records } = mergeDecisions(main, compare, confirmed({ "BIRT.sources": "both" }), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("2 WWW https://example.com/old");
    expect(out).toContain("2 WWW https://example.com/birth");
  });

  it("doesn't duplicate an incoming event link the main already has", () => {
    const mainWithSameLink = wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n2 WWW https://example.com/birth\n",
    );
    const main = dataset(mainWithSameLink);
    const compare = dataset(compareWithLink);
    const { records } = mergeDecisions(main, compare, confirmed({ "BIRT.sources": "both" }), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out.match(/2 WWW/g)).toHaveLength(1);
  });

  it("attaches a same-book event link as a SOUR citation instead of a plain link (e.g. a marriage record's Matricula link)", () => {
    const main = dataset(
      wrap(
        "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @F1@\n" +
          "0 @F1@ FAM\n1 HUSB @I1@\n1 MARR\n2 DATE 1900\n2 SOUR @S1@\n3 PAGE 56\n" +
          "0 @S1@ SOUR\n1 TITL Poročna knjiga - Šenčur\n1 OBJE @O1@\n" +
          "0 @O1@ OBJE\n1 FILE https://data.matricula-online.eu/sl/slovenia/ljubljana/sencur/03173/?pg=56\n",
      ),
    );
    const compare = dataset(
      wrap(
        "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @G1@\n" +
          "0 @G1@ FAM\n1 HUSB @P1@\n1 MARR\n2 DATE 1900\n" +
          "2 WWW https://data.matricula-online.eu/de/slovenia/ljubljana/sencur/03173/?pg=58\n",
      ),
    );
    const matches = { individuals: [{ mainId: "@I1@", compareId: "@P1@" }] } as never;
    const decisions = new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: { "fam.@G1@.MARR.sources": "both" } }],
    ]);
    const { records } = mergeDecisions(main, compare, decisions, matches, tr);
    const out = serializeGedcom(records);
    expect(out).not.toMatch(/^2 WWW/m);
    expect(out).toContain("2 SOUR @S1@\n3 PAGE 58");
    expect(out).toContain("1 FILE https://data.matricula-online.eu/de/slovenia/ljubljana/sencur/03173/?pg=58");
    expect(out.match(/0 @S\d+@ SOUR/g)).toHaveLength(1);
  });
});

describe("mergeDecisions — multi-instance events pair main/incoming by their own array position", () => {
  // Two RESI events each side, deliberately listed in reversed chronological
  // order on the incoming side so the best-scoring (date+place) pairing is
  // {mainIdx:0,compareIdx:1} and {mainIdx:1,compareIdx:0} — i.e. for at
  // least one pair, mainIdx and compareIdx differ. A row's incoming side
  // must be read from `compareIdx`, not from whatever sequential "keyIdx"
  // happens to label the row, or it ends up reading the *other* incoming event.
  const mainTwoResi = wrap(
    "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n" +
      "1 RESI\n2 DATE 1990\n2 PLAC Kranj\n2 AGNC Agency-Kranj\n" +
      "1 RESI\n2 DATE 2000\n2 PLAC Ljubljana\n2 AGNC Agency-Ljubljana\n",
  );
  const compareTwoResiReversed = wrap(
    "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n" +
      "1 RESI\n2 DATE 2000\n2 PLAC Ljubljana\n2 AGNC Agency-Ljubljana-incoming\n" +
      "1 RESI\n2 DATE 1990\n2 PLAC Kranj\n2 AGNC Agency-Kranj-incoming\n",
  );

  it("applies each pair's own incoming agency, not a value crossed over from the other pair", () => {
    const main = dataset(mainTwoResi);
    const compare = dataset(compareTwoResiReversed);
    const { records } = mergeDecisions(
      main,
      compare,
      confirmed({ "RESI.0.agency": "incoming", "RESI.1.agency": "incoming" }),
      NO_MATCHES,
      tr,
    );
    const out = serializeGedcom(records);
    expect(out).toContain("1 RESI\n2 DATE 1990\n2 PLAC Kranj\n2 AGNC Agency-Kranj-incoming");
    expect(out).toContain("1 RESI\n2 DATE 2000\n2 PLAC Ljubljana\n2 AGNC Agency-Ljubljana-incoming");
  });

  // An incoming-only third RESI (no main counterpart at all) must still get
  // every one of its fields combined onto one new node, not scattered across
  // several — exercising the mainIdx===-1 "create once, reuse" path.
  const compareThreeResi = wrap(
    "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n" +
      "1 RESI\n2 DATE 2000\n2 PLAC Ljubljana\n2 AGNC Agency-Ljubljana-incoming\n" +
      "1 RESI\n2 DATE 1990\n2 PLAC Kranj\n2 AGNC Agency-Kranj-incoming\n" +
      "1 RESI\n2 DATE 1985\n2 PLAC Maribor\n2 ADDR Glavni trg 1\n2 AGNC Agency-Maribor-incoming\n",
  );

  it("combines a brand-new incoming-only event's fields onto a single node", () => {
    const main = dataset(mainTwoResi);
    const compare = dataset(compareThreeResi);
    const { records } = mergeDecisions(main, compare, confirmed(), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("2 PLAC Maribor");
    expect(out).toContain("2 ADDR Glavni trg 1");
    expect(out).toContain("2 AGNC Agency-Maribor-incoming");
    // All three landed on one event, not split across separate ones.
    const maribor = out.split("1 RESI").find((block) => block.includes("Maribor"))!;
    expect(maribor).toContain("Glavni trg 1");
    expect(maribor).toContain("Agency-Maribor-incoming");
    expect(out.match(/1 RESI/g)).toHaveLength(3); // 2 main + 1 new, none duplicated
  });
});

describe("mergeDecisions — preview groups a new event's sub-field changes into one line", () => {
  // Main has no OCCU at all; incoming adds one with both a value and a date.
  // Before the fix, applyRows pushed one FieldChange per sub-field ("Date",
  // "Occupation") under the same group, so the preview showed two lines under
  // one header instead of a single "Occupation: + value · date" line.
  const mainNoOccu = wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n");
  const compareNewOccu = wrap(
    "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 OCCU šivilja v pokoju\n2 DATE 1998\n",
  );

  it("combines the new event's date+value into a single FieldChange row", () => {
    const main = dataset(mainNoOccu);
    const compare = dataset(compareNewOccu);
    const { report } = mergeDecisions(main, compare, confirmed(), NO_MATCHES, tr);
    const occuChanges = report.changes.filter((c) => c.group === "event.OCCU");
    expect(occuChanges).toHaveLength(1);
    expect(occuChanges[0].to).toBe("šivilja v pokoju · 1998");
    // Default-filled from incoming (main had nothing to begin with), not
    // something the user typed or combined — preview should color it as such.
    expect(occuChanges[0].unedited).toBe(true);
  });
});

describe("mergeDecisions — rejectedEvents keeps a deleted main event from being re-added from incoming", () => {
  // Main and incoming both originally had this OCCU (an "agree" pair, so it
  // never showed as a merge suggestion) — then the user deleted main's copy.
  // Without an explicit rejection, the now-unmatched incoming copy looks like
  // ordinary new data and gets filled back in.
  const mainNoOccu = wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n");
  const compareWithOccu = wrap(
    "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n" +
      "1 OCCU VP Technology\n2 DATE FROM 2011 TO 2018\n",
  );

  it("re-adds the incoming event by default (no rejection recorded)", () => {
    const main = dataset(mainNoOccu);
    const compare = dataset(compareWithOccu);
    const { records } = mergeDecisions(main, compare, confirmed(), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("1 OCCU VP Technology");
  });

  it("never re-adds it once the incoming event is recorded as rejected", () => {
    const main = dataset(mainNoOccu);
    const compare = dataset(compareWithOccu);
    const decisions = confirmed();
    decisions.set(decisionKey("individual", "@I1@", "@P1@"), {
      status: "confirmed",
      fields: {},
      rejectedEvents: ["OCCU:0"],
    });
    const { records } = mergeDecisions(main, compare, decisions, NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).not.toContain("OCCU");
  });
});

describe("mergeDecisions — new sub-fields land before trailing CHAN/CREA", () => {
  // Main's RESI already has its own CHAN/CREA audit timestamps, typical of
  // exports from RootsMagic/Family Historian/etc. The incoming side adds an
  // ADDR that main is missing.
  const mainWithAudit = wrap(
    "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n" +
      "1 RESI\n2 DATE 1900\n2 PLAC Kranj\n2 CHAN\n3 DATE 17 NOV 2025\n2 CREA\n3 DATE 09 JUL 2025\n",
  );
  const compareWithAddr = wrap(
    "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 RESI\n2 DATE 1900\n2 PLAC Kranj\n2 ADDR Main St.\n",
  );

  it("inserts a new ADDR before CHAN/CREA, not after", () => {
    const main = dataset(mainWithAudit);
    const compare = dataset(compareWithAddr);
    const { records } = mergeDecisions(main, compare, confirmed(), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("2 PLAC Kranj\n2 ADDR Main St.\n2 CHAN");
    expect(out).not.toContain("2 CREA\n3 DATE 09 JUL 2025\n2 ADDR");
  });

  it("inserts a brand-new NOTE before CHAN/CREA on an event the main already has", () => {
    const main = dataset(mainWithAudit);
    const compare = dataset(
      wrap(
        "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 RESI\n2 DATE 1900\n2 PLAC Kranj\n2 NOTE Family home\n",
      ),
    );
    const { records } = mergeDecisions(main, compare, confirmed(), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("2 NOTE Family home\n2 CHAN");
    expect(out).not.toContain("2 CREA\n3 DATE 09 JUL 2025\n2 NOTE");
  });
});

describe("mergeDecisions — ASSO is not swept into event-date sorting", () => {
  // Main has an ASSO (association to another individual) sitting between
  // BIRT and DEAT, with its own DATE (a validity period, not an event date)
  // that falls outside the BIRT..DEAT range.
  const mainWithAsso = wrap(
    "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n" +
      "1 BIRT\n2 DATE 1850\n" +
      "1 ASSO @I2@\n2 ROLE OTHER\n2 DATE 1979\n" +
      "1 DEAT\n2 DATE 1900\n" +
      "0 @I2@ INDI\n1 NAME Ana /Kos/\n1 SEX F\n",
  );
  const compareFillsBirthPlace = wrap(
    "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n2 PLAC Kranj\n1 DEAT\n2 DATE 1900\n",
  );

  it("leaves the ASSO node in place when another field on the record changes", () => {
    const main = dataset(mainWithAsso);
    const compare = dataset(compareFillsBirthPlace);
    const before = serializeGedcom(main.records);
    const { records } = mergeDecisions(main, compare, confirmed(), NO_MATCHES, tr);
    const after = serializeGedcom(records);

    const diff = lineDiff(before, after);
    expect(diff.added).toEqual(["2 PLAC Kranj"]);
    expect(diff.removed).toEqual([]);
    // ASSO stays between BIRT and DEAT, not pushed past DEAT by date sort.
    expect(after).toContain("1 ASSO @I2@\n2 ROLE OTHER\n2 DATE 1979\n1 DEAT");
  });
});

describe("mergeDecisions — CHAN/CREA are not swept into event-date sorting", () => {
  // Main has trailing top-level CHAN/CREA audit timestamps (last-change/
  // creation dates, typical of MyHeritage/Gramps exports) with CHAN's date
  // later than CREA's. Their DATE children must not make them look like
  // datable events: that would both reorder CHAN/CREA relative to each other
  // (sorted by date) and risk sandwiching a real new event between them.
  const mainWithAudit = wrap(
    "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n" +
      "1 CHAN\n2 DATE 17 NOV 2025\n1 CREA\n2 DATE 09 JUL 2025\n",
  );
  const compareAddsResi = wrap(
    "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n" +
      "1 RESI\n2 DATE 1900\n2 PLAC Kranj\n",
  );

  it("keeps CHAN before CREA and lands the new event before both", () => {
    const main = dataset(mainWithAudit);
    const compare = dataset(compareAddsResi);
    const { records } = mergeDecisions(main, compare, confirmed(), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("1 RESI\n2 DATE 1900\n2 PLAC Kranj\n1 CHAN\n2 DATE 17 NOV 2025\n1 CREA\n2 DATE 09 JUL 2025\n");
  });
});

describe("materializeEventSources", () => {
  // Mirrors Edit mode: a direct field edit on an "extra" incoming-only BAPM
  // row materializes a bare main event node (date/place only, no SOUR yet)
  // — see EditView's `setEventField` call for an "extra" row.
  const compareWithSour = wrap(
    "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n" +
      "1 BAPM\n2 DATE 1850\n2 PLAC Kranj\n2 SOUR @CS1@\n2 PAGE 12\n" +
      "0 @CS1@ SOUR\n1 TITL Matična knjiga krstov Kranj\n",
  );
  const main = wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n");

  it("copies the incoming event's SOUR citation onto the new main event and imports the cited SOUR record", () => {
    const mainDs = dataset(main);
    const compareDs = dataset(compareWithSour);
    const eventNode: GedNode = { level: 1, tag: "BAPM", children: [{ level: 2, tag: "DATE", value: "1850", children: [] }] };
    // Mirrors `setEventField` inserting the new event into the live main record.
    mainDs.records.find((r) => r.xref === "@I1@")!.children.push(eventNode);
    const incomingEvent = compareDs.individuals.get("@P1@")!.raw.children.find((c) => c.tag === "BAPM")!;

    const imported = materializeEventSources(mainDs, compareDs, eventNode, incomingEvent);

    expect(eventNode.children.some((c) => c.tag === "SOUR" && c.value === "@CS1@")).toBe(true);
    expect(mainDs.records.some((r) => r.tag === "SOUR" && r.xref === "@CS1@")).toBe(true);
    expect(imported).toHaveLength(1);
    expect(imported[0].xref).toBe("@CS1@");
  });

  it("remaps the cited SOUR to a fresh xref when it collides with an unrelated main record", () => {
    const mainWithClash = wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n0 @CS1@ SOUR\n1 TITL Unrelated source\n",
    );
    const mainDs = dataset(mainWithClash);
    const compareDs = dataset(compareWithSour);
    const eventNode: GedNode = { level: 1, tag: "BAPM", children: [] };
    mainDs.records.find((r) => r.xref === "@I1@")!.children.push(eventNode);
    const incomingEvent = compareDs.individuals.get("@P1@")!.raw.children.find((c) => c.tag === "BAPM")!;

    const imported = materializeEventSources(mainDs, compareDs, eventNode, incomingEvent);

    const citation = eventNode.children.find((c) => c.tag === "SOUR");
    expect(citation?.value).not.toBe("@CS1@");
    expect(imported).toHaveLength(1);
    expect(imported[0].xref).toBe(citation?.value);
    expect(imported[0].children.some((c) => c.tag === "TITL" && c.value === "Matična knjiga krstov Kranj")).toBe(true);
    // Main's own unrelated @CS1@ stays untouched.
    expect(mainDs.records.find((r) => r.xref === "@CS1@")?.children[0]?.value).toBe("Unrelated source");
  });

  it("returns an empty array and does nothing when the incoming event has no SOUR", () => {
    const mainDs = dataset(main);
    const compareDs = dataset(wrap("0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BAPM\n2 DATE 1850\n"));
    const eventNode: GedNode = { level: 1, tag: "BAPM", children: [] };
    const incomingEvent = compareDs.individuals.get("@P1@")!.raw.children.find((c) => c.tag === "BAPM")!;

    const imported = materializeEventSources(mainDs, compareDs, eventNode, incomingEvent);

    expect(imported).toEqual([]);
    expect(eventNode.children).toEqual([]);
  });
});

describe("mergeDecisions — confirm without changes is a no-op", () => {
  it("does not reorder out-of-canonical-order events when nothing was applied", () => {
    // DEAT before BIRT in the source: a confirmed match that takes no fields
    // must leave the record byte-identical, not silently canonicalize it.
    const text = wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 DEAT\n2 DATE 1910\n1 BIRT\n2 DATE 1850\n",
    );
    const main = dataset(text);
    const compare = dataset(text.replace(/@I1@/g, "@P1@"));
    const { records, report } = mergeDecisions(main, compare, confirmed(), NO_MATCHES, tr);
    expect(report.changes).toHaveLength(0);
    expect(serializeGedcom(records)).toBe(text);
  });
});

describe("mergeDecisions — pointers on a newly added person", () => {
  // Main @I1@ matches compare @P1@; taking the partner brings in @P2@, who
  // carries pointer-valued tags into the compare file's xref namespace.
  const mainBase =
    "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n" +
    "0 @I9@ INDI\n1 NAME Franc /Zupan/\n1 SEX M\n";
  const matches = { individuals: [{ mainId: "@I1@", compareId: "@P1@" }] } as never;
  const takePartner = () =>
    new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: { "fam.@PF@.partner": "incoming" } }],
    ]);
  const compareWith = (spouseExtras: string, records = "") =>
    wrap(
      "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n1 FAMS @PF@\n" +
        `0 @P2@ INDI\n1 NAME Marija /Kovač/\n1 SEX F\n1 FAMS @PF@\n${spouseExtras}` +
        "0 @PF@ FAM\n1 HUSB @P1@\n1 WIFE @P2@\n" +
        records,
    );

  it("remaps a colliding NOTE pointer and imports the compare note record", () => {
    // Main's @N1@ is an unrelated note; the new person must not point at it.
    const main = dataset(wrap(mainBase + "0 @N1@ NOTE Main note about someone else\n"));
    const compare = dataset(
      compareWith("1 NOTE @N1@\n", "0 @N1@ NOTE Compare note about Marija\n"),
    );
    const { records } = mergeDecisions(main, compare, takePartner(), matches, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("0 @N1@ NOTE Main note about someone else"); // untouched
    const noteXref = out.match(/1 NAME Marija \/Kovač\/[\s\S]*?1 NOTE (@[^@]+@)/)?.[1];
    expect(noteXref).toBeDefined();
    expect(noteXref).not.toBe("@N1@");
    expect(out).toContain(`0 ${noteXref} NOTE Compare note about Marija`);
  });

  it("reuses an existing main NOTE record with identical text", () => {
    const main = dataset(wrap(mainBase + "0 @N7@ NOTE Shared family chronicle\n"));
    const compare = dataset(
      compareWith("1 NOTE @N1@\n", "0 @N1@ NOTE Shared family chronicle\n"),
    );
    const { records } = mergeDecisions(main, compare, takePartner(), matches, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("1 NOTE @N7@");
    expect(out.match(/0 @[^@]+@ NOTE/g)).toHaveLength(1); // no duplicate minted
  });

  it("imports the OBJE record a new person's OBJE pointer references", () => {
    const main = dataset(wrap(mainBase));
    const compare = dataset(
      compareWith("1 OBJE @O7@\n", "0 @O7@ OBJE\n1 FILE https://example.com/marija.jpg\n"),
    );
    const { records } = mergeDecisions(main, compare, takePartner(), matches, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("1 OBJE @O7@");
    expect(out).toContain("0 @O7@ OBJE\n1 FILE https://example.com/marija.jpg");
  });

  it("strips ASSO/ALIA and nested family pointers, reporting associations as deferred", () => {
    const main = dataset(wrap(mainBase));
    const compare = dataset(
      compareWith(
        // ASSO @I9@ means the compare's own @I9@ (a different person than the
        // main's @I9@ Franc Zupan); ADOP carries an event-level FAMC.
        "1 ASSO @I9@\n2 ROLE GODP\n1 ALIA @P1@\n1 ADOP\n2 FAMC @PF@\n" +
          "0 @I9@ INDI\n1 NAME Peter /Drugi/\n1 SEX M\n",
      ),
    );
    const { records, report } = mergeDecisions(main, compare, takePartner(), matches, tr);
    const out = serializeGedcom(records);
    expect(out).not.toContain("1 ASSO");
    expect(out).not.toContain("1 ALIA");
    expect(out).not.toContain("2 FAMC"); // ADOP's event-level family pointer
    expect(out).toContain("1 ADOP"); // the event itself survives
    expect(report.deferred.some((d) => d.field === "merge.field.associations")).toBe(true);
  });
});

describe("an edit made after the match was confirmed wins", () => {
  const compare = dataset(COMPARE);

  /** A confirmed decision carrying the main's values as of the confirmation. */
  function confirmedAt(
    fields: Record<string, "main" | "incoming" | "both">,
    mainFields: Record<string, string>,
  ): Map<string, CandidateDecision> {
    return new Map([
      [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed" as const, fields, mainFields }],
    ]);
  }

  it("applies the incoming value when the field is untouched since confirming", () => {
    const { records, report } = mergeDecisions(
      dataset(MAIN), compare, confirmedAt({ given: "incoming" }, { given: "Janez" }), NO_MATCHES, tr,
    );
    expect(serializeGedcom(records)).toContain("1 NAME Jan;ez /Novak/");
    expect(report.deferred).toEqual([]);
  });

  it("keeps the edited value and skips the incoming one", () => {
    // At confirmation the main read "Marko"; it has since been edited to
    // "Janez", so the recorded "take incoming" choice stands down.
    const { records, report } = mergeDecisions(
      dataset(MAIN), compare, confirmedAt({ given: "incoming" }, { given: "Marko" }), NO_MATCHES, tr,
    );
    expect(serializeGedcom(records)).toContain("1 NAME Janez /Novak/");
    expect(serializeGedcom(records)).not.toContain("Jan;ez");
    expect(report.deferred.some((d) => d.reason === "merge.reason.editedAfterConfirm")).toBe(true);
  });

  it("stands down only for the edited field, not the whole record", () => {
    // The reason a per-field snapshot is needed rather than a record
    // fingerprint: a birth place typed in after confirming must not suppress
    // the unrelated given-name choice made at the same time.
    const mainWithPlace = dataset(wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n2 PLAC Ljubljana\n" +
        "0 @I2@ INDI\n1 NAME Ana /Kos/\n1 SEX F\n1 BIRT\n2 DATE 1855\n",
    ));
    const { records, report } = mergeDecisions(
      mainWithPlace, compare,
      // Snapshot omits BIRT.place — the main had none when the match was
      // confirmed — but records the given name unchanged.
      confirmedAt({ given: "incoming", "BIRT.place": "incoming" }, { given: "Janez" }),
      NO_MATCHES, tr,
    );
    const out = serializeGedcom(records);
    expect(out).toContain("1 NAME Jan;ez /Novak/"); // unrelated choice still applied
    expect(out).toContain("2 PLAC Ljubljana"); // the later edit survives
    expect(out).not.toContain("Kranj");
    expect(report.deferred.map((d) => d.reason)).toEqual(["merge.reason.editedAfterConfirm"]);
  });

  it("keeps a value the user deleted after confirming", () => {
    // Main's birth place was removed post-confirmation; refilling it from the
    // incoming file would undo that deletion.
    const { records } = mergeDecisions(
      dataset(MAIN), compare, confirmedAt({ "BIRT.place": "incoming" }, { "BIRT.place": "Bled" }), NO_MATCHES, tr,
    );
    expect(serializeGedcom(records)).not.toContain("PLAC");
  });

  it("leaves decisions confirmed before snapshots existed unchanged", () => {
    // No `mainFields` (a session restored from an older save): the recorded
    // choice applies as it always did.
    const { records, report } = mergeDecisions(
      dataset(MAIN), compare, confirmed({ given: "incoming" }), NO_MATCHES, tr,
    );
    expect(serializeGedcom(records)).toContain("1 NAME Jan;ez /Novak/");
    expect(report.deferred).toEqual([]);
  });

  it("gates the record-level Sources row: a citation added after confirming is not stripped", () => {
    // "Incoming" on the Sources row replaces the main's SOUR citations — the
    // one destructive overwrite that used to bypass the mainFields gate. The
    // main's citation here was added after the confirmation snapshot (which
    // recorded a different Sources text), so the choice stands down.
    const mainSourced = dataset(wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 SOUR @S1@\n1 BIRT\n2 DATE 1850\n" +
        "0 @S1@ SOUR\n1 TITL Krstna knjiga\n",
    ));
    const compareSourced = dataset(wrap(
      "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 SOUR @S9@\n1 BIRT\n2 DATE 1850\n" +
        "0 @S9@ SOUR\n1 TITL Poročna knjiga\n",
    ));
    const { records, report } = mergeDecisions(
      mainSourced, compareSourced,
      confirmedAt({ links: "incoming" }, { links: "Stara knjiga" }),
      NO_MATCHES, tr,
    );
    const out = serializeGedcom(records);
    expect(out).toContain("1 SOUR @S1@");
    expect(report.deferred.some((d) => d.reason === "merge.reason.editedAfterConfirm")).toBe(true);
  });
});

describe("mergeDecisions — name parts are independent choices", () => {
  // Main-only NAME sub-structure (SOUR, NICK) and the inline suffix must
  // survive a per-part take; the incoming surname must not ride along with a
  // chosen given name.
  const mainNamed = () => dataset(wrap(
    "0 @I1@ INDI\n1 NAME Janez /Novak/ st.\n2 NICK Jani\n2 SOUR @S1@\n1 SEX M\n1 BIRT\n2 DATE 1850\n" +
      "0 @S1@ SOUR\n1 TITL Krstna knjiga\n",
  ));
  const compareNamed = () => dataset(wrap(
    "0 @P1@ INDI\n1 NAME Johann /Neumann/\n1 SEX M\n1 BIRT\n2 DATE 1850\n",
  ));

  it("takes the given name without smuggling in the incoming surname", () => {
    const { records } = mergeDecisions(
      mainNamed(), compareNamed(), confirmed({ given: "incoming", surname: "main", nickname: "main" }), NO_MATCHES, tr,
    );
    const out = serializeGedcom(records);
    expect(out).toContain("1 NAME Johann /Novak/ st.");
    expect(out).not.toContain("Neumann");
    // The main's own NAME sub-structure is untouched by a part swap.
    expect(out).toContain("2 NICK Jani");
    expect(out).toContain("2 SOUR @S1@");
  });

  it("takes the surname alone, keeping the main's given name and suffix", () => {
    const { records } = mergeDecisions(
      mainNamed(), compareNamed(), confirmed({ given: "main", surname: "incoming", nickname: "main" }), NO_MATCHES, tr,
    );
    const out = serializeGedcom(records);
    expect(out).toContain("1 NAME Janez /Neumann/ st.");
    expect(out).not.toContain("Johann");
  });

  it("appends the incoming NAME once when both part rows choose \"both\"", () => {
    const { records } = mergeDecisions(
      mainNamed(), compareNamed(), confirmed({ given: "both", surname: "both", nickname: "main" }), NO_MATCHES, tr,
    );
    const out = serializeGedcom(records);
    expect(out.match(/1 NAME /g)).toHaveLength(2);
    expect(out).toContain("1 NAME Janez /Novak/ st.");
    expect(out).toContain("1 NAME Johann /Neumann/");
  });
});

describe("mergeDecisions — \"both\" on a single-cardinality field replaces", () => {
  it("never writes a second DATE or SEX under one event/record", () => {
    const main = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n"));
    const compare = dataset(wrap("0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 2 FEB 1850\n"));
    const { records } = mergeDecisions(main, compare, confirmed({ "BIRT.date": "both", sex: "both" }), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    // One DATE, holding the incoming value — not an invalid duplicate pair.
    expect(out.match(/2 DATE /g)).toHaveLength(1);
    expect(out).toContain("2 DATE 2 FEB 1850");
    expect(out.match(/1 SEX /g)?.filter((_, i, a) => a.length && i < 2).length).toBeLessThanOrEqual(2);
    // @I1@'s record carries exactly one SEX line.
    const i1 = out.slice(out.indexOf("0 @I1@ INDI"), out.indexOf("0 @I2@"));
    expect(i1.match(/1 SEX /g)).toHaveLength(1);
  });

  it("holds a replacing \"both\" to the edited-after-confirm gate", () => {
    // The user chose "both" for the birth date, then edited that date in Edit
    // mode. "Both" replaces here, so the later edit must win exactly as it
    // does for "incoming".
    const main = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1849\n"));
    const compare = dataset(wrap("0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 2 FEB 1850\n"));
    const decisions = new Map<string, CandidateDecision>();
    decisions.set(decisionKey("individual", "@I1@", "@P1@"), {
      status: "confirmed",
      fields: { "BIRT.date": "both" },
      // Snapshot taken at confirm time said the main's date was "1850" — the
      // live main now reads "1849", i.e. edited since.
      mainFields: { given: "Janez", surname: "Novak", sex: "sexM", "BIRT.date": "1850" },
    });
    const { records, report } = mergeDecisions(main, compare, decisions, NO_MATCHES, tr);
    expect(serializeGedcom(records)).toContain("2 DATE 1849");
    expect(report.deferred.some((d) => d.reason === "merge.reason.editedAfterConfirm")).toBe(true);
  });
});

describe("mergeDecisions — one family for a couple, however it is reached", () => {
  it("grafting descendants reuses the family a confirmed decision created", () => {
    // A confirmed match takes the partner and child, creating a new family;
    // the user also asks for the whole descendants branch. The graft must
    // fill gaps in that same family, not mint a parallel one.
    const main = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n"));
    const compare = dataset(
      wrap(
        "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @G1@\n" +
          "0 @P2@ INDI\n1 NAME Marija /Kos/\n1 SEX F\n1 FAMS @G1@\n" +
          "0 @P3@ INDI\n1 NAME Tone /Novak/\n1 SEX M\n1 FAMC @G1@\n" +
          "0 @G1@ FAM\n1 HUSB @P1@\n1 WIFE @P2@\n1 CHIL @P3@\n",
      ),
    );
    const matches = { individuals: [{ mainId: "@I1@", compareId: "@P1@" }] } as never;
    const decisions = new Map<string, CandidateDecision>();
    decisions.set(decisionKey("individual", "@I1@", "@P1@"), {
      status: "confirmed",
      fields: { "fam.@G1@.partner": "incoming" },
      takenChildren: ["@P3@"],
    });
    const { records, report } = mergeDecisions(main, compare, decisions, matches, tr, [
      { incomingId: "@P1@", direction: "descendants" },
    ]);
    const out = serializeGedcom(records);
    expect(report.newFamilies).toBe(1);
    expect(out.match(/0 @F\d+@ FAM/g)).toHaveLength(1);
    // No double FAMS/FAMC anywhere in the stitched household.
    const anchorStart = out.indexOf("0 @I1@ INDI");
    const anchor = out.slice(anchorStart, out.indexOf("\n0 @", anchorStart + 1));
    expect(anchor.match(/1 FAMS /g)).toHaveLength(1);
    expect(out.match(/1 FAMC /g)).toHaveLength(1);
  });

  // A graft resolves every incoming person through the match map, which holds
  // every candidate the matcher produced — including weak ones the user never
  // saw. Here "Marija Novak" is one of those: the main file already records her
  // as Matija's daughter, so she cannot also be born into the family being
  // grafted. Whichever way that is settled, she must never end up with two
  // FAMC — two birth families on one person.
  const TWO_PARENTS_MAIN = wrap(
    "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n" +
      "0 @I2@ INDI\n1 NAME Marija /Novak/\n1 SEX F\n1 BIRT\n2 DATE 1835\n1 FAMC @F1@\n" +
      "0 @I3@ INDI\n1 NAME Matija /Novak/\n1 SEX M\n1 FAMS @F1@\n" +
      "0 @F1@ FAM\n1 HUSB @I3@\n1 CHIL @I2@\n",
  );
  const TWO_PARENTS_COMPARE = wrap(
    "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @G1@\n" +
      "0 @P2@ INDI\n1 NAME Marija /Novak/\n1 SEX F\n1 BIRT\n2 DATE 1835\n1 FAMC @G1@\n" +
      "0 @G1@ FAM\n1 HUSB @P1@\n1 CHIL @P2@\n",
  );
  const TWO_PARENTS_MATCHES = {
    individuals: [
      { mainId: "@I1@", compareId: "@P1@" },
      { mainId: "@I2@", compareId: "@P2@" },
    ],
  } as never;
  /** The reason strings carry their variables, so the preview's wording can be checked. */
  const interp = (key: string, vars?: Record<string, unknown>) =>
    `${key}|${Object.entries(vars ?? {}).map(([k, v]) => `${k}=${v}`).join(",")}`;
  /** Marija's record as serialized. */
  const recordOf = (out: string, xref: string) => {
    const start = out.indexOf(`0 ${xref} INDI`);
    return out.slice(start, out.indexOf("\n0 @", start + 1));
  };

  it("a suggested child the parents contradict is imported as their own person", () => {
    const main = dataset(TWO_PARENTS_MAIN);
    const compare = dataset(TWO_PARENTS_COMPARE);
    const decisions = new Map<string, CandidateDecision>();
    decisions.set(decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: {} });
    const { records, report } = mergeDecisions(main, compare, decisions, TWO_PARENTS_MATCHES, interp, [
      { incomingId: "@P1@", direction: "descendants" },
    ]);
    const out = serializeGedcom(records);
    // The main Marija is untouched: one FAMC, still her own family.
    const marija = recordOf(out, "@I2@");
    expect(marija.match(/1 FAMC /g)).toHaveLength(1);
    expect(marija).toContain("1 FAMC @F1@");
    // The incoming one came in as a person of her own, under Janez.
    expect(report.newPersons).toBe(1);
    expect(out.match(/1 FAMC /g)).toHaveLength(2);
    // Asking for a branch is asking for the people in it: she is reported as
    // the new person she is, with nothing filed under "kept as in your file".
    expect(report.deferred).toEqual([]);
  });

  it("a confirmed child whose parents disagree is left out and reported", () => {
    const main = dataset(TWO_PARENTS_MAIN);
    const compare = dataset(TWO_PARENTS_COMPARE);
    const decisions = new Map<string, CandidateDecision>();
    decisions.set(decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: {} });
    // You vouched for Marija being the same person — so she is not duplicated,
    // and the parentage disagreement is handed back to you.
    decisions.set(decisionKey("individual", "@I2@", "@P2@"), { status: "confirmed", fields: {} });
    const { records, report } = mergeDecisions(main, compare, decisions, TWO_PARENTS_MATCHES, interp, [
      { incomingId: "@P1@", direction: "descendants" },
    ]);
    const out = serializeGedcom(records);
    const marija = recordOf(out, "@I2@");
    expect(marija.match(/1 FAMC /g)).toHaveLength(1);
    expect(marija).toContain("1 FAMC @F1@");
    expect(report.newPersons).toBe(0);
    expect(
      report.deferred.some(
        (d) =>
          d.reason.startsWith("merge.reason.childHasParents|") &&
          d.reason.includes("child=Marija Novak") &&
          d.reason.includes("kept=Matija Novak"),
      ),
    ).toBe(true);
  });

  // A graft walks far past the person the user was looking at, joining onto
  // whatever main record the matcher paired each person below with. Those
  // pairings include the weak ones nobody ever saw: "Milan Grča" born 1972
  // clears the name and era gates against "Marjan Gorza" born 1944 by a hair
  // (surname 0.805 against the 0.80 gate, 28 years against the 30-year one).
  // Joining on that pairing files Milan's wife and children as Marjan's — with
  // Marjan's own wife as their mother.
  const WEAK_PAIR_MAIN = wrap(
    "0 @I1@ INDI\n1 NAME Marjan /Gorza/\n1 SEX M\n1 BIRT\n2 DATE 2 APR 1944\n1 FAMS @F1@\n" +
      "0 @I2@ INDI\n1 NAME Anica /Celar/\n1 SEX F\n1 FAMS @F1@\n" +
      "0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n",
  );
  const WEAK_PAIR_COMPARE = wrap(
    "0 @P1@ INDI\n1 NAME Jozef /Grca/\n1 SEX M\n1 FAMS @G1@\n" +
      "0 @P2@ INDI\n1 NAME Milan /Grca/\n1 SEX M\n1 BIRT\n2 DATE 28 JUL 1972\n1 FAMC @G1@\n1 FAMS @G2@\n" +
      "0 @P3@ INDI\n1 NAME Urska /Krnicar/\n1 SEX F\n1 FAMS @G2@\n" +
      "0 @P4@ INDI\n1 NAME Luka /Grca/\n1 SEX M\n1 FAMC @G2@\n" +
      "0 @G1@ FAM\n1 HUSB @P1@\n1 CHIL @P2@\n" +
      "0 @G2@ FAM\n1 HUSB @P2@\n1 WIFE @P3@\n1 CHIL @P4@\n",
  );
  const WEAK_PAIR_MATCHES = { individuals: [{ mainId: "@I1@", compareId: "@P2@" }] } as never;
  const NO_PICKS = new Map<string, CandidateDecision>();
  /** One record as serialized, from its header line to the next record. */
  const block = (out: string, header: string) => {
    const start = out.indexOf(header);
    return out.slice(start, out.indexOf("\n0 ", start + 1) + 1);
  };

  it("a graft does not join onto a suggested pair with a different given name and birth year", () => {
    const { records, report } = mergeDecisions(
      dataset(WEAK_PAIR_MAIN), dataset(WEAK_PAIR_COMPARE), NO_PICKS, WEAK_PAIR_MATCHES, tr,
      [{ incomingId: "@P1@", direction: "descendants" }],
    );
    const out = serializeGedcom(records);
    // Marjan's family stays the childless couple it was: no child of Milan's
    // was written into it, and nobody made Anica their mother.
    expect(block(out, "0 @F1@ FAM")).toBe("0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n");
    // Milan came in as the person he is, with his own wife and child under him.
    expect(report.newPersons).toBe(4);
    expect(out).toContain("Milan /Grca/");
    // Asking for a branch is asking for the people in it — nothing to report,
    // and no identity to own up to: none was used.
    expect(report.deferred).toEqual([]);
    expect(report.graftJoins).toEqual([]);
  });

  it("a graft joins onto a confirmed pair however far apart the two records read", () => {
    // You vouched for these two being one person, and a confirmation outranks
    // the files' own evidence: the branch hangs off your Marjan after all.
    const decisions = new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I1@", "@P2@"), { status: "confirmed", fields: {} }],
    ]);
    const { records, report } = mergeDecisions(
      dataset(WEAK_PAIR_MAIN), dataset(WEAK_PAIR_COMPARE), decisions, WEAK_PAIR_MATCHES, tr,
      [{ incomingId: "@P1@", direction: "descendants" }],
    );
    const out = serializeGedcom(records);
    expect(out).not.toContain("Milan /Grca/"); // joined, not duplicated
    // The branch hangs off your Marjan: a second family of his carries Milan's
    // wife and their child, while the family he already had is left alone.
    expect(out).toMatch(/0 @F\d+@ FAM\n1 HUSB @I1@\n1 WIFE @I\d+@\n1 CHIL @I\d+@\n/);
    expect(block(out, "0 @F1@ FAM")).toBe("0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n");
    // You made this call yourself, so there is nothing to own up to.
    expect(report.graftJoins).toEqual([]);
  });

  it("a graft still joins across a spelling variant and a year or two of drift", () => {
    // The vetoes must not fire on what they exist to allow: Jože/Jožef is one
    // name spelt twice, and 1938/1940 is the drift between two sources.
    const main = dataset(
      wrap("0 @I1@ INDI\n1 NAME Joze /Grca/\n1 SEX M\n1 BIRT\n2 DATE 1938\n"),
    );
    const compare = dataset(
      wrap(
        "0 @P1@ INDI\n1 NAME Jozef /Grca/\n1 SEX M\n1 BIRT\n2 DATE 1940\n1 FAMS @G1@\n" +
          "0 @P2@ INDI\n1 NAME Marija /Seme/\n1 SEX F\n1 FAMS @G1@\n" +
          "0 @G1@ FAM\n1 HUSB @P1@\n1 WIFE @P2@\n",
      ),
    );
    const matches = { individuals: [{ mainId: "@I1@", compareId: "@P1@" }] } as never;
    const { records, report } = mergeDecisions(main, compare, NO_PICKS, matches, tr, [
      { incomingId: "@P1@", direction: "descendants" },
    ]);
    expect(report.newPersons).toBe(1); // the wife only
    expect(serializeGedcom(records)).not.toContain("Jozef /Grca/");
    // The join was the app's call, not the user's, so the preview names it.
    expect(report.graftJoins).toEqual([
      { mainId: "@I1@", mainLabel: "Joze Grca 1938", incomingLabel: "Jozef Grca 1940" },
    ]);
  });

  it("a person with several incoming marriages gets a family per marriage", () => {
    // The lone-family fallback needs a single marriage on each side — three
    // incoming unions must not collapse into the first one created.
    const main = dataset(wrap("0 @I1@ INDI\n1 NAME Lettice /Knollys/\n1 SEX F\n"));
    const compare = dataset(
      wrap(
        "0 @P1@ INDI\n1 NAME Lettice /Knollys/\n1 SEX F\n1 FAMS @G1@\n1 FAMS @G2@\n" +
          "0 @P2@ INDI\n1 NAME Walter /Devereux/\n1 SEX M\n1 FAMS @G1@\n" +
          "0 @P3@ INDI\n1 NAME Robert /Dudley/\n1 SEX M\n1 FAMS @G2@\n" +
          "0 @G1@ FAM\n1 HUSB @P2@\n1 WIFE @P1@\n" +
          "0 @G2@ FAM\n1 HUSB @P3@\n1 WIFE @P1@\n",
      ),
    );
    const matches = { individuals: [{ mainId: "@I1@", compareId: "@P1@" }] } as never;
    const { records, report } = mergeDecisions(main, compare, new Map(), matches, tr, [
      { incomingId: "@P1@", direction: "descendants" },
    ]);
    const out = serializeGedcom(records);
    expect(report.newFamilies).toBe(2);
    expect(out.match(/0 @F\d+@ FAM/g)).toHaveLength(2);
    expect(report.deferred).toEqual([]);
  });
});

describe("mergeDecisions — family choices from both spouses' cards", () => {
  const mainCouple = () => dataset(
    wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @F1@\n" +
        "0 @I2@ INDI\n1 NAME Marija /Novak/\n1 SEX F\n1 FAMS @F1@\n" +
        "0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n1 MARR\n2 DATE 1880\n",
    ),
  );
  const compareCouple = () => dataset(
    wrap(
      "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @G1@\n" +
        "0 @P2@ INDI\n1 NAME Marija /Novak/\n1 SEX F\n1 FAMS @G1@\n" +
        "0 @G1@ FAM\n1 HUSB @P1@\n1 WIFE @P2@\n1 MARR\n2 DATE 2 FEB 1880\n2 PLAC Kranj\n",
    ),
  );
  const coupleMatches = {
    individuals: [
      { mainId: "@I1@", compareId: "@P1@" },
      { mainId: "@I2@", compareId: "@P2@" },
    ],
  } as never;

  it("applies the second spouse's explicit choice though the first spouse's turn stitched the family", () => {
    // The husband confirms with defaults (the incoming-only marriage place
    // processes the family and marks it done); the wife's card carries the
    // explicit date choice. Confirmation order must not decide whether it
    // applies.
    const decisions = new Map<string, CandidateDecision>();
    decisions.set(decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: {} });
    decisions.set(decisionKey("individual", "@I2@", "@P2@"), {
      status: "confirmed",
      fields: { "fam.@G1@.MARR.date": "incoming" },
    });
    const { records } = mergeDecisions(mainCouple(), compareCouple(), decisions, coupleMatches, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("2 DATE 2 FEB 1880");
    expect(out).toContain("2 PLAC Kranj");
    expect(out.match(/0 @F\d*1?@ FAM|0 @F1@ FAM/g)).toBeTruthy();
    // Still stitched exactly once — no duplicate family, no doubled MARR.
    expect(out.match(/1 MARR/g)).toHaveLength(1);
  });
});

describe("mergeDecisions — marriage facts land in the family the review showed", () => {
  it("writes into the review-paired family, not the first spouseless one", () => {
    // Main: a spouseless family first in FAMS order, then the real one with
    // the namesake wife. The incoming wife is unmatched, so the merge's own
    // spouse lookup would fall through to the spouseless F1 — but the review
    // paired G1 with F2 (spouse similarity), and that is where the user read
    // the rows they judged.
    const main = dataset(
      wrap(
        "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @F1@\n1 FAMS @F2@\n" +
          "0 @I2@ INDI\n1 NAME Marija /Kos/\n1 SEX F\n1 BIRT\n2 DATE 1858\n1 FAMS @F2@\n" +
          "0 @F1@ FAM\n1 HUSB @I1@\n" +
          "0 @F2@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n",
      ),
    );
    const compare = dataset(
      wrap(
        "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @G1@\n" +
          "0 @P2@ INDI\n1 NAME Marija /Kos/\n1 SEX F\n1 BIRT\n2 DATE 1858\n1 FAMS @G1@\n" +
          "0 @G1@ FAM\n1 HUSB @P1@\n1 WIFE @P2@\n1 MARR\n2 DATE 1880\n",
      ),
    );
    const matches = { individuals: [{ mainId: "@I1@", compareId: "@P1@" }] } as never;
    const { records } = mergeDecisions(main, compare, confirmedAtKey("@I1@", "@P1@"), matches, tr);
    const out = serializeGedcom(records);
    const f1 = out.slice(out.indexOf("0 @F1@ FAM"), out.indexOf("0 @F2@ FAM"));
    const f2 = out.slice(out.indexOf("0 @F2@ FAM"));
    expect(f2).toContain("1 MARR");
    expect(f2).toContain("2 DATE 1880");
    expect(f1).not.toContain("1 MARR");
  });
});

describe("merge xref allocation respects shared-record reservations", () => {
  it("a minted link record never squats on an xref promised to a compare import", () => {
    // Main stores links as OBJE records; @O1@ exists, so a new link would
    // naturally mint @O2@ — but the compare's photo record already holds
    // @O2@, promised to the import that runs after the decisions. The link
    // must skip to @O3@ and the photo must arrive intact.
    const main = dataset(
      wrap(
        "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n1 OBJE @O1@\n" +
          "0 @O1@ OBJE\n1 FILE https://example.com/old\n",
      ),
    );
    const compare = dataset(
      wrap(
        "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n2 SOUR @S9@\n1 WWW https://example.com/new\n" +
          "0 @S9@ SOUR\n1 TITL Krstna knjiga\n1 OBJE @O2@\n" +
          "0 @O2@ OBJE\n1 FILE photo.jpg\n",
      ),
    );
    const { records } = mergeDecisions(main, compare, confirmed({ links: "both" }), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    // The imported source still reaches its photo record…
    expect(out).toContain("0 @S9@ SOUR");
    expect(out).toContain("1 OBJE @O2@");
    expect(out).toContain("0 @O2@ OBJE\n1 FILE photo.jpg");
    // …and the new link took the next free id instead.
    expect(out).toContain("0 @O3@ OBJE\n1 FILE https://example.com/new");
  });
});

describe("rowCanKeepBoth", () => {
  it("matches the engine's replace-vs-append rule per row key", () => {
    // Single-cardinality → "both" would replace, so the UI must not offer it.
    for (const key of ["sex", "nickname", "BIRT.date", "RESI.1.place", "OCCU.value", "fam.@G1@.MARR.date", "fam.@G1@.EVEN.value"]) {
      expect(rowCanKeepBoth(key), key).toBe(false);
    }
    // Genuinely repeatable → "both" appends and stays offered.
    for (const key of ["given", "surname", "notes", "fsid", "links", "BIRT.note", "BIRT.sources", "fam.@G1@.MARR.sources", "fam.@G1@.notes"]) {
      expect(rowCanKeepBoth(key), key).toBe(true);
    }
  });
});

describe("mergeDecisions — a second union with a different partner", () => {
  // Nejc is married to Neja in main and to Katja in the incoming file: two
  // plainly different women, so the review shows two families and the merge
  // must leave the first marriage alone and build the second one beside it.
  const main = wrap(
    "0 @I1@ INDI\n1 NAME Nejc /Bratuša/\n1 SEX M\n1 FAMS @F1@\n" +
      "0 @I2@ INDI\n1 NAME Neja /Bizjak/\n1 SEX F\n1 FAMS @F1@\n" +
      "0 @I3@ INDI\n1 NAME Ota /Bratuša/\n1 SEX F\n1 FAMC @F1@\n" +
      "0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n1 CHIL @I3@\n1 MARR\n2 DATE 5 NOV 2024\n",
  );
  const compare = wrap(
    "0 @P1@ INDI\n1 NAME Nejc /Bratuša/\n1 SEX M\n1 FAMS @PF@\n" +
      "0 @P2@ INDI\n1 NAME Katja /Špiler/\n1 SEX F\n1 FAMS @PF@\n" +
      "0 @P3@ INDI\n1 NAME Aljoša /Bratuša/\n1 SEX M\n1 FAMC @PF@\n" +
      "0 @PF@ FAM\n1 HUSB @P1@\n1 WIFE @P2@\n1 CHIL @P3@\n1 MARR\n2 PLAC Križe\n",
  );
  const matches = { individuals: [{ mainId: "@I1@", compareId: "@P1@" }], families: [] } as never;

  it("adds the new partner and their child as a second family, leaving the first intact", () => {
    const decisions = new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I1@", "@P1@"), {
        status: "confirmed",
        fields: { "fam.@PF@.partner": "incoming", "fam.@PF@.MARR.place": "incoming" },
        takenChildren: ["@P3@"],
      }],
    ]);
    const out = serializeGedcom(mergeDecisions(dataset(main), dataset(compare), decisions, matches, tr).records);

    // The original marriage is untouched: same wife, same child, same date.
    expect(out).toContain("0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n1 CHIL @I3@\n1 MARR\n2 DATE 5 NOV 2024");
    // Katja and Aljoša arrive as new people in a family of their own.
    const newFam = out.match(/0 (@F\d+@) FAM\n1 HUSB @I1@\n1 WIFE (@[^@]+@)\n1 CHIL (@[^@]+@)\n1 MARR\n2 PLAC Križe/);
    expect(newFam).not.toBeNull();
    const [, newFamId, wifeId, childId] = newFam!;
    expect(newFamId).not.toBe("@F1@");
    expect(out).toContain(`0 ${wifeId} INDI\n1 NAME Katja /Špiler/`);
    expect(out).toContain(`0 ${childId} INDI\n1 NAME Aljoša /Bratuša/`);
    // Neja is not touched, and Nejc now belongs to both marriages.
    expect(out).toContain("0 @I2@ INDI\n1 NAME Neja /Bizjak/\n1 SEX F\n1 FAMS @F1@\n");
    expect(out).toMatch(/0 @I1@ INDI[\s\S]*?1 FAMS @F1@\n1 FAMS @F\d+@/);
  });
});

/** A confirmed decision keyed to an explicit pair, with default fields. */
function confirmedAtKey(mainId: string, compareId: string): Map<string, CandidateDecision> {
  const m = new Map<string, CandidateDecision>();
  m.set(decisionKey("individual", mainId, compareId), { status: "confirmed", fields: {} });
  return m;
}

/** Naive line-level diff for asserting which lines were added/removed. */
function lineDiff(before: string, after: string): { added: string[]; removed: string[] } {
  const b = new Map<string, number>();
  for (const l of before.split("\n")) b.set(l, (b.get(l) ?? 0) + 1);
  const a = new Map<string, number>();
  for (const l of after.split("\n")) a.set(l, (a.get(l) ?? 0) + 1);
  const added: string[] = [];
  const removed: string[] = [];
  for (const [l, n] of a) if (l && n > (b.get(l) ?? 0)) added.push(l);
  for (const [l, n] of b) if (l && n > (a.get(l) ?? 0)) removed.push(l);
  return { added, removed };
}
