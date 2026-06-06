import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { familyFieldRows, fieldDiffCounts, individualFieldRows } from "./fields";
import type { FieldRow } from "./types";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

function byKey(rows: FieldRow[], key: string): FieldRow | undefined {
  return rows.find((r) => r.key === key);
}

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
  const rows = individualFieldRows(m.individuals.get("@I1@"), c.individuals.get("@P1@"));

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
    const r = individualFieldRows(a.individuals.get("@I1@"), b.individuals.get("@P1@"));
    expect(byKey(r, "BIRT.date")?.state).toBe("agree");
  });

  it("still distinguishes exact from approximate dates", () => {
    const a = dataset(`0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n1 BIRT\n2 DATE 1900\n0 TRLR\n`);
    const b = dataset(`0 HEAD\n0 @P1@ INDI\n1 NAME A /B/\n1 BIRT\n2 DATE ABT 1900\n0 TRLR\n`);
    const r = individualFieldRows(a.individuals.get("@I1@"), b.individuals.get("@P1@"));
    expect(byKey(r, "BIRT.date")?.state).toBe("conflict");
  });

  it("treats spacing-only differences as agreement", () => {
    const a = dataset(
      `0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n1 BIRT\n2 PLAC Wien, Österreich\n0 TRLR\n`,
    );
    const b = dataset(
      `0 HEAD\n0 @P1@ INDI\n1 NAME A /B/\n1 BIRT\n2 PLAC Wien,Österreich\n0 TRLR\n`,
    );
    const r = individualFieldRows(a.individuals.get("@I1@"), b.individuals.get("@P1@"));
    expect(byKey(r, "BIRT.place")?.state).toBe("agree");
  });

  it("treats country-name variants as agreement for places", () => {
    const plac = (p: string, id: string) =>
      dataset(`0 HEAD\n0 ${id} INDI\n1 NAME A /B/\n1 BIRT\n2 PLAC ${p}\n0 TRLR\n`);
    const rows = (pm: string, pi: string) =>
      individualFieldRows(
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
    const rows = individualFieldRows(
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
    const rows = individualFieldRows(
      m.individuals.get("@C@"),
      c.individuals.get("@C@"),
      m,
      c,
    );
    expect(byKey(rows, "father")).toMatchObject({ master: "Janez Novak", state: "agree" });
    expect(byKey(rows, "mother")).toMatchObject({ master: "Marija Kos", state: "master-only" });
    expect(byKey(rows, "partners")).toMatchObject({ master: "Tone Horvat", state: "agree" });
  });

  it("omits relative rows when datasets are not supplied", () => {
    const m = dataset(masterGed);
    const rows = individualFieldRows(m.individuals.get("@C@"), m.individuals.get("@C@"));
    expect(byKey(rows, "father")).toBeUndefined();
    expect(byKey(rows, "partners")).toBeUndefined();
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
    const rows = individualFieldRows(m.individuals.get("@I1@"), c.individuals.get("@P1@"));
    // BIRT.place differs (D); DEAT.date is only in compare (N).
    expect(fieldDiffCounts(rows)).toEqual({ newCount: 1, diffCount: 1, linkCount: 0 });
  });

  it("reports zero for identical records", () => {
    const m = dataset(`0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n1 BIRT\n2 DATE 1900\n0 TRLR\n`);
    const rows = individualFieldRows(m.individuals.get("@I1@"), m.individuals.get("@I1@"));
    expect(fieldDiffCounts(rows)).toEqual({ newCount: 0, diffCount: 0, linkCount: 0 });
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
    const rows = individualFieldRows(m.individuals.get("@I1@"), c.individuals.get("@P1@"));
    expect(byKey(rows, "BIRT.addr")?.state).toBe("conflict");
  });

  it("treats spacing-only address differences as agreement", () => {
    const c = dataset(
      `0 HEAD\n0 @P1@ INDI\n1 NAME A /B/\n1 BIRT\n2 ADDR Zgornje Bitnje 52  (pd Urbanov Jaka)\n0 TRLR\n`,
    );
    const rows = individualFieldRows(m.individuals.get("@I1@"), c.individuals.get("@P1@"));
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
    const rows = individualFieldRows(m.individuals.get("@I1@"), c.individuals.get("@P1@"));
    expect(byKey(rows, "BIRT.links")?.state).toBe("incoming-only");
    expect(fieldDiffCounts(rows)).toEqual({ newCount: 0, diffCount: 0, linkCount: 1 });
  });

  it("tallies differing links into linkCount; matching links agree", () => {
    const m = dataset(
      `0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n1 WWW https://example.com/old\n0 TRLR\n`,
    );
    const c = dataset(
      `0 HEAD\n0 @P1@ INDI\n1 NAME A /B/\n1 WWW https://example.com/new\n0 TRLR\n`,
    );
    const rows = individualFieldRows(m.individuals.get("@I1@"), c.individuals.get("@P1@"));
    expect(byKey(rows, "links")?.state).toBe("conflict");
    expect(fieldDiffCounts(rows)).toEqual({ newCount: 0, diffCount: 0, linkCount: 1 });

    const same = dataset(
      `0 HEAD\n0 @P1@ INDI\n1 NAME A /B/\n1 WWW https://example.com/old/\n0 TRLR\n`,
    );
    const rows2 = individualFieldRows(m.individuals.get("@I1@"), same.individuals.get("@P1@"));
    expect(byKey(rows2, "links")?.state).toBe("agree"); // trailing-slash-insensitive
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

  it("surfaces family and marriage links", () => {
    const m = dataset(`0 HEAD\n0 @F1@ FAM\n1 HUSB @I1@\n1 MARR\n2 DATE 1875\n0 TRLR\n`);
    const c = dataset(
      `0 HEAD\n0 @G1@ FAM\n1 HUSB @P1@\n1 _LINK https://example.com/fam\n1 MARR\n2 DATE 1875\n2 WWW https://example.com/marr\n0 TRLR\n`,
    );
    const rows = familyFieldRows(m.families.get("@F1@"), c.families.get("@G1@"), m, c);
    expect(byKey(rows, "links")?.state).toBe("incoming-only");
    expect(byKey(rows, "MARR.links")?.state).toBe("incoming-only");
  });
});

describe("familyFieldRows", () => {
  const m = dataset(MASTER);
  const c = dataset(COMPARE);
  const rows = familyFieldRows(
    m.families.get("@F1@"),
    c.families.get("@G1@"),
    m,
    c,
  );

  it("agrees on marriage date, fills marriage place", () => {
    expect(byKey(rows, "MARR.date")?.state).toBe("agree");
    expect(byKey(rows, "MARR.place")?.state).toBe("incoming-only");
  });

  it("includes the husband row", () => {
    expect(byKey(rows, "husband")?.state).toBe("conflict"); // Müller vs Mueller label
  });
});
