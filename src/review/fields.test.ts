import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { familyFieldRows, individualFieldRows } from "./fields";
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
