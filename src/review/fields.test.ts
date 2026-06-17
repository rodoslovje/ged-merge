import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { fieldDiffCounts, individualFieldRows } from "./fields";
import type { FieldRow } from "./types";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

function byKey(rows: FieldRow[], key: string): FieldRow | undefined {
  return rows.find((r) => r.key === key);
}

/** Identity translator: tests assert on keys/states, not localized labels. */
const tr = (key: string) => key;

const MASTER = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 NAME Johann /Müller/
1 SEX M
1 BIRT
2 DATE 12 JAN 1850
2 PLAC Wien, Österreich
1 DEAT
2 DATE 1910
0 @F1@ FAM
1 HUSB @I1@
1 MARR
2 DATE 1875
0 TRLR
`;

const COMPARE = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @P1@ INDI
1 NAME Johann /Mueller/
1 SEX M
1 BIRT
2 DATE 12 JAN 1850
2 PLAC Wien
0 @G1@ FAM
1 HUSB @P1@
1 MARR
2 DATE 1875
2 PLAC Graz
0 TRLR
`;

describe("individualFieldRows", () => {
  const m = dataset(MASTER);
  const c = dataset(COMPARE);
  const rows = individualFieldRows(tr, m.individuals.get("@I1@"), c.individuals.get("@P1@"));

  it("marks agreeing fields", () => {
    expect(byKey(rows, "given")?.state).toBe("agree"); // Johann = Johann
    expect(byKey(rows, "sex")?.state).toBe("agree");
    expect(byKey(rows, "BIRT.date")?.state).toBe("agree");
  });

  it("marks conflicting fields", () => {
    // Surname Müller vs Mueller differs after diacritic fold.
    expect(byKey(rows, "surname")?.state).toBe("conflict");
    // Birth place Wien, Österreich vs Wien differs.
    expect(byKey(rows, "BIRT.place")?.state).toBe("conflict");
  });

  it("marks master-only fields and omits empties", () => {
    expect(byKey(rows, "DEAT.date")?.state).toBe("master-only");
    expect(byKey(rows, "DEAT.place")).toBeUndefined(); // neither has it
  });

  it("treats date qualifier spelling variants as agreement", () => {
    const a = dataset(`0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n1 BIRT\n2 DATE Abt. 1900\n0 TRLR\n`);
    const b = dataset(`0 HEAD\n0 @P1@ INDI\n1 NAME A /B/\n1 BIRT\n2 DATE ABT 1900\n0 TRLR\n`);
    const r = individualFieldRows(tr, a.individuals.get("@I1@"), b.individuals.get("@P1@"));
    expect(byKey(r, "BIRT.date")?.state).toBe("agree");
  });

  it("still distinguishes exact from approximate dates", () => {
    const a = dataset(`0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n1 BIRT\n2 DATE 1900\n0 TRLR\n`);
    const b = dataset(`0 HEAD\n0 @P1@ INDI\n1 NAME A /B/\n1 BIRT\n2 DATE ABT 1900\n0 TRLR\n`);
    const r = individualFieldRows(tr, a.individuals.get("@I1@"), b.individuals.get("@P1@"));
    expect(byKey(r, "BIRT.date")?.state).toBe("conflict");
  });

  it("treats spacing-only differences as agreement", () => {
    const a = dataset(
      `0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n1 BIRT\n2 PLAC Wien, Österreich\n0 TRLR\n`,
    );
    const b = dataset(
      `0 HEAD\n0 @P1@ INDI\n1 NAME A /B/\n1 BIRT\n2 PLAC Wien,Österreich\n0 TRLR\n`,
    );
    const r = individualFieldRows(tr, a.individuals.get("@I1@"), b.individuals.get("@P1@"));
    expect(byKey(r, "BIRT.place")?.state).toBe("agree");
  });

  it("treats country-name variants as agreement for places", () => {
    const plac = (p: string, id: string) =>
      dataset(`0 HEAD\n0 ${id} INDI\n1 NAME A /B/\n1 BIRT\n2 PLAC ${p}\n0 TRLR\n`);
    const rows = (pm: string, pi: string) =>
      individualFieldRows(tr,
        plac(pm, "@I1@").individuals.get("@I1@"),
        plac(pi, "@P1@").individuals.get("@P1@"),
      );

    expect(byKey(rows("Ljubljana, Slovenija", "Ljubljana, Slovenia"), "BIRT.place")?.state).toBe(
      "agree",
    );
    expect(byKey(rows("Wien, Österreich", "Wien, Austria"), "BIRT.place")?.state).toBe("agree");
    // Different city must still be a conflict, not masked by country aliasing.
    expect(byKey(rows("Maribor, Slovenija", "Ljubljana, Slovenia"), "BIRT.place")?.state).toBe(
      "conflict",
    );
  });

  it("ignores repeated (excessive) place parts", () => {
    const plac = (p: string, id: string) =>
      dataset(`0 HEAD\n0 ${id} INDI\n1 NAME A /B/\n1 BIRT\n2 PLAC ${p}\n0 TRLR\n`);
    const rows = individualFieldRows(tr,
      plac("Kranj, Kranj, Slovenia", "@I1@").individuals.get("@I1@"),
      plac("Kranj, Slovenia", "@P1@").individuals.get("@P1@"),
    );
    expect(byKey(rows, "BIRT.place")?.state).toBe("agree");
  });
});

describe("individual parents and partners rows", () => {
  const masterGed = `0 HEAD
0 @C@ INDI
1 NAME Ana /Novak/
1 SEX F
1 FAMC @F1@
1 FAMS @F2@
0 @FA@ INDI
1 NAME Janez /Novak/
1 SEX M
0 @MO@ INDI
1 NAME Marija /Kos/
1 SEX F
0 @SP@ INDI
1 NAME Tone /Horvat/
1 SEX M
0 @F1@ FAM
1 HUSB @FA@
1 WIFE @MO@
1 CHIL @C@
0 @F2@ FAM
1 HUSB @SP@
1 WIFE @C@
0 TRLR
`;
  // Same person, but the compare file is missing the mother.
  const compareGed = `0 HEAD
0 @C@ INDI
1 NAME Ana /Novak/
1 SEX F
1 FAMC @F1@
1 FAMS @F2@
0 @FA@ INDI
1 NAME Janez /Novak/
1 SEX M
0 @SP@ INDI
1 NAME Tone /Horvat/
1 SEX M
0 @F1@ FAM
1 HUSB @FA@
1 CHIL @C@
0 @F2@ FAM
1 HUSB @SP@
1 WIFE @C@
0 TRLR
`;

  it("shows father/mother/partner rows resolved through the family graph", () => {
    const m = dataset(masterGed);
    const c = dataset(compareGed);
    const rows = individualFieldRows(tr,
      m.individuals.get("@C@"),
      c.individuals.get("@C@"),
      m,
      c,
    );
    expect(byKey(rows, "father")).toMatchObject({ master: "Janez Novak", state: "agree" });
    expect(byKey(rows, "mother")).toMatchObject({ master: "Marija Kos", state: "master-only" });
    expect(byKey(rows, "fam.@F2@.partner")).toMatchObject({ master: "Tone Horvat", state: "agree" });
  });

  it("omits relative rows when datasets are not supplied", () => {
    const m = dataset(masterGed);
    const rows = individualFieldRows(tr, m.individuals.get("@C@"), m.individuals.get("@C@"));
    expect(byKey(rows, "father")).toBeUndefined();
    expect(byKey(rows, "fam.@F2@.partner")).toBeUndefined();
  });
});

describe("fieldDiffCounts", () => {
  it("counts incoming-only (N) and conflicting (D) fields", () => {
    const m = dataset(
      `0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n1 BIRT\n2 DATE 1900\n2 PLAC Kranj\n0 TRLR\n`,
    );
    const c = dataset(
      `0 HEAD\n0 @P1@ INDI\n1 NAME A /B/\n1 BIRT\n2 DATE 1900\n2 PLAC Ljubljana\n1 DEAT\n2 DATE 1950\n0 TRLR\n`,
    );
    const rows = individualFieldRows(tr, m.individuals.get("@I1@"), c.individuals.get("@P1@"));
    // BIRT.place differs (D); DEAT.date is only in compare (N).
    expect(fieldDiffCounts(rows)).toEqual({ newCount: 1, diffCount: 1, linkCount: 0 });
  });

  it("reports zero for identical records", () => {
    const m = dataset(`0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n1 BIRT\n2 DATE 1900\n0 TRLR\n`);
    const rows = individualFieldRows(tr, m.individuals.get("@I1@"), m.individuals.get("@I1@"));
    expect(fieldDiffCounts(rows)).toEqual({ newCount: 0, diffCount: 0, linkCount: 0 });
  });
});

describe("event ordering", () => {
  it("sorts events chronologically across types", () => {
    // Master has RESI before BIRT in the file; sorted output must put BIRT first.
    const m = dataset(
      `0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n` +
      `1 RESI\n2 DATE 1 JAN 1974\n` +
      `1 BIRT\n2 DATE 1 JAN 1974\n` +
      `1 RESI\n2 DATE JUN 2014\n` +
      `0 TRLR\n`,
    );
    const rows = individualFieldRows(tr, m.individuals.get("@I1@"), undefined);
    const keys = rows.filter((r) => r.isGroupHeader && r.isEventHeader).map((r) => r.key);
    expect(keys.indexOf("BIRT.header")).toBeLessThan(keys.indexOf("RESI.1.header")); // Jun 2014 sorts last
    // The RESI from Jan 1974 shares the date with BIRT; BIRT precedes RESI in EVENT_ORDER.
    expect(keys.indexOf("BIRT.header")).toBeLessThan(keys.indexOf("RESI.0.header"));
  });

  it("uses compare date when master event has no date", () => {
    // Master has an undated RESI; compare's 1974 date should be used for sort order.
    const m = dataset(
      `0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n1 RESI\n1 BIRT\n2 DATE 1 JAN 1974\n0 TRLR\n`,
    );
    const c = dataset(
      `0 HEAD\n0 @P1@ INDI\n1 NAME A /B/\n1 RESI\n2 DATE 1900\n1 BIRT\n2 DATE 1 JAN 1974\n0 TRLR\n`,
    );
    const rows = individualFieldRows(tr, m.individuals.get("@I1@"), c.individuals.get("@P1@"));
    const keys = rows.filter((r) => r.isGroupHeader && r.isEventHeader).map((r) => r.key);
    // Compare's RESI is from 1900, so it should sort before BIRT 1974.
    expect(keys.indexOf("RESI.header")).toBeLessThan(keys.indexOf("BIRT.header"));
  });
});

describe("ADDR support", () => {
  const m = dataset(
    `0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n1 BIRT\n2 DATE 19 SEP 1917\n2 PLAC Zgornje Bitnje, Kranj, Slovenia\n2 ADDR Zgornje Bitnje 52 (pd Urbanov Jaka)\n0 TRLR\n`,
  );

  it("parses ADDR with a house-number detail", () => {
    const ev = m.individuals.get("@I1@")!.events.find((e) => e.tag === "BIRT")!;
    expect(ev.address?.raw).toBe("Zgornje Bitnje 52 (pd Urbanov Jaka)");
    expect(ev.address?.detail).toBe("52");
  });

  it("shows a birth address row and detects differing addresses", () => {
    const c = dataset(
      `0 HEAD\n0 @P1@ INDI\n1 NAME A /B/\n1 BIRT\n2 ADDR Zgornje Bitnje 54\n0 TRLR\n`,
    );
    const rows = individualFieldRows(tr, m.individuals.get("@I1@"), c.individuals.get("@P1@"));
    expect(byKey(rows, "BIRT.addr")?.state).toBe("conflict");
  });

  it("treats spacing-only address differences as agreement", () => {
    const c = dataset(
      `0 HEAD\n0 @P1@ INDI\n1 NAME A /B/\n1 BIRT\n2 ADDR Zgornje Bitnje 52  (pd Urbanov Jaka)\n0 TRLR\n`,
    );
    const rows = individualFieldRows(tr, m.individuals.get("@I1@"), c.individuals.get("@P1@"));
    expect(byKey(rows, "BIRT.addr")?.state).toBe("agree");
  });
});

describe("attached links", () => {
  it("extracts record-level and event links from an individual", () => {
    const ds = dataset(
      `0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n1 WWW https://example.com/a\n1 BIRT\n2 DATE 1900\n2 _LINK https://example.com/birth\n0 TRLR\n`,
    );
    const indi = ds.individuals.get("@I1@")!;
    expect(indi.links).toEqual(["https://example.com/a"]);
    expect(indi.events.find((e) => e.tag === "BIRT")?.links).toEqual([
      "https://example.com/birth",
    ]);
  });

  it("tallies an incoming-only link into linkCount, not newCount", () => {
    const m = dataset(`0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n1 BIRT\n2 DATE 1900\n0 TRLR\n`);
    const c = dataset(
      `0 HEAD\n0 @P1@ INDI\n1 NAME A /B/\n1 BIRT\n2 DATE 1900\n2 WWW https://example.com/birth\n0 TRLR\n`,
    );
    const rows = individualFieldRows(tr, m.individuals.get("@I1@"), c.individuals.get("@P1@"));
    // Event links appear as inline icons on the first subrow of the event.
    expect(byKey(rows, "links")).toBeUndefined(); // no record-level links
    expect(byKey(rows, "BIRT.links")).toBeUndefined(); // no separate links data row
    const birtDate = byKey(rows, "BIRT.date");
    expect(birtDate?.incomingLinkIcons).toEqual(["https://example.com/birth"]);
    expect(birtDate?.masterLinkIcons).toBeUndefined();
    expect(fieldDiffCounts(rows)).toEqual({ newCount: 0, diffCount: 0, linkCount: 1 });
  });

  it("tallies differing links into linkCount; matching links agree", () => {
    const m = dataset(
      `0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n1 WWW https://example.com/old\n0 TRLR\n`,
    );
    const c = dataset(
      `0 HEAD\n0 @P1@ INDI\n1 NAME A /B/\n1 WWW https://example.com/new\n0 TRLR\n`,
    );
    const rows = individualFieldRows(tr, m.individuals.get("@I1@"), c.individuals.get("@P1@"));
    expect(byKey(rows, "links")?.state).toBe("conflict");
    expect(fieldDiffCounts(rows)).toEqual({ newCount: 0, diffCount: 0, linkCount: 1 });

    const same = dataset(
      `0 HEAD\n0 @P1@ INDI\n1 NAME A /B/\n1 WWW https://example.com/old/\n0 TRLR\n`,
    );
    const rows2 = individualFieldRows(tr, m.individuals.get("@I1@"), same.individuals.get("@P1@"));
    expect(byKey(rows2, "links")?.state).toBe("agree"); // trailing-slash-insensitive
  });

  it("treats Matricula Online links as equal regardless of language code", () => {
    const m = dataset(
      `0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n` +
        `1 WWW https://data.matricula-online.eu/sl/slovenia/ljubljana/preddvor/04120/?pg=56\n0 TRLR\n`,
    );
    const c = dataset(
      `0 HEAD\n0 @P1@ INDI\n1 NAME A /B/\n` +
        `1 WWW https://data.matricula-online.eu/de/slovenia/ljubljana/preddvor/04120/?pg=56\n0 TRLR\n`,
    );
    const rows = individualFieldRows(tr, m.individuals.get("@I1@"), c.individuals.get("@P1@"));
    expect(byKey(rows, "links")?.state).toBe("agree");
    expect(fieldDiffCounts(rows)).toEqual({ newCount: 0, diffCount: 0, linkCount: 0 });
  });

  it("resolves shared OBJE multimedia pointers to their FILE url", () => {
    // Renko.ged stores links as top-level OBJE records referenced by pointer.
    const ds = dataset(
      `0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n1 OBJE @M1@\n1 BURI\n2 OBJE @M2@\n` +
        `0 @M1@ OBJE\n1 FILE https://example.com/portrait\n2 TITL Portrait\n` +
        `0 @M2@ OBJE\n1 FILE https://en.geneanet.org/cemetery/view/123/persons/\n0 TRLR\n`,
    );
    const indi = ds.individuals.get("@I1@")!;
    expect(indi.links).toEqual(["https://example.com/portrait"]);
    expect(indi.events.find((e) => e.tag === "BURI")?.links).toEqual([
      "https://en.geneanet.org/cemetery/view/123/persons/",
    ]);
  });

  it("de-duplicates a link attached both to the record and to an event", () => {
    const ds = dataset(
      `0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n1 WWW https://example.com/x\n` +
        `1 BIRT\n2 DATE 1900\n2 WWW https://example.com/x\n0 TRLR\n`,
    );
    const empty = dataset(`0 HEAD\n0 @P1@ INDI\n1 NAME A /B/\n0 TRLR\n`);
    const rows = individualFieldRows(tr, ds.individuals.get("@I1@"), empty.individuals.get("@P1@"));
    expect(byKey(rows, "links")?.masterLinks).toEqual(["https://example.com/x"]);
  });
});

describe("marriage rows on the spouse", () => {
  // A husband whose family carries the marriage; rows surface on the individual.
  const doc = (marr: string) =>
    `0 HEAD\n0 @H@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n1 FAMS @F@\n` +
    `0 @F@ FAM\n1 HUSB @H@\n1 MARR\n${marr}\n0 TRLR\n`;

  it("surfaces the marriage date/place as rows on the individual", () => {
    const m = dataset(doc("2 DATE 1875"));
    const c = dataset(doc("2 DATE 1875\n2 PLAC Graz"));
    const rows = individualFieldRows(tr, m.individuals.get("@H@"), c.individuals.get("@H@"), m, c);
    expect(byKey(rows, "fam.@F@.MARR.date")?.state).toBe("agree");
    expect(byKey(rows, "fam.@F@.MARR.place")?.state).toBe("incoming-only");
  });
});

describe("aligned relative lists (children/partners)", () => {
  // Master children: Anna, Berta. Incoming: Anna (match), Doris (new). Berta has
  // no incoming counterpart, Doris no master counterpart. Children surface on the
  // parent's individual row.
  const fam = (kids: string[]) =>
    `0 HEAD\n0 @H@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @F@\n` +
    kids.map((k, i) => `0 @K${i}@ INDI\n1 NAME ${k}\n1 FAMC @F@\n`).join("") +
    `0 @F@ FAM\n1 HUSB @H@\n` +
    kids.map((_, i) => `1 CHIL @K${i}@\n`).join("") +
    `0 TRLR\n`;

  const md = dataset(fam(["Anna /Novak/", "Berta /Novak/"]));
  const cd = dataset(fam(["Anna /Novak/", "Doris /Novak/"]));
  const rows = individualFieldRows(tr, md.individuals.get("@H@"), cd.individuals.get("@H@"), md, cd);
  const children = byKey(rows, "fam.@F@.children")!;

  it("aligns a matched child on the same line in both columns", () => {
    const m = children.master.split("\n");
    const i = children.incoming.split("\n");
    expect(m.length).toBe(i.length); // both columns have the same number of lines
    expect(m[0]).toContain("Anna");
    expect(i[0]).toContain("Anna"); // matched pair shares line 0
  });

  it("gives an unmatched child its own line with the other column blank", () => {
    const m = children.master.split("\n");
    const i = children.incoming.split("\n");
    // Berta is master-only; Doris is incoming-only — each on a line by itself.
    const bertaLine = m.findIndex((l) => l.includes("Berta"));
    const dorisLine = i.findIndex((l) => l.includes("Doris"));
    expect(i[bertaLine]).toBe(""); // nothing aligned opposite Berta
    expect(m[dorisLine]).toBe(""); // nothing aligned opposite Doris
    expect(children.state).toBe("conflict");
  });

  // Same-named siblings distinguished only by birth year: the incoming child
  // must align with the master sibling born the same year, not the first match.
  it("aligns same-named children by birth year", () => {
    const famB = (kids: { name: string; year: string }[]) =>
      `0 HEAD\n0 @H@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @F@\n` +
      kids
        .map((k, i) => `0 @K${i}@ INDI\n1 NAME ${k.name}\n1 BIRT\n2 DATE ${k.year}\n1 FAMC @F@\n`)
        .join("") +
      `0 @F@ FAM\n1 HUSB @H@\n` +
      kids.map((_, i) => `1 CHIL @K${i}@\n`).join("") +
      `0 TRLR\n`;

    const md = dataset(famB([{ name: "Janez /Novak/", year: "1850" }, { name: "Janez /Novak/", year: "1855" }]));
    const cd = dataset(famB([{ name: "Janez /Novak/", year: "1855" }]));
    const children = byKey(
      individualFieldRows(tr, md.individuals.get("@H@"), cd.individuals.get("@H@"), md, cd),
      "fam.@F@.children",
    )!;
    const m = children.master.split("\n");
    const i = children.incoming.split("\n");
    const line1855 = m.findIndex((l) => l.includes("1855"));
    const line1850 = m.findIndex((l) => l.includes("1850"));
    expect(i[line1855]).toContain("1855"); // incoming child pairs with the 1855 sibling
    expect(i[line1850]).toBe(""); // the 1850 sibling stays unmatched
  });

  // Children listed in non-chronological order in the file are shown sorted by birth.
  it("lists children sorted by birth date", () => {
    const text =
      `0 HEAD\n0 @H@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @F@\n` +
      `0 @K0@ INDI\n1 NAME Cilka /Novak/\n1 BIRT\n2 DATE 1860\n1 FAMC @F@\n` +
      `0 @K1@ INDI\n1 NAME Ana /Novak/\n1 BIRT\n2 DATE 1850\n1 FAMC @F@\n` +
      `0 @K2@ INDI\n1 NAME Berta /Novak/\n1 BIRT\n2 DATE 5 MAR 1855\n1 FAMC @F@\n` +
      `0 @F@ FAM\n1 HUSB @H@\n1 CHIL @K0@\n1 CHIL @K1@\n1 CHIL @K2@\n0 TRLR\n`;
    const ds = dataset(text);
    const children = byKey(individualFieldRows(tr, ds.individuals.get("@H@"), undefined, ds, ds), "fam.@F@.children")!;
    const lines = children.master.split("\n");
    expect(lines.map((l) => l.match(/Ana|Berta|Cilka/)?.[0])).toEqual(["Ana", "Berta", "Cilka"]);
  });
});
