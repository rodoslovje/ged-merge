import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import { decisionKey, type CandidateDecision } from "../review/types";
import type { GedNode } from "../gedcom/types";
import { inferMasterProfile } from "../normalize/profile";
import { normalizeDataset } from "../normalize/normalize";
import { materializeEventSources, mergeDecisions } from "./merge";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}
const tr = (key: string) => key;
const NO_MATCHES = { individuals: [], families: [] };
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;

// Master lacks a birth place and has a differing given name from incoming.
const MASTER = wrap(
  "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n" +
    "0 @I2@ INDI\n1 NAME Ana /Kos/\n1 SEX F\n1 BIRT\n2 DATE 1855\n",
);
const COMPARE = wrap(
  "0 @P1@ INDI\n1 NAME Jan;ez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n2 PLAC Kranj\n",
);

function confirmed(fields: Record<string, "master" | "incoming" | "both"> = {}): Map<string, CandidateDecision> {
  const m = new Map<string, CandidateDecision>();
  m.set(decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields });
  return m;
}

describe("mergeDecisions", () => {
  const master = dataset(MASTER);
  const compare = dataset(COMPARE);

  it("fills in a field the master is missing (default = incoming)", () => {
    const { records, report } = mergeDecisions(master, compare, confirmed(), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("1 BIRT\n2 DATE 1850\n2 PLAC Kranj");
    const change = report.changes.find((c) => c.to === "Kranj");
    expect(change).toBeDefined();
    // A plain, un-chosen copy of the incoming value — the preview should color
    // this like other incoming-sourced data, not like something the user edited.
    expect(change!.unedited).toBe(true);
  });

  it("leaves a conflicting field on master unless explicitly chosen", () => {
    const { records } = mergeDecisions(master, compare, confirmed(), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("1 NAME Janez /Novak/"); // master name kept
    expect(out).not.toContain("Jan;ez");
  });

  it("takes a conflicting field when the user chose incoming", () => {
    const { records } = mergeDecisions(master, compare, confirmed({ given: "incoming" }), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("1 NAME Jan;ez /Novak/");
  });

  it("changes only the merged record (minimal diff)", () => {
    const before = serializeGedcom(master.records);
    const { records } = mergeDecisions(master, compare, confirmed(), NO_MATCHES, tr);
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
    const { records, report } = mergeDecisions(master, compare, m, NO_MATCHES, tr);
    expect(report.changes).toHaveLength(0);
    expect(serializeGedcom(records)).toBe(serializeGedcom(master.records));
  });
});

describe("mergeDecisions — event TYPE and CAUS sub-fields", () => {
  const master = dataset(wrap(
    "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 DEAT\n2 DATE 1900\n",
  ));
  const compare = dataset(wrap(
    "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 DEAT\n2 TYPE natural\n2 DATE 1900\n2 CAUS Pljučnica\n",
  ));

  it("fills in an incoming CAUS and TYPE the master lacks (default = incoming)", () => {
    const { records, report } = mergeDecisions(master, compare, confirmed(), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("2 CAUS Pljučnica");
    expect(out).toContain("2 TYPE natural");
    expect(report.changes.some((c) => c.to.includes("Pljučnica"))).toBe(true);
  });

  it("leaves a conflicting master CAUS unless explicitly chosen", () => {
    const masterWithCaus = dataset(wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 DEAT\n2 DATE 1900\n2 CAUS Starost\n",
    ));
    const { records } = mergeDecisions(masterWithCaus, compare, confirmed(), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("2 CAUS Starost");
    expect(out).not.toContain("2 CAUS Pljučnica");
  });

  it("takes a conflicting CAUS when the user chose incoming", () => {
    const masterWithCaus = dataset(wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 DEAT\n2 DATE 1900\n2 CAUS Starost\n",
    ));
    const { records } = mergeDecisions(masterWithCaus, compare, confirmed({ "DEAT.cause": "incoming" }), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("2 CAUS Pljučnica");
    expect(out).not.toContain("2 CAUS Starost");
  });
});

describe("mergeDecisions — place reshaping to a structured-addr master", () => {
  // Place reshaping now happens when the incoming file is loaded (normalizeDataset),
  // not inside mergeDecisions — so these tests normalize the compare dataset first,
  // exactly as the app does after loading master + incoming.
  //
  // Master writes structured PLAC ("A,B,C") + separate ADDR, so its layout is
  // detected as structured-addr. @I1@'s birth has no place yet, so the incoming
  // (packed Brother's Keeper) place fills it — reshaped to the master's layout.
  const master = dataset(
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
    const { dataset: normalizedCompare } = normalizeDataset(compare, inferMasterProfile(master));
    const { records } = mergeDecisions(master, normalizedCompare, confirmed(), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    // The master's own DEAT for @I2@ attests "Kranj,Gorenjska,Slovenia" — the
    // learned place hierarchy fills in that municipality level here too.
    expect(out).toContain(
      "1 BIRT\n2 DATE 1850\n2 PLAC Kranj,Gorenjska,Slovenia\n2 ADDR Kidričeva 38/a (porodnišnica)",
    );
    expect(out).not.toContain("2 NOTE porodnišnica");
  });

  it("does not rewrite existing PLAC when only ADDR is new (minimal diff)", () => {
    // @I2@ already has a BIRT PLAC that matches the incoming after reshape.
    // Only the new ADDR should be added — the existing PLAC must not change.
    const masterWithPlac = dataset(
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
    const { dataset: normalizedCompareWithAddr } = normalizeDataset(compareWithAddr, inferMasterProfile(masterWithPlac));
    const decisions = new Map<string, CandidateDecision>();
    decisions.set(
      decisionKey("individual", "@I2@", "@P2@"),
      { status: "confirmed", fields: {} },
    );
    const before = serializeGedcom(masterWithPlac.records);
    const { records } = mergeDecisions(masterWithPlac, normalizedCompareWithAddr, decisions, NO_MATCHES, tr);
    const after = serializeGedcom(records);
    const diff = lineDiff(before, after);
    // Only the new ADDR line should be added; the existing PLAC must stay unchanged.
    expect(diff.added).toEqual(["2 ADDR Kidričeva 5"]);
    expect(diff.removed).toEqual([]);
  });
});

describe("mergeDecisions — family structure (driven by the confirmed spouse)", () => {
  // Master has the people but the family @F1@ only links the husband.
  const master = dataset(
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
      { masterId: "@I1@", compareId: "@P1@" },
      { masterId: "@I2@", compareId: "@P2@" },
      { masterId: "@I3@", compareId: "@P3@" },
    ],
  } as never;

  // Confirming the husband stitches in the spouse/marriage; children are opt-in,
  // so the matched child and the brand-new one are taken explicitly by id.
  const decisions = new Map<string, CandidateDecision>([
    [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: {}, takenChildren: ["@P3@", "@P4@"] }],
  ]);

  const { records, report } = mergeDecisions(master, compare, decisions, matches, tr);
  const out = serializeGedcom(records);

  it("links the missing spouse to the existing master person", () => {
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
    const { records: recs } = mergeDecisions(master, compare, partial, matches, tr);
    const text = serializeGedcom(recs);
    expect(text).toContain("1 CHIL @I4@"); // Tone (@P4@) taken
    expect(text).not.toContain("1 CHIL @I3@"); // Ana (@P3@) left out
  });

  it("stitches in no children by default (children are opt-in)", () => {
    const noKids = new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: {} }],
    ]);
    const { records: recs } = mergeDecisions(master, compare, noKids, matches, tr);
    const text = serializeGedcom(recs);
    // The spouse is still linked, but neither child is added to the family.
    expect(text).toContain("1 WIFE @I2@");
    expect(text).not.toContain("1 CHIL");
  });
});

describe("mergeDecisions — second partner becomes its own family", () => {
  // Master: Janez (@I1@) is already married to Marija (@I2@) in @F1@. Ana (@I3@)
  // exists but is single. The incoming file marries the same Janez to Ana.
  const master = dataset(
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
        { masterId: "@I1@", compareId: "@P1@" },
        { masterId: "@I3@", compareId: "@P5@" },
      ],
    } as never;
    const decisions = new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: {} }],
    ]);
    const { records, report } = mergeDecisions(master, compare, decisions, matches, tr);
    const out = serializeGedcom(records);

    // Janez's first marriage is untouched...
    expect(out).toContain("0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@");
    // ...and the second union pairs Janez with Ana in a brand-new family.
    expect(out).toMatch(/0 @F\d+@ FAM\n1 HUSB @I1@\n1 WIFE @I3@/);
    expect(report.newFamilies).toBe(1);
    // No "different spouse" conflict was raised.
    expect(report.deferred).toHaveLength(0);
  });

  it("still defers (no duplicate family) when the second partner is an unmatched person", () => {
    // Ana is NOT matched, so it can't be confirmed as a distinct individual —
    // the conflict is surfaced for the user rather than silently spawning a family.
    const matches = { individuals: [{ masterId: "@I1@", compareId: "@P1@" }] } as never;
    const decisions = new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: {} }],
    ]);
    const { report } = mergeDecisions(master, compare, decisions, matches, tr);
    expect(report.newFamilies).toBe(0);
    expect(report.deferred.length).toBeGreaterThan(0);
  });
});

describe("mergeDecisions — import whole subtrees from the compare tree", () => {
  const NO_DECISIONS = new Map<string, CandidateDecision>();

  it("grafts a person's descendants (spouse, child, and the child's own family) recursively", () => {
    // Master has only the anchor; everything below comes from the incoming file.
    const master = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n"));
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
    const matches = { individuals: [{ masterId: "@I1@", compareId: "@P1@" }] } as never;

    const { records, report } = mergeDecisions(master, compare, NO_DECISIONS, matches, tr, [
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
    // Master already has the anchor and a father that matches an incoming person.
    const master = dataset(
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
    // Both the anchor and the father are matched to existing master people.
    const matches = {
      individuals: [
        { masterId: "@I1@", compareId: "@P1@" },
        { masterId: "@I2@", compareId: "@P2@" },
      ],
    } as never;

    const { records, report } = mergeDecisions(master, compare, NO_DECISIONS, matches, tr, [
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
  });

  it("does nothing when there are no import requests", () => {
    const master = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n"));
    const compare = dataset(wrap("0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n"));
    const matches = { individuals: [{ masterId: "@I1@", compareId: "@P1@" }] } as never;
    const { records, report } = mergeDecisions(master, compare, NO_DECISIONS, matches, tr, []);
    expect(report.newPersons).toBe(0);
    expect(serializeGedcom(records)).toBe(serializeGedcom(master.records));
  });
});

describe("mergeDecisions — family touched via both confirmed spouses", () => {
  // Both spouses already exist in master and are independently confirmed as
  // matches to the incoming pair, so the shared family is visited twice (once
  // per spouse) while stitching in their marriage facts.
  const master = dataset(
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
      { masterId: "@I1@", compareId: "@P1@" },
      { masterId: "@I2@", compareId: "@P2@" },
    ],
  } as never;

  // Confirm both spouses, each choosing "both" for the marriage note — an
  // append-style choice, so applying it twice would duplicate the NOTE line.
  const decisions = new Map<string, CandidateDecision>([
    [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: { "fam.@G1@.MARR.note": "both" } }],
    [decisionKey("individual", "@I2@", "@P2@"), { status: "confirmed", fields: { "fam.@G1@.MARR.note": "both" } }],
  ]);

  const { records, report } = mergeDecisions(master, compare, decisions, matches, tr);
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

describe("mergeDecisions — individual relations (parents & partners)", () => {
  // Master has the people but @I1@ has no parents and no spouse linked.
  const master = dataset(
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
      { masterId: "@I1@", compareId: "@P1@" },
      { masterId: "@I2@", compareId: "@P2@" },
      { masterId: "@I3@", compareId: "@P3@" },
    ],
    families: [],
  } as never;

  const decisions = new Map<string, CandidateDecision>([
    [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: {} }],
  ]);

  const { records } = mergeDecisions(master, compare, decisions, matches, tr);
  const out = serializeGedcom(records);

  it("creates a child-family linking the matched father and mother", () => {
    // A new FAM with the child and both parents (existing master people).
    expect(out).toMatch(/0 @F\d+@ FAM\n1 HUSB @I2@\n1 WIFE @I3@\n1 CHIL @I1@/);
    expect(out).toContain("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMC @");
    expect(out).toContain("0 @I2@ INDI\n1 NAME Jakob /Novak/\n1 SEX M\n1 FAMS @");
  });

  it("adds a new partner as a couple family with a new person record", () => {
    expect(out).toContain("0 @I4@ INDI\n1 NAME Ana /Horvat/"); // new spouse added
    // A couple family pairing @I1@ (husband) with the new wife @I4@.
    expect(out).toMatch(/0 @F\d+@ FAM\n1 HUSB @I1@\n1 WIFE @I4@/);
  });

  it("imports a rejected-match parent as a new record instead of reusing the wrong master person", () => {
    // The mother candidate @I3@/@P3@ is a false positive the user rejected; the
    // father @I2@/@P2@ stays a confirmed-as-plausible match.
    const rejectMother = new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: {} }],
      [decisionKey("individual", "@I3@", "@P3@"), { status: "rejected", fields: {} }],
    ]);
    const { records: recs } = mergeDecisions(master, compare, rejectMother, matches, tr);
    const rejected = serializeGedcom(recs);
    // Father is still the existing @I2@; mother is a freshly added record (@I4@),
    // not the rejected @I3@.
    expect(rejected).toMatch(/0 @F\d+@ FAM\n1 HUSB @I2@\n1 WIFE @I4@\n1 CHIL @I1@/);
    expect(rejected).toContain("0 @I4@ INDI\n1 NAME Neza /Kos/");
    expect(rejected).not.toMatch(/1 WIFE @I3@/);
  });
});

describe("mergeDecisions — links", () => {
  it("adds a new incoming link the master lacks", () => {
    const master = dataset(MASTER);
    const compare = dataset(
      wrap("0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 WWW https://example.com/new\n"),
    );
    const { records, report } = mergeDecisions(master, compare, confirmed(), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("1 WWW https://example.com/new");
    expect(report.changes.some((c) => c.links?.includes("https://example.com/new"))).toBe(true);
  });

  it("doesn't duplicate a link the master already has (even with a trailing slash)", () => {
    const master = dataset(
      wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 WWW https://example.com/old/\n"),
    );
    const compare = dataset(
      wrap("0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 WWW https://example.com/old\n"),
    );
    const { records, report } = mergeDecisions(master, compare, confirmed(), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out.match(/WWW/g)).toHaveLength(1);
    expect(report.changes).toHaveLength(0);
  });

  it("adds a new incoming link as a _WEBTAG block when the master uses that format", () => {
    const master = dataset(
      wrap(
        "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n" +
          "1 _WEBTAG\n2 NAME rojstvo\n2 URL https://data.matricula-online.eu/sl/slovenia/ljubljana/kranj/01/\n",
      ),
    );
    const compare = dataset(
      wrap("0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 WWW https://example.com/new\n"),
    );
    const { records, report } = mergeDecisions(master, compare, confirmed({ links: "both" }), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("1 _WEBTAG\n2 URL https://example.com/new");
    expect(out).not.toMatch(/^1 WWW/m);
    const change = report.changes.find((c) => c.links?.includes("https://example.com/new"));
    expect(change).toBeDefined();
    // Explicitly chosen "both" (kept alongside master's link) isn't a plain
    // incoming copy, so it should keep the normal "added" preview color.
    expect(change!.unedited).toBeFalsy();
  });

  it("adds a new incoming link as an OBJE/FILE record when the master uses that format", () => {
    const master = dataset(
      wrap(
        "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 OBJE @O3@\n" +
          "0 @O3@ OBJE\n1 FILE https://data.matricula-online.eu/sl/slovenia/ljubljana/kranj/01/\n1 FORM jpeg\n",
      ),
    );
    const compare = dataset(
      wrap("0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 WWW https://example.com/new\n"),
    );
    const { records, report } = mergeDecisions(master, compare, confirmed({ links: "both" }), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("1 OBJE @O4@");
    expect(out).toContain("0 @O4@ OBJE\n1 FILE https://example.com/new");
    expect(out).not.toMatch(/^1 WWW/m);
    expect(report.changes.some((c) => c.links?.includes("https://example.com/new"))).toBe(true);
  });

  it("adds an incoming record-level SOUR citation the master lacks (and imports the source)", () => {
    const master = dataset(MASTER);
    const compare = dataset(
      wrap(
        "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 SOUR @CS9@\n2 PAGE 12\n" +
          "0 @CS9@ SOUR\n1 TITL Rodbinska kronika\n",
      ),
    );
    const { records, report } = mergeDecisions(master, compare, confirmed(), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("1 SOUR @CS9@\n2 PAGE 12");
    expect(out).toContain("0 @CS9@ SOUR\n1 TITL Rodbinska kronika");
    expect(report.changes.some((c) => c.sources && c.sources.length > 0)).toBe(true);
  });

  it("attaches a same-book incoming link as a SOUR citation instead of a plain link", () => {
    const master = dataset(
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
    const { records, report } = mergeDecisions(master, compare, confirmed(), NO_MATCHES, tr);
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
  const masterFamily = wrap(
    "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @F1@\n" +
      "0 @F1@ FAM\n1 HUSB @I1@\n",
  );

  it("imports the SOUR record when a new child referencing it is added", () => {
    const master = dataset(masterFamily);
    const compare = dataset(compareWithSour);
    const matches = {
      individuals: [{ masterId: "@I1@", compareId: "@P1@" }],
    } as never;
    const decisions = new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: {}, takenChildren: ["@P4@"] }],
    ]);
    const { records } = mergeDecisions(master, compare, decisions, matches, tr);
    const out = serializeGedcom(records);
    // The new child carries a SOUR citation; the referenced SOUR record must
    // appear in the merged output.
    expect(out).toContain("1 SOUR @CS1@");
    expect(out).toContain("0 @CS1@ SOUR\n1 TITL Matična knjiga rojstev Kranj");
  });

  it("handles an xref collision: imports the compare SOUR under a fresh xref", () => {
    // Master already has @CS1@ pointing to a different source.
    const masterWithClash = wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @F1@\n" +
        "0 @F1@ FAM\n1 HUSB @I1@\n" +
        "0 @CS1@ SOUR\n1 TITL Župnijska matica — Domžale\n",
    );
    const master = dataset(masterWithClash);
    const compare = dataset(compareWithSour);
    const matches = {
      individuals: [{ masterId: "@I1@", compareId: "@P1@" }],
    } as never;
    const decisions = new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: {}, takenChildren: ["@P4@"] }],
    ]);
    const { records } = mergeDecisions(master, compare, decisions, matches, tr);
    const out = serializeGedcom(records);
    // Master's @CS1@ must be preserved unchanged.
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

  it("reuses an existing master SOUR for a compare source with the same content under a different xref", () => {
    // Master already cites this exact register, just under a different xref.
    const masterWithSameSource = wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @F1@\n" +
        "0 @F1@ FAM\n1 HUSB @I1@\n" +
        "0 @S9@ SOUR\n1 TITL Matična knjiga rojstev Kranj\n1 AUTH Župnija Kranj\n",
    );
    const master = dataset(masterWithSameSource);
    const compare = dataset(compareWithSour); // compare's @CS1@ has the same TITL/AUTH
    const matches = {
      individuals: [{ masterId: "@I1@", compareId: "@P1@" }],
    } as never;
    const decisions = new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: {}, takenChildren: ["@P4@"] }],
    ]);
    const { records } = mergeDecisions(master, compare, decisions, matches, tr);
    const out = serializeGedcom(records);
    // No new SOUR record was minted — the import reused master's existing @S9@.
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
    const master = dataset(masterFamily);
    const compare = dataset(compareWithRepo);
    const matches = {
      individuals: [{ masterId: "@I1@", compareId: "@P1@" }],
    } as never;
    const decisions = new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: {}, takenChildren: ["@P4@"] }],
    ]);
    const { records } = mergeDecisions(master, compare, decisions, matches, tr);
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
    const masterFamily = wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @F1@\n0 @F1@ FAM\n1 HUSB @I1@\n",
    );
    const master = dataset(masterFamily);
    const compare = dataset(compareWithSour);
    const matches = { individuals: [{ masterId: "@I1@", compareId: "@P1@" }] } as never;
    const decisions = new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: {}, takenChildren: ["@P4@"] }],
    ]);
    const { records, report } = mergeDecisions(master, compare, decisions, matches, tr);
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

  it("does not flag a custom tag that already existed in the master file", () => {
    // @CS1@ is already present in master (with _ITALIC); the merge only adds
    // a citation pointer to it, so its pre-existing _ITALIC isn't "copied in".
    const masterWithSour = wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n1 SOUR @CS1@\n" +
        "0 @CS1@ SOUR\n1 TITL Matična knjiga rojstev Kranj\n1 _ITALIC Y\n",
    );
    const compareWithBirt = wrap(
      "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n2 PLAC Kranj\n",
    );
    const master = dataset(masterWithSour);
    const compare = dataset(compareWithBirt);
    const matches = { individuals: [{ masterId: "@I1@", compareId: "@P1@" }] } as never;
    const decisions = new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: { "BIRT.place": "incoming" } }],
    ]);
    const { report } = mergeDecisions(master, compare, decisions, matches, tr);
    expect(report.customTags).toEqual({});
  });
});

describe("mergeDecisions — event source citations", () => {
  // Master's BIRT has no citation; incoming's does.
  const masterNoSour = wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n");
  const compareWithSour = wrap(
    "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n2 SOUR Birth register p.42\n",
  );

  it("fills in a missing citation by default", () => {
    const master = dataset(masterNoSour);
    const compare = dataset(compareWithSour);
    const { records } = mergeDecisions(master, compare, confirmed(), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("1 BIRT\n2 DATE 1850\n2 SOUR Birth register p.42");
  });

  it("leaves a conflicting citation on master unless explicitly chosen", () => {
    const masterWithOwnSour = wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n2 SOUR Krstna knjiga\n",
    );
    const master = dataset(masterWithOwnSour);
    const compare = dataset(compareWithSour);
    const { records } = mergeDecisions(master, compare, confirmed(), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("2 SOUR Krstna knjiga");
    expect(out).not.toContain("Birth register p.42");
  });

  it("replaces master's citation when incoming is chosen", () => {
    const masterWithOwnSour = wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n2 SOUR Krstna knjiga\n",
    );
    const master = dataset(masterWithOwnSour);
    const compare = dataset(compareWithSour);
    const { records } = mergeDecisions(master, compare, confirmed({ "BIRT.sources": "incoming" }), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("2 SOUR Birth register p.42");
    expect(out).not.toContain("Krstna knjiga");
  });

  it("keeps both citations when both is chosen", () => {
    const masterWithOwnSour = wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n2 SOUR Krstna knjiga\n",
    );
    const master = dataset(masterWithOwnSour);
    const compare = dataset(compareWithSour);
    const { records } = mergeDecisions(master, compare, confirmed({ "BIRT.sources": "both" }), NO_MATCHES, tr);
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
    const master = dataset(masterNoSour);
    const compare = dataset(compareWithLink);
    const { records } = mergeDecisions(master, compare, confirmed(), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("1 BIRT\n2 DATE 1850\n2 WWW https://example.com/birth");
  });

  it("leaves master's own event link alone unless explicitly chosen", () => {
    const masterWithOwnLink = wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n2 WWW https://example.com/old\n",
    );
    const master = dataset(masterWithOwnLink);
    const compare = dataset(compareWithLink);
    const { records } = mergeDecisions(master, compare, confirmed(), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("2 WWW https://example.com/old");
    expect(out).not.toContain("https://example.com/birth");
  });

  it("keeps both event links when both is chosen", () => {
    const masterWithOwnLink = wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n2 WWW https://example.com/old\n",
    );
    const master = dataset(masterWithOwnLink);
    const compare = dataset(compareWithLink);
    const { records } = mergeDecisions(master, compare, confirmed({ "BIRT.sources": "both" }), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("2 WWW https://example.com/old");
    expect(out).toContain("2 WWW https://example.com/birth");
  });

  it("doesn't duplicate an incoming event link the master already has", () => {
    const masterWithSameLink = wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n2 WWW https://example.com/birth\n",
    );
    const master = dataset(masterWithSameLink);
    const compare = dataset(compareWithLink);
    const { records } = mergeDecisions(master, compare, confirmed({ "BIRT.sources": "both" }), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out.match(/2 WWW/g)).toHaveLength(1);
  });

  it("attaches a same-book event link as a SOUR citation instead of a plain link (e.g. a marriage record's Matricula link)", () => {
    const master = dataset(
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
    const matches = { individuals: [{ masterId: "@I1@", compareId: "@P1@" }] } as never;
    const decisions = new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: { "fam.@G1@.MARR.sources": "both" } }],
    ]);
    const { records } = mergeDecisions(master, compare, decisions, matches, tr);
    const out = serializeGedcom(records);
    expect(out).not.toMatch(/^2 WWW/m);
    expect(out).toContain("2 SOUR @S1@\n3 PAGE 58");
    expect(out).toContain("1 FILE https://data.matricula-online.eu/de/slovenia/ljubljana/sencur/03173/?pg=58");
    expect(out.match(/0 @S\d+@ SOUR/g)).toHaveLength(1);
  });
});

describe("mergeDecisions — multi-instance events pair master/incoming by their own array position", () => {
  // Two RESI events each side, deliberately listed in reversed chronological
  // order on the incoming side so the best-scoring (date+place) pairing is
  // {masterIdx:0,compareIdx:1} and {masterIdx:1,compareIdx:0} — i.e. for at
  // least one pair, masterIdx and compareIdx differ. A row's incoming side
  // must be read from `compareIdx`, not from whatever sequential "keyIdx"
  // happens to label the row, or it ends up reading the *other* incoming event.
  const masterTwoResi = wrap(
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
    const master = dataset(masterTwoResi);
    const compare = dataset(compareTwoResiReversed);
    const { records } = mergeDecisions(
      master,
      compare,
      confirmed({ "RESI.0.agency": "incoming", "RESI.1.agency": "incoming" }),
      NO_MATCHES,
      tr,
    );
    const out = serializeGedcom(records);
    expect(out).toContain("1 RESI\n2 DATE 1990\n2 PLAC Kranj\n2 AGNC Agency-Kranj-incoming");
    expect(out).toContain("1 RESI\n2 DATE 2000\n2 PLAC Ljubljana\n2 AGNC Agency-Ljubljana-incoming");
  });

  // An incoming-only third RESI (no master counterpart at all) must still get
  // every one of its fields combined onto one new node, not scattered across
  // several — exercising the masterIdx===-1 "create once, reuse" path.
  const compareThreeResi = wrap(
    "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n" +
      "1 RESI\n2 DATE 2000\n2 PLAC Ljubljana\n2 AGNC Agency-Ljubljana-incoming\n" +
      "1 RESI\n2 DATE 1990\n2 PLAC Kranj\n2 AGNC Agency-Kranj-incoming\n" +
      "1 RESI\n2 DATE 1985\n2 PLAC Maribor\n2 ADDR Glavni trg 1\n2 AGNC Agency-Maribor-incoming\n",
  );

  it("combines a brand-new incoming-only event's fields onto a single node", () => {
    const master = dataset(masterTwoResi);
    const compare = dataset(compareThreeResi);
    const { records } = mergeDecisions(master, compare, confirmed(), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("2 PLAC Maribor");
    expect(out).toContain("2 ADDR Glavni trg 1");
    expect(out).toContain("2 AGNC Agency-Maribor-incoming");
    // All three landed on one event, not split across separate ones.
    const maribor = out.split("1 RESI").find((block) => block.includes("Maribor"))!;
    expect(maribor).toContain("Glavni trg 1");
    expect(maribor).toContain("Agency-Maribor-incoming");
    expect(out.match(/1 RESI/g)).toHaveLength(3); // 2 master + 1 new, none duplicated
  });
});

describe("mergeDecisions — preview groups a new event's sub-field changes into one line", () => {
  // Master has no OCCU at all; incoming adds one with both a value and a date.
  // Before the fix, applyRows pushed one FieldChange per sub-field ("Date",
  // "Occupation") under the same group, so the preview showed two lines under
  // one header instead of a single "Occupation: + value · date" line.
  const masterNoOccu = wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n");
  const compareNewOccu = wrap(
    "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 OCCU šivilja v pokoju\n2 DATE 1998\n",
  );

  it("combines the new event's date+value into a single FieldChange row", () => {
    const master = dataset(masterNoOccu);
    const compare = dataset(compareNewOccu);
    const { report } = mergeDecisions(master, compare, confirmed(), NO_MATCHES, tr);
    const occuChanges = report.changes.filter((c) => c.group === "event.OCCU");
    expect(occuChanges).toHaveLength(1);
    expect(occuChanges[0].to).toBe("šivilja v pokoju · 1998");
    // Default-filled from incoming (master had nothing to begin with), not
    // something the user typed or combined — preview should color it as such.
    expect(occuChanges[0].unedited).toBe(true);
  });
});

describe("mergeDecisions — rejectedEvents keeps a deleted master event from being re-added from incoming", () => {
  // Master and incoming both originally had this OCCU (an "agree" pair, so it
  // never showed as a merge suggestion) — then the user deleted master's copy.
  // Without an explicit rejection, the now-unmatched incoming copy looks like
  // ordinary new data and gets filled back in.
  const masterNoOccu = wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n");
  const compareWithOccu = wrap(
    "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n" +
      "1 OCCU VP Technology\n2 DATE FROM 2011 TO 2018\n",
  );

  it("re-adds the incoming event by default (no rejection recorded)", () => {
    const master = dataset(masterNoOccu);
    const compare = dataset(compareWithOccu);
    const { records } = mergeDecisions(master, compare, confirmed(), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("1 OCCU VP Technology");
  });

  it("never re-adds it once the incoming event is recorded as rejected", () => {
    const master = dataset(masterNoOccu);
    const compare = dataset(compareWithOccu);
    const decisions = confirmed();
    decisions.set(decisionKey("individual", "@I1@", "@P1@"), {
      status: "confirmed",
      fields: {},
      rejectedEvents: ["OCCU:0"],
    });
    const { records } = mergeDecisions(master, compare, decisions, NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).not.toContain("OCCU");
  });
});

describe("mergeDecisions — new sub-fields land before trailing CHAN/CREA", () => {
  // Master's RESI already has its own CHAN/CREA audit timestamps, typical of
  // exports from RootsMagic/Family Historian/etc. The incoming side adds an
  // ADDR that master is missing.
  const masterWithAudit = wrap(
    "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n" +
      "1 RESI\n2 DATE 1900\n2 PLAC Kranj\n2 CHAN\n3 DATE 17 NOV 2025\n2 CREA\n3 DATE 09 JUL 2025\n",
  );
  const compareWithAddr = wrap(
    "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 RESI\n2 DATE 1900\n2 PLAC Kranj\n2 ADDR Main St.\n",
  );

  it("inserts a new ADDR before CHAN/CREA, not after", () => {
    const master = dataset(masterWithAudit);
    const compare = dataset(compareWithAddr);
    const { records } = mergeDecisions(master, compare, confirmed(), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("2 PLAC Kranj\n2 ADDR Main St.\n2 CHAN");
    expect(out).not.toContain("2 CREA\n3 DATE 09 JUL 2025\n2 ADDR");
  });

  it("inserts a brand-new NOTE before CHAN/CREA on an event the master already has", () => {
    const master = dataset(masterWithAudit);
    const compare = dataset(
      wrap(
        "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 RESI\n2 DATE 1900\n2 PLAC Kranj\n2 NOTE Family home\n",
      ),
    );
    const { records } = mergeDecisions(master, compare, confirmed(), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("2 NOTE Family home\n2 CHAN");
    expect(out).not.toContain("2 CREA\n3 DATE 09 JUL 2025\n2 NOTE");
  });
});

describe("mergeDecisions — ASSO is not swept into event-date sorting", () => {
  // Master has an ASSO (association to another individual) sitting between
  // BIRT and DEAT, with its own DATE (a validity period, not an event date)
  // that falls outside the BIRT..DEAT range.
  const masterWithAsso = wrap(
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
    const master = dataset(masterWithAsso);
    const compare = dataset(compareFillsBirthPlace);
    const before = serializeGedcom(master.records);
    const { records } = mergeDecisions(master, compare, confirmed(), NO_MATCHES, tr);
    const after = serializeGedcom(records);

    const diff = lineDiff(before, after);
    expect(diff.added).toEqual(["2 PLAC Kranj"]);
    expect(diff.removed).toEqual([]);
    // ASSO stays between BIRT and DEAT, not pushed past DEAT by date sort.
    expect(after).toContain("1 ASSO @I2@\n2 ROLE OTHER\n2 DATE 1979\n1 DEAT");
  });
});

describe("mergeDecisions — CHAN/CREA are not swept into event-date sorting", () => {
  // Master has trailing top-level CHAN/CREA audit timestamps (last-change/
  // creation dates, typical of MyHeritage/Gramps exports) with CHAN's date
  // later than CREA's. Their DATE children must not make them look like
  // datable events: that would both reorder CHAN/CREA relative to each other
  // (sorted by date) and risk sandwiching a real new event between them.
  const masterWithAudit = wrap(
    "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n" +
      "1 CHAN\n2 DATE 17 NOV 2025\n1 CREA\n2 DATE 09 JUL 2025\n",
  );
  const compareAddsResi = wrap(
    "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n" +
      "1 RESI\n2 DATE 1900\n2 PLAC Kranj\n",
  );

  it("keeps CHAN before CREA and lands the new event before both", () => {
    const master = dataset(masterWithAudit);
    const compare = dataset(compareAddsResi);
    const { records } = mergeDecisions(master, compare, confirmed(), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("1 RESI\n2 DATE 1900\n2 PLAC Kranj\n1 CHAN\n2 DATE 17 NOV 2025\n1 CREA\n2 DATE 09 JUL 2025\n");
  });
});

describe("materializeEventSources", () => {
  // Mirrors Edit mode: a direct field edit on an "extra" incoming-only BAPM
  // row materializes a bare master event node (date/place only, no SOUR yet)
  // — see EditView's `setEventField` call for an "extra" row.
  const compareWithSour = wrap(
    "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n" +
      "1 BAPM\n2 DATE 1850\n2 PLAC Kranj\n2 SOUR @CS1@\n2 PAGE 12\n" +
      "0 @CS1@ SOUR\n1 TITL Matična knjiga krstov Kranj\n",
  );
  const master = wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n");

  it("copies the incoming event's SOUR citation onto the new master event and imports the cited SOUR record", () => {
    const masterDs = dataset(master);
    const compareDs = dataset(compareWithSour);
    const eventNode: GedNode = { level: 1, tag: "BAPM", children: [{ level: 2, tag: "DATE", value: "1850", children: [] }] };
    // Mirrors `setEventField` inserting the new event into the live master record.
    masterDs.records.find((r) => r.xref === "@I1@")!.children.push(eventNode);
    const incomingEvent = compareDs.individuals.get("@P1@")!.raw.children.find((c) => c.tag === "BAPM")!;

    const imported = materializeEventSources(masterDs, compareDs, eventNode, incomingEvent);

    expect(eventNode.children.some((c) => c.tag === "SOUR" && c.value === "@CS1@")).toBe(true);
    expect(masterDs.records.some((r) => r.tag === "SOUR" && r.xref === "@CS1@")).toBe(true);
    expect(imported).toHaveLength(1);
    expect(imported[0].xref).toBe("@CS1@");
  });

  it("remaps the cited SOUR to a fresh xref when it collides with an unrelated master record", () => {
    const masterWithClash = wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n0 @CS1@ SOUR\n1 TITL Unrelated source\n",
    );
    const masterDs = dataset(masterWithClash);
    const compareDs = dataset(compareWithSour);
    const eventNode: GedNode = { level: 1, tag: "BAPM", children: [] };
    masterDs.records.find((r) => r.xref === "@I1@")!.children.push(eventNode);
    const incomingEvent = compareDs.individuals.get("@P1@")!.raw.children.find((c) => c.tag === "BAPM")!;

    const imported = materializeEventSources(masterDs, compareDs, eventNode, incomingEvent);

    const citation = eventNode.children.find((c) => c.tag === "SOUR");
    expect(citation?.value).not.toBe("@CS1@");
    expect(imported).toHaveLength(1);
    expect(imported[0].xref).toBe(citation?.value);
    expect(imported[0].children.some((c) => c.tag === "TITL" && c.value === "Matična knjiga krstov Kranj")).toBe(true);
    // Master's own unrelated @CS1@ stays untouched.
    expect(masterDs.records.find((r) => r.xref === "@CS1@")?.children[0]?.value).toBe("Unrelated source");
  });

  it("returns an empty array and does nothing when the incoming event has no SOUR", () => {
    const masterDs = dataset(master);
    const compareDs = dataset(wrap("0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BAPM\n2 DATE 1850\n"));
    const eventNode: GedNode = { level: 1, tag: "BAPM", children: [] };
    const incomingEvent = compareDs.individuals.get("@P1@")!.raw.children.find((c) => c.tag === "BAPM")!;

    const imported = materializeEventSources(masterDs, compareDs, eventNode, incomingEvent);

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
    const master = dataset(text);
    const compare = dataset(text.replace(/@I1@/g, "@P1@"));
    const { records, report } = mergeDecisions(master, compare, confirmed(), NO_MATCHES, tr);
    expect(report.changes).toHaveLength(0);
    expect(serializeGedcom(records)).toBe(text);
  });
});

describe("mergeDecisions — pointers on a newly added person", () => {
  // Master @I1@ matches compare @P1@; taking the partner brings in @P2@, who
  // carries pointer-valued tags into the compare file's xref namespace.
  const masterBase =
    "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n" +
    "0 @I9@ INDI\n1 NAME Franc /Zupan/\n1 SEX M\n";
  const matches = { individuals: [{ masterId: "@I1@", compareId: "@P1@" }] } as never;
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
    // Master's @N1@ is an unrelated note; the new person must not point at it.
    const master = dataset(wrap(masterBase + "0 @N1@ NOTE Master note about someone else\n"));
    const compare = dataset(
      compareWith("1 NOTE @N1@\n", "0 @N1@ NOTE Compare note about Marija\n"),
    );
    const { records } = mergeDecisions(master, compare, takePartner(), matches, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("0 @N1@ NOTE Master note about someone else"); // untouched
    const noteXref = out.match(/1 NAME Marija \/Kovač\/[\s\S]*?1 NOTE (@[^@]+@)/)?.[1];
    expect(noteXref).toBeDefined();
    expect(noteXref).not.toBe("@N1@");
    expect(out).toContain(`0 ${noteXref} NOTE Compare note about Marija`);
  });

  it("reuses an existing master NOTE record with identical text", () => {
    const master = dataset(wrap(masterBase + "0 @N7@ NOTE Shared family chronicle\n"));
    const compare = dataset(
      compareWith("1 NOTE @N1@\n", "0 @N1@ NOTE Shared family chronicle\n"),
    );
    const { records } = mergeDecisions(master, compare, takePartner(), matches, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("1 NOTE @N7@");
    expect(out.match(/0 @[^@]+@ NOTE/g)).toHaveLength(1); // no duplicate minted
  });

  it("imports the OBJE record a new person's OBJE pointer references", () => {
    const master = dataset(wrap(masterBase));
    const compare = dataset(
      compareWith("1 OBJE @O7@\n", "0 @O7@ OBJE\n1 FILE https://example.com/marija.jpg\n"),
    );
    const { records } = mergeDecisions(master, compare, takePartner(), matches, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("1 OBJE @O7@");
    expect(out).toContain("0 @O7@ OBJE\n1 FILE https://example.com/marija.jpg");
  });

  it("strips ASSO/ALIA and nested family pointers, reporting associations as deferred", () => {
    const master = dataset(wrap(masterBase));
    const compare = dataset(
      compareWith(
        // ASSO @I9@ means the compare's own @I9@ (a different person than the
        // master's @I9@ Franc Zupan); ADOP carries an event-level FAMC.
        "1 ASSO @I9@\n2 ROLE GODP\n1 ALIA @P1@\n1 ADOP\n2 FAMC @PF@\n" +
          "0 @I9@ INDI\n1 NAME Peter /Drugi/\n1 SEX M\n",
      ),
    );
    const { records, report } = mergeDecisions(master, compare, takePartner(), matches, tr);
    const out = serializeGedcom(records);
    expect(out).not.toContain("1 ASSO");
    expect(out).not.toContain("1 ALIA");
    expect(out).not.toContain("2 FAMC"); // ADOP's event-level family pointer
    expect(out).toContain("1 ADOP"); // the event itself survives
    expect(report.deferred.some((d) => d.field === "merge.field.associations")).toBe(true);
  });
});

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
