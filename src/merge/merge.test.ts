import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import { decisionKey, type CandidateDecision } from "../review/types";
import { mergeDecisions } from "./merge";

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
    expect(report.changes.some((c) => c.to === "Kranj")).toBe(true);
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

describe("mergeDecisions — place reshaping to a structured-addr master", () => {
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

  it("splits the packed place into PLAC, ADDR and a NOTE", () => {
    const { records } = mergeDecisions(master, compare, confirmed(), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain(
      "1 BIRT\n2 DATE 1850\n2 PLAC Kranj,Slovenija\n2 ADDR Kidričeva 38/a\n2 NOTE porodnišnica",
    );
    // The raw packed string must not survive in the output.
    expect(out).not.toContain("(porodnišnica)");
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

  // Confirming the husband stitches in his whole family from the incoming side.
  const decisions = new Map<string, CandidateDecision>([
    [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: {} }],
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
    expect(out).toMatch(/0 @F\d+@ FAM\n1 CHIL @I1@\n1 HUSB @I2@\n1 WIFE @I3@/);
    expect(out).toContain("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMC @");
    expect(out).toContain("0 @I2@ INDI\n1 NAME Jakob /Novak/\n1 SEX M\n1 FAMS @");
  });

  it("adds a new partner as a couple family with a new person record", () => {
    expect(out).toContain("0 @I4@ INDI\n1 NAME Ana /Horvat/"); // new spouse added
    // A couple family pairing @I1@ (husband) with the new wife @I4@.
    expect(out).toMatch(/0 @F\d+@ FAM\n1 HUSB @I1@\n1 WIFE @I4@/);
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
    expect(report.changes.some((c) => c.to === "https://example.com/new")).toBe(true);
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

  it("rewrites a new Matricula link to the language code the master already uses", () => {
    const master = dataset(
      wrap(
        "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n" +
          "1 WWW https://data.matricula-online.eu/sl/slovenia/ljubljana/kranj/01/\n",
      ),
    );
    const compare = dataset(
      wrap(
        "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n" +
          "1 WWW https://data.matricula-online.eu/de/slovenia/ljubljana/preddvor/04120/?pg=56\n",
      ),
    );
    const { records } = mergeDecisions(master, compare, confirmed({ links: "both" }), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("1 WWW https://data.matricula-online.eu/sl/slovenia/ljubljana/preddvor/04120/?pg=56");
    expect(out).not.toContain("/de/slovenia/ljubljana/preddvor");
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
