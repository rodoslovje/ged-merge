import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { inferMainProfile } from "../normalize/profile";
import { normalizeDataset } from "../normalize/normalize";
import { familyMergeKeyBases, fieldDiffCounts, individualFieldRows } from "./fields";
import type { FieldRow } from "./types";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

function byKey(rows: FieldRow[], key: string): FieldRow | undefined {
  return rows.find((r) => r.key === key);
}

/** Identity translator: tests assert on keys/states, not localized labels. */
const tr = (key: string) => key;

const MAIN = `0 HEAD
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
  const m = dataset(MAIN);
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

  it("marks main-only fields and omits empties", () => {
    expect(byKey(rows, "DEAT.date")?.state).toBe("main-only");
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

describe("attribute tags and vendor events (BK premium support)", () => {
  const person = (body: string, id = "@I1@") =>
    dataset(`0 HEAD\n0 ${id} INDI\n1 NAME A /B/\n1 BIRT\n2 DATE 1850\n1 DEAT\n2 DATE 1910\n${body}\n0 TRLR\n`)
      .individuals.get(id);

  it("surfaces REFN and attribute tags (TITL/RELI/DSCR/NOBI/LATR/DEED/ILL) as value rows", () => {
    const rows = individualFieldRows(tr,
      person("1 REFN 1234\n1 TITL Earl of Richmond\n1 RELI rimokatoliška\n1 DSCR tall\n1 NOBI Velika plaketa Občine Preddvor\n2 DATE 2025\n1 LATR Pogodba o vzdrževanju\n2 DATE 7 May 1928\n1 DEED Kmetijsko društvo\n2 DATE 23 JUN 1910\n1 ILL prometna nesreča\n2 DATE 22 JUN 1966"),
      undefined,
    );
    expect(byKey(rows, "REFN.value")?.main).toBe("1234");
    expect(byKey(rows, "TITL.value")?.main).toBe("Earl of Richmond");
    expect(byKey(rows, "RELI.value")?.main).toBe("rimokatoliška");
    expect(byKey(rows, "DSCR.value")?.main).toBe("tall");
    expect(byKey(rows, "NOBI.value")?.main).toBe("Velika plaketa Občine Preddvor");
    expect(byKey(rows, "NOBI.date")?.main).toBe("2025");
    expect(byKey(rows, "LATR.value")?.main).toBe("Pogodba o vzdrževanju");
    expect(byKey(rows, "LATR.date")?.main).toBe("7 May 1928");
    expect(byKey(rows, "DEED.value")?.main).toBe("Kmetijsko društvo");
    expect(byKey(rows, "DEED.date")?.main).toBe("23 JUN 1910");
    expect(byKey(rows, "ILL.value")?.main).toBe("prometna nesreča");
    expect(byKey(rows, "ILL.date")?.main).toBe("22 JUN 1966");
  });

  it("lifts Brother's Keeper _INTE/_FNRL/_MILT as events with date and place", () => {
    const rows = individualFieldRows(tr,
      dataset(`0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n1 BIRT\n2 DATE 1850\n1 DEAT\n2 DATE 20 APR 1910\n1 _MILT vojak\n2 DATE 1871\n1 _FNRL\n2 DATE 24 APR 1910\n2 PLAC Tunjice\n1 _INTE\n2 PLAC Tunjice\n0 TRLR\n`).individuals.get("@I1@"),
      undefined,
    );
    expect(byKey(rows, "_MILT.value")?.main).toBe("vojak");
    expect(byKey(rows, "_FNRL.date")?.main).toBe("24 APR 1910");
    expect(byKey(rows, "_FNRL.place")?.main).toBe("Tunjice");
    expect(byKey(rows, "_INTE.place")?.main).toBe("Tunjice");
    // Death-zone ordering: DEAT before funeral before interment, all after _MILT.
    const order = rows.filter((r) => r.isEventHeader).map((r) => r.key);
    expect(order.indexOf("_MILT.header")).toBeLessThan(order.indexOf("DEAT.header"));
    expect(order.indexOf("DEAT.header")).toBeLessThan(order.indexOf("_FNRL.header"));
    expect(order.indexOf("_FNRL.header")).toBeLessThan(order.indexOf("_INTE.header"));
  });

  it("treats FACT like EVEN: TYPE in the header and Title slot, value as Agency", () => {
    const rows = individualFieldRows(tr,
      person("1 FACT 1234567\n2 TYPE RIN"),
      undefined,
    );
    expect(rows.find((r) => r.isEventHeader && r.key === "FACT.header")?.label).toBe("event.FACT — RIN");
    expect(byKey(rows, "FACT.type")?.label).toBe("event.colTitle");
    expect(byKey(rows, "FACT.value")?.main).toBe("1234567");
  });
});

describe("generic EVEN with a TYPE", () => {
  const even = (body: string, id: string) =>
    dataset(`0 HEAD\n0 ${id} INDI\n1 NAME A /B/\n1 BIRT\n2 DATE 1850\n${body}\n0 TRLR\n`)
      .individuals.get(id);

  it("labels the event 'Event', the TYPE as Title and the line value as Agency", () => {
    const rows = individualFieldRows(tr,
      even("1 EVEN LDHD-PNT\n2 TYPE FamilySearch ID", "@I1@"),
      undefined,
    );
    // The heading is the generic "Event" label with the TYPE appended, so the
    // row reads "Event — FamilySearch ID" instead of an anonymous "Event".
    expect(rows.find((r) => r.isEventHeader && r.key === "EVEN.header")?.label).toBe("event.EVEN — FamilySearch ID");
    // TYPE → "Title", line value → "Agency".
    const title = byKey(rows, "EVEN.type");
    expect(title?.label).toBe("event.colTitle");
    expect(title?.main).toBe("FamilySearch ID");
    const agency = byKey(rows, "EVEN.value");
    expect(agency?.label).toBe("event.colAgency");
    expect(agency?.main).toBe("LDHD-PNT");
  });

  it("does not surface a real AGNC as a second Agency row", () => {
    const rows = individualFieldRows(tr,
      even("1 EVEN code\n2 TYPE Some Type\n2 AGNC Parish", "@I1@"),
      undefined,
    );
    const agencyRows = rows.filter((r) => r.label === "event.colAgency");
    expect(agencyRows).toHaveLength(1);
    expect(agencyRows[0].key).toBe("EVEN.value");
  });
});

describe("individual parents and partners rows", () => {
  const mainGed = `0 HEAD
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
    const m = dataset(mainGed);
    const c = dataset(compareGed);
    const rows = individualFieldRows(tr,
      m.individuals.get("@C@"),
      c.individuals.get("@C@"),
      m,
      c,
    );
    expect(byKey(rows, "father")).toMatchObject({ main: "Janez Novak", state: "agree" });
    expect(byKey(rows, "mother")).toMatchObject({ main: "Marija Kos", state: "main-only" });
    expect(byKey(rows, "fam.@F2@.partner")).toMatchObject({ main: "Tone Horvat", state: "agree" });
  });

  it("omits relative rows when datasets are not supplied", () => {
    const m = dataset(mainGed);
    const rows = individualFieldRows(tr, m.individuals.get("@C@"), m.individuals.get("@C@"));
    expect(byKey(rows, "father")).toBeUndefined();
    expect(byKey(rows, "fam.@F2@.partner")).toBeUndefined();
  });
});

describe("familyMergeKeyBases", () => {
  // Main and compare each assign their own ids to the same real-world family
  // (@F9@ vs @F2@), as happens when merging two independently-numbered GEDCOM
  // files — the row keys must key off the compare side's id so the edit view
  // can resolve the same merge highlight against its own (main-numbered) family.
  const mainGed = `0 HEAD
0 @C@ INDI
1 NAME Ana /Novak/
1 SEX F
1 FAMS @F9@
0 @SP@ INDI
1 NAME Tone /Horvat/
1 SEX M
0 @F9@ FAM
1 HUSB @SP@
1 WIFE @C@
1 MARR
2 DATE 1 JAN 2000
0 TRLR
`;
  const compareGed = `0 HEAD
0 @C@ INDI
1 NAME Ana /Novak/
1 SEX F
1 FAMS @F2@
0 @SP@ INDI
1 NAME Tone /Horvat/
1 SEX M
0 @F2@ FAM
1 HUSB @SP@
1 WIFE @C@
1 MARR
2 DATE 1 JAN 2000
2 PLAC Ljubljana
0 TRLR
`;

  it("maps the main family id to the fam.<id> key base used by its paired compare family", () => {
    const m = dataset(mainGed);
    const c = dataset(compareGed);
    const rows = individualFieldRows(tr, m.individuals.get("@C@"), c.individuals.get("@C@"), m, c);
    // Rows are keyed by the compare (incoming) family id, not the main's.
    expect(byKey(rows, "fam.@F2@.MARR.place")).toMatchObject({ incoming: "Ljubljana", state: "incoming-only" });
    expect(byKey(rows, "fam.@F9@.MARR.place")).toBeUndefined();

    const bases = familyMergeKeyBases(m.individuals.get("@C@"), c.individuals.get("@C@"), m, c);
    expect(bases.get("@F9@")).toBe("fam.@F2@");
  });

  it("surfaces a family _MSTAT status as a value row", () => {
    const statusGed = (famId: string, status: string) => `0 HEAD
0 @C@ INDI
1 NAME Ana /Novak/
1 SEX F
1 FAMS ${famId}
0 @SP@ INDI
1 NAME Tone /Horvat/
1 SEX M
0 ${famId} FAM
1 HUSB @SP@
1 WIFE @C@
1 _MSTAT ${status}
0 TRLR
`;
    const m = dataset(statusGed("@F1@", "Partners"));
    const c = dataset(statusGed("@F2@", "Partners"));
    const rows = individualFieldRows(tr, m.individuals.get("@C@"), c.individuals.get("@C@"), m, c);
    expect(byKey(rows, "fam.@F2@._MSTAT.value")).toMatchObject({ main: "Partners", incoming: "Partners", state: "agree" });
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

describe("date before value in event sub-rows", () => {
  it("shows date as the first sub-row for events that have both a value and a date", () => {
    const c = dataset(
      `0 HEAD\n0 @P1@ INDI\n1 NAME A /B/\n1 OCCU rač. teh.\n2 DATE 1998\n0 TRLR\n`,
    );
    const rows = individualFieldRows(tr, undefined, c.individuals.get("@P1@"));
    const dateIdx = rows.findIndex((r) => r.key === "OCCU.date");
    const valueIdx = rows.findIndex((r) => r.key === "OCCU.value");
    expect(dateIdx).toBeGreaterThan(-1);
    expect(valueIdx).toBeGreaterThan(-1);
    expect(dateIdx).toBeLessThan(valueIdx);
  });
});

describe("event sort key — precision and qualifier", () => {
  // Helper: build a dataset with the given event tags and dates, then return
  // the ordered header keys so we can assert relative sort positions.
  function orderedHeaders(events: Array<{ tag: string; date: string }>) {
    const lines = events.map(({ tag, date }) => `1 ${tag}\n2 DATE ${date}\n`).join("");
    const ds = dataset(`0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n${lines}0 TRLR\n`);
    const rows = individualFieldRows(tr, ds.individuals.get("@I1@"), undefined);
    return rows.filter((r) => r.isGroupHeader && r.isEventHeader).map((r) => r.key);
  }

  it("puts a specific date before a year-only date of the same year", () => {
    // Death "26 Mar 1944" should sort before Burial "1944".
    const keys = orderedHeaders([
      { tag: "BURI", date: "1944" },
      { tag: "DEAT", date: "26 MAR 1944" },
    ]);
    expect(keys.indexOf("DEAT.header")).toBeLessThan(keys.indexOf("BURI.header"));
  });

  it("puts BEF YYYY before an exact date in the same year", () => {
    // BEF 1944 must sort before 26 Mar 1944.
    const keys = orderedHeaders([
      { tag: "DEAT", date: "26 MAR 1944" },
      { tag: "BIRT", date: "BEF 1944" },
    ]);
    expect(keys.indexOf("BIRT.header")).toBeLessThan(keys.indexOf("DEAT.header"));
  });

  it("puts BEF YYYY before a year-only date of the same year", () => {
    const keys = orderedHeaders([
      { tag: "DEAT", date: "1944" },
      { tag: "BIRT", date: "BEF 1944" },
    ]);
    expect(keys.indexOf("BIRT.header")).toBeLessThan(keys.indexOf("DEAT.header"));
  });

  it("sorts a FROM..TO period by its end date, just before a same-year event", () => {
    // An occupation held 1963-1981 should land right before a 1981 residence,
    // not at its start year (1963).
    const keys = orderedHeaders([
      { tag: "RESI", date: "1963" },
      { tag: "OCCU", date: "FROM 1963 TO 1981" },
      { tag: "RESI", date: "1981" },
    ]);
    expect(keys.indexOf("RESI.0.header")).toBeLessThan(keys.indexOf("OCCU.header"));
    expect(keys.indexOf("OCCU.header")).toBeLessThan(keys.indexOf("RESI.1.header"));
  });
});

describe("event ordering", () => {
  it("sorts events chronologically across types", () => {
    // Main has RESI before BIRT in the file; sorted output must put BIRT first.
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

  it("uses compare date when main event has no date", () => {
    // Main has an undated RESI; compare's 1974 date should be used for sort order.
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

  it("keeps BIRT before a compare-side RESI dated after the earliest birth", () => {
    // Main birth `ABT 1820` (year-only → sorts to end of year); compare birth
    // `1 NOV 1818` plus a `1818` residence. The residence is after the compare's
    // own birth, so the birth row must stay first — it should anchor at the
    // earliest birth (1818), not the main's later `ABT 1820`.
    const m = dataset(
      `0 HEAD\n0 @I1@ INDI\n1 NAME Janez /Stariha/\n1 BIRT\n2 DATE ABT 1820\n0 TRLR\n`,
    );
    const c = dataset(
      `0 HEAD\n0 @P1@ INDI\n1 NAME Janez /Stariha/\n` +
      `1 RESI\n2 DATE 1818\n2 PLAC Sadinja Vas\n` +
      `1 BIRT\n2 DATE 1 NOV 1818\n0 TRLR\n`,
    );
    const rows = individualFieldRows(tr, m.individuals.get("@I1@"), c.individuals.get("@P1@"));
    const keys = rows.filter((r) => r.isGroupHeader && r.isEventHeader).map((r) => r.key);
    expect(keys.indexOf("BIRT.header")).toBeLessThan(keys.indexOf("RESI.header"));
  });

  it("sorts undated RESI between dated BIRT and DEAT", () => {
    // An undated RESI (with a place so it renders) must appear after dated BIRT and before dated DEAT.
    const m = dataset(
      `0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n` +
      `1 RESI\n2 PLAC Ravna Gora\n` +
      `1 BIRT\n2 DATE 1754\n` +
      `1 DEAT\n2 DATE 1806\n` +
      `0 TRLR\n`,
    );
    const rows = individualFieldRows(tr, m.individuals.get("@I1@"), undefined);
    const keys = rows.filter((r) => r.isGroupHeader && r.isEventHeader).map((r) => r.key);
    expect(keys.indexOf("BIRT.header")).toBeLessThan(keys.indexOf("RESI.header"));
    expect(keys.indexOf("RESI.header")).toBeLessThan(keys.indexOf("DEAT.header"));
  });

  it("sorts a dated OCCU/RESI ending in the death year before BURI", () => {
    // OCCU/RESI recorded as "FROM ... TO 2024" (still ongoing at death) get a
    // year-only end-date key, which ranks after any specific same-year date
    // per dateToSortKey — they must still land before the dated burial.
    const m = dataset(
      `0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n` +
      `1 OCCU voznik\n2 DATE FROM 1995 TO 2024\n` +
      `1 RESI\n2 DATE FROM 1970 TO 2024\n2 PLAC Kranj\n` +
      `1 DEAT\n2 DATE 2024\n` +
      `1 BURI\n2 DATE 16 JUL 2024\n` +
      `0 TRLR\n`,
    );
    const rows = individualFieldRows(tr, m.individuals.get("@I1@"), undefined);
    const keys = rows.filter((r) => r.isGroupHeader && r.isEventHeader).map((r) => r.key);
    expect(keys.indexOf("OCCU.header")).toBeLessThan(keys.indexOf("DEAT.header"));
    expect(keys.indexOf("OCCU.header")).toBeLessThan(keys.indexOf("BURI.header"));
    expect(keys.indexOf("RESI.header")).toBeLessThan(keys.indexOf("DEAT.header"));
    expect(keys.indexOf("RESI.header")).toBeLessThan(keys.indexOf("BURI.header"));
  });

  it("sorts undated CHR after dated BIRT and before dated DEAT", () => {
    // An undated christening (with a place so it renders) must still appear
    // after a dated birth, not before it, even though both are birth-zone tags.
    const m = dataset(
      `0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n` +
      `1 CHR\n2 PLAC Metlika\n` +
      `1 BIRT\n2 DATE 10 SEP 1913\n2 PLAC Krasinec\n` +
      `1 DEAT\n2 DATE 1999\n` +
      `0 TRLR\n`,
    );
    const rows = individualFieldRows(tr, m.individuals.get("@I1@"), undefined);
    const keys = rows.filter((r) => r.isGroupHeader && r.isEventHeader).map((r) => r.key);
    expect(keys.indexOf("BIRT.header")).toBeLessThan(keys.indexOf("CHR.header"));
    expect(keys.indexOf("CHR.header")).toBeLessThan(keys.indexOf("DEAT.header"));
  });

  it("sorts undated BAPM after BIRT even when main/compare birth dates differ", () => {
    // Main BIRT is 29 Jul 1939, compare BIRT is 20 Jul 1939 (earlier). The BAPM
    // row only exists on the compare side and is undated. It must still sort
    // after BIRT, since BIRT's own row uses main's (later) date.
    const m = dataset(
      `0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n1 BIRT\n2 DATE 29 JUL 1939\n0 TRLR\n`,
    );
    const c = dataset(
      `0 HEAD\n0 @P1@ INDI\n1 NAME A /B/\n1 BIRT\n2 DATE 20 JUL 1939\n1 BAPM\n2 PLAC Metlika\n0 TRLR\n`,
    );
    const rows = individualFieldRows(tr, m.individuals.get("@I1@"), c.individuals.get("@P1@"));
    const keys = rows.filter((r) => r.isGroupHeader && r.isEventHeader).map((r) => r.key);
    expect(keys.indexOf("BIRT.header")).toBeLessThan(keys.indexOf("BAPM.header"));
  });

  it("sorts a dated CHR after BIRT even when the christening date predates the birth", () => {
    // Reported case: main birth is ABT 1862, compare has a precise christening
    // 25 Aug 1859 and birth 25 Aug 1859. The CHR row uses the compare's 1859 date
    // while the BIRT row uses main's (later) 1862 date, so a naive date sort
    // ranks christening before birth. Birth-zone clamping must keep BIRT first.
    const m = dataset(
      `0 HEAD\n0 @I1@ INDI\n1 NAME Marija /Fijaski/\n1 BIRT\n2 DATE ABT 1862\n2 PLAC Ravna Gora\n0 TRLR\n`,
    );
    const c = dataset(
      `0 HEAD\n0 @P1@ INDI\n1 NAME Marija /Fijaski/\n` +
      `1 CHR\n2 DATE 25 AUG 1859\n2 PLAC Ravna Gora\n` +
      `1 BIRT\n2 DATE 25 AUG 1859\n2 PLAC Ravna Gora\n0 TRLR\n`,
    );
    const rows = individualFieldRows(tr, m.individuals.get("@I1@"), c.individuals.get("@P1@"));
    const keys = rows.filter((r) => r.isGroupHeader && r.isEventHeader).map((r) => r.key);
    expect(keys.indexOf("BIRT.header")).toBeLessThan(keys.indexOf("CHR.header"));
  });

  it("sorts a precise CHR after a year-only BIRT in the same record", () => {
    // A precise christening date sorts to mid-year, while a year-only birth sorts
    // to the end of its year (dateToSortKey +9000). Without clamping, the
    // christening would precede the birth even on one person.
    const m = dataset(
      `0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n` +
      `1 CHR\n2 DATE 15 MAR 1862\n` +
      `1 BIRT\n2 DATE 1862\n` +
      `0 TRLR\n`,
    );
    const rows = individualFieldRows(tr, m.individuals.get("@I1@"), undefined);
    const keys = rows.filter((r) => r.isGroupHeader && r.isEventHeader).map((r) => r.key);
    expect(keys.indexOf("BIRT.header")).toBeLessThan(keys.indexOf("CHR.header"));
  });

  it("sorts undated DEAT before undated BURI, both after dated BIRT", () => {
    const m = dataset(
      `0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n` +
      `1 DEAT\n2 PLAC Ravna Gora\n` +
      `1 BURI\n2 PLAC Ravna Gora\n` +
      `1 BIRT\n2 DATE 1754\n` +
      `0 TRLR\n`,
    );
    const rows = individualFieldRows(tr, m.individuals.get("@I1@"), undefined);
    const keys = rows.filter((r) => r.isGroupHeader && r.isEventHeader).map((r) => r.key);
    expect(keys.indexOf("BIRT.header")).toBeLessThan(keys.indexOf("DEAT.header"));
    expect(keys.indexOf("DEAT.header")).toBeLessThan(keys.indexOf("BURI.header"));
  });
});

describe("multi-RESI pairing by date", () => {
  it("pairs residences by date proximity rather than positional index", () => {
    // Main: RESI 1997 (addr: Cesta 50), RESI 2004
    // Compare: RESI 1974, RESI 1998 (place includes Cesta 50)
    // By index: main[0] ↔ compare[0] (1997↔1974), main[1] ↔ compare[1] (2004↔1998)
    // By date: main[0] ↔ compare[1] (1997↔1998), main[1] has no close compare match
    const m = dataset(
      `0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n` +
      `1 RESI\n2 DATE 1997\n2 PLAC Ljubljana\n2 ADDR Cesta 50\n` +
      `1 RESI\n2 DATE JUN 2004\n2 PLAC Ljubljana\n` +
      `0 TRLR\n`,
    );
    const c = dataset(
      `0 HEAD\n0 @P1@ INDI\n1 NAME A /B/\n` +
      `1 RESI\n2 DATE 1974\n2 PLAC Strazisce\n` +
      `1 RESI\n2 DATE 1998\n2 PLAC Ljubljana, Cesta 50\n` +
      `0 TRLR\n`,
    );
    const rows = individualFieldRows(tr, m.individuals.get("@I1@"), c.individuals.get("@P1@"));
    // Find the RESI that has main date 1997 — it should be paired with compare date 1998, not 1974.
    const resiDateRows = rows.filter(r => r.key.match(/^RESI\.\d+\.date$/));
    const paired1997 = resiDateRows.find(r => r.main === "1997");
    expect(paired1997?.incoming).toBe("1998"); // paired by date proximity, not position
  });

  it("does not pair residences that are too far apart in date and place", () => {
    // Main: Jun 2004, Ljubljana; Incoming: BEF 1998, Kranj — should stay unpaired.
    const m = dataset(
      `0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n` +
      `1 RESI\n2 DATE JUN 2004\n2 PLAC Ljubljana\n2 ADDR Ulica talcev 7\n` +
      `0 TRLR\n`,
    );
    const c = dataset(
      `0 HEAD\n0 @P1@ INDI\n1 NAME A /B/\n` +
      `1 RESI\n2 DATE BEF 1998\n2 PLAC Kranj, Hafnarjeva pot 53\n` +
      `0 TRLR\n`,
    );
    const rows = individualFieldRows(tr, m.individuals.get("@I1@"), c.individuals.get("@P1@"));
    const dateRows = rows.filter(r => r.key.match(/^RESI(\.\d+)?\.date$/));
    // Must appear as two separate rows, not one paired row.
    expect(dateRows.length).toBe(2);
    const mainDate = dateRows.find(r => r.main && !r.incoming);
    const compareDate = dateRows.find(r => !r.main && r.incoming);
    expect(mainDate?.state).toBe("main-only");
    expect(compareDate?.state).toBe("incoming-only");
  });

  it("pairs identical undated events instead of splitting them", () => {
    // Undated events have no date signal, so scoring alone can never clear the
    // pairing threshold — the identical-content fast path must pair them, or
    // an identical incoming copy shows as "incoming-only" and a confirm with
    // default choices imports a duplicate.
    const body =
      `1 EVEN\n2 TYPE Departure\n2 PLAC Bremen\n` +
      `1 EVEN\n2 TYPE Departure\n2 PLAC Rotterdam\n` +
      `1 OCCU Farmer\n`;
    const m = dataset(`0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n${body}0 TRLR\n`);
    const c = dataset(`0 HEAD\n0 @P1@ INDI\n1 NAME A /B/\n${body}0 TRLR\n`);
    const rows = individualFieldRows(tr, m.individuals.get("@I1@"), c.individuals.get("@P1@"));
    // Every row pairs and agrees; nothing is main-only or incoming-only.
    expect(rows.filter((r) => r.state !== "agree")).toEqual([]);
    // The two Departures stay distinct paired instances (not collapsed).
    expect(rows.filter((r) => /^EVEN(\.\d+)?\.type$/.test(r.key))).toHaveLength(2);
  });

  it("does not pair residences 7 years apart even when they share a locality", () => {
    // 7-year gap now scores 0.2 (not 0.4), so shared locality alone cannot push
    // the total above the 0.35 pairing threshold.
    const m = dataset(
      `0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n` +
      `1 RESI\n2 DATE 1970\n2 PLAC Strazisce,Kranj,Slovenia\n2 ADDR Hafnarjeva pot 21a\n` +
      `0 TRLR\n`,
    );
    const c = dataset(
      `0 HEAD\n0 @P1@ INDI\n1 NAME A /B/\n` +
      `1 RESI\n2 DATE 1963\n2 PLAC Kranj (Slovenija), Hafnarjeva pot 21 - župnija Šmartin\n` +
      `0 TRLR\n`,
    );
    const rows = individualFieldRows(tr, m.individuals.get("@I1@"), c.individuals.get("@P1@"));
    const dateRows = rows.filter(r => r.key.match(/^RESI(\.\d+)?\.date$/));
    expect(dateRows.length).toBe(2); // shown as separate events, not paired
  });

  it("does not pair residences 20 years apart with different addresses in the same city", () => {
    // Same locality on both sides ("Kranj"), but a 20-year date gap and unrelated
    // street addresses (Smledniska 59 vs Trg Rivoli 4) — addr words must count
    // against the place-similarity score, not just toward a containment bonus.
    const m = dataset(
      `0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n` +
      `1 RESI\n2 DATE 1972\n2 PLAC Kranj,Kranj,Slovenia\n2 ADDR Smledniska 59\n` +
      `0 TRLR\n`,
    );
    const c = dataset(
      `0 HEAD\n0 @P1@ INDI\n1 NAME A /B/\n` +
      `1 RESI\n2 DATE 1992\n2 PLAC Kranj,Kranj,Slovenia\n2 ADDR Trg Rivoli 4\n` +
      `0 TRLR\n`,
    );
    const rows = individualFieldRows(tr, m.individuals.get("@I1@"), c.individuals.get("@P1@"));
    const dateRows = rows.filter(r => r.key.match(/^RESI(\.\d+)?\.date$/));
    expect(dateRows.length).toBe(2); // shown as separate events, not paired
  });

  it("splits a dated main RESI from a no-date compare RESI in a different place", () => {
    // Reproduces a real case: main has date+place, compare has only a different place (no date).
    // Without the fix the date requirement prevented the score check, so they were merged.
    const m = dataset(
      `0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n` +
      `1 RESI\n2 DATE 1982\n2 PLAC Metlika,Metlika,Slovenia\n2 ADDR Mestni trg 9\n` +
      `0 TRLR\n`,
    );
    const c = dataset(
      `0 HEAD\n0 @P1@ INDI\n1 NAME A /B/\n` +
      `1 RESI\n2 PLAC Radovljica,Radovljica,Slovenia\n2 ADDR Gorenjska Cesta 33/a\n2 AGNC župnija Radovljica\n` +
      `0 TRLR\n`,
    );
    const rows = individualFieldRows(tr, m.individuals.get("@I1@"), c.individuals.get("@P1@"));
    // Both events have place data, so count place rows to verify they were split.
    // (The compare event has no date, so there is only one date row total.)
    const placeRows = rows.filter(r => r.key.match(/^RESI(\.\d+)?\.place$/));
    expect(placeRows.length).toBe(2); // shown as separate events, not paired
    expect(placeRows.find(r => r.main?.includes("Metlika"))?.state).toBe("main-only");
    expect(placeRows.find(r => r.incoming?.includes("Radovljica"))?.state).toBe("incoming-only");
  });

  it("does not pair residences with different locality, address, and agency 2 years apart", () => {
    // Reproduces a real case: same municipality/country tokens ("Kranj", "Slovenia")
    // made these look similar enough to pair, even though locality, address, and
    // agency are all different — they're two distinct residences, not one.
    const m = dataset(
      `0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n` +
      `1 RESI\n2 DATE 1958\n2 PLAC Stražišče,Kranj,Slovenia\n2 ADDR Kocjanova 16\n2 AGNC župnija Šmartin\n` +
      `0 TRLR\n`,
    );
    const c = dataset(
      `0 HEAD\n0 @P1@ INDI\n1 NAME A /B/\n` +
      `1 RESI\n2 DATE BEF 1956\n2 PLAC Kranj,Kranj,Slovenia\n2 ADDR Huje 84\n2 AGNC župnija Kranj\n` +
      `0 TRLR\n`,
    );
    const rows = individualFieldRows(tr, m.individuals.get("@I1@"), c.individuals.get("@P1@"));
    const dateRows = rows.filter(r => r.key.match(/^RESI(\.\d+)?\.date$/));
    expect(dateRows.length).toBe(2); // shown as separate events, not paired
  });

  it("pairs an exact-year event with a FROM..TO range that contains it", () => {
    // Main has "1958", compare has "FROM 1958 TO 1982" — the exact year falls
    // inside the range so they should be paired as the same event, not split.
    const m = dataset(
      `0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n` +
      `1 RESI\n2 DATE 1958\n2 PLAC Stražišče,Kranj,Slovenia\n2 ADDR Kocjanova 16\n2 AGNC župnija Šmartin\n` +
      `0 TRLR\n`,
    );
    const c = dataset(
      `0 HEAD\n0 @P1@ INDI\n1 NAME A /B/\n` +
      `1 RESI\n2 DATE FROM 1958 TO 1982\n2 PLAC Stražišče,Kranj,Slovenia\n2 ADDR Kocjanova 16\n2 AGNC župnija Šmartin\n` +
      `0 TRLR\n`,
    );
    const rows = individualFieldRows(tr, m.individuals.get("@I1@"), c.individuals.get("@P1@"));
    const dateRows = rows.filter(r => r.key.match(/^RESI(\.\d+)?\.date$/));
    expect(dateRows.length).toBe(1); // paired as one event
    expect(dateRows[0].main).toBe("1958");
    expect(dateRows[0].incoming).toBe("FROM 1958 TO 1982");
    expect(dateRows[0].state).toBe("conflict"); // different assertions, but same event
  });

  it("pairs an OCCU exact-year with a FROM..TO range starting at that year", () => {
    // "1956" vs "FROM 1956 TO 1970" — same occupation, different date precision.
    const m = dataset(
      `0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n` +
      `1 OCCU strojni ključavničar\n2 DATE 1956\n` +
      `0 TRLR\n`,
    );
    const c = dataset(
      `0 HEAD\n0 @P1@ INDI\n1 NAME A /B/\n` +
      `1 OCCU strojni ključavničar\n2 DATE FROM 1956 TO 1970\n` +
      `0 TRLR\n`,
    );
    const rows = individualFieldRows(tr, m.individuals.get("@I1@"), c.individuals.get("@P1@"));
    const dateRows = rows.filter(r => r.key.match(/^OCCU(\.\d+)?\.date$/));
    expect(dateRows.length).toBe(1); // paired as one event
  });

  it("detects addr-in-place when paired correctly and marks addr as agree", () => {
    const m = dataset(
      `0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n` +
      `1 RESI\n2 DATE 1997\n2 PLAC Ljubljana\n2 ADDR Cesta v Pecale 50\n` +
      `0 TRLR\n`,
    );
    const c = dataset(
      `0 HEAD\n0 @P1@ INDI\n1 NAME A /B/\n` +
      `1 RESI\n2 DATE 1998\n2 PLAC Ljubljana, Cesta v Pecale 50 - župnija Črnuče\n` +
      `0 TRLR\n`,
    );
    const rows = individualFieldRows(tr, m.individuals.get("@I1@"), c.individuals.get("@P1@"));
    // Main has addr, incoming has none but embeds it in place — should agree.
    expect(byKey(rows, "RESI.addr")?.state).toBe("agree");
  });

  it("extracts addr from packed PLAC even when it does not exactly match main ADDR", () => {
    // Main addr: "Hafnarjeva pot 21a / 53" — incoming packed PLAC: "Hafnarjeva pot 21/a"
    // The strings differ so placeContainsAddr fails; structural extraction should still
    // surface the incoming address so the row shows "conflict" rather than "main-only".
    const m = dataset(
      `0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n` +
      `1 RESI\n2 DATE 1974\n2 PLAC Strazisce,Kranj,Slovenia\n2 ADDR Hafnarjeva pot 21a / 53\n` +
      `0 TRLR\n`,
    );
    const c = dataset(
      `0 HEAD\n0 @P1@ INDI\n1 NAME A /B/\n` +
      `1 RESI\n2 DATE 1974\n2 PLAC Kranj (Slovenija), Hafnarjeva pot 21/a - župnija Šmartin\n` +
      `0 TRLR\n`,
    );
    const rows = individualFieldRows(tr, m.individuals.get("@I1@"), c.individuals.get("@P1@"));
    const addrRow = byKey(rows, "RESI.addr");
    // The incoming addr should be extracted and shown (conflict), not blank (main-only).
    expect(addrRow?.state).toBe("conflict");
    expect(addrRow?.incoming).toBe("Hafnarjeva pot 21/a");
  });

  it("includes facility in extracted addr when packed PLAC contains one", () => {
    // "Kidričeva 38/a (porodnišnica)" — decomposePlace splits the facility into dec.facility;
    // the extracted address should re-append it in parentheses.
    const m = dataset(
      `0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n` +
      `1 BIRT\n2 PLAC Kranj,Kranj,Slovenia\n2 ADDR Kidričeva 38/a\n` +
      `0 TRLR\n`,
    );
    const c = dataset(
      `0 HEAD\n0 @P1@ INDI\n1 NAME A /B/\n` +
      `1 BIRT\n2 PLAC Kranj (Slovenija), Kidričeva 38/a (porodnišnica)\n` +
      `0 TRLR\n`,
    );
    const rows = individualFieldRows(tr, m.individuals.get("@I1@"), c.individuals.get("@P1@"));
    const addrRow = byKey(rows, "BIRT.addr");
    expect(addrRow?.incoming).toBe("Kidričeva 38/a (porodnišnica)");
  });

  it("extracts addr from packed PLAC even when main has no ADDR field", () => {
    // Birth: main has only PLAC, no ADDR. Incoming has packed PLAC with embedded address.
    // An incoming-only ADDR row should appear showing the extracted address.
    const m = dataset(
      `0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n` +
      `1 BIRT\n2 PLAC Kranj,Kranj,Slovenia\n` +
      `0 TRLR\n`,
    );
    const c = dataset(
      `0 HEAD\n0 @P1@ INDI\n1 NAME A /B/\n` +
      `1 BIRT\n2 PLAC Kranj (Slovenija), Kidričeva 38/a (porodnišnica)\n` +
      `0 TRLR\n`,
    );
    const rows = individualFieldRows(tr, m.individuals.get("@I1@"), c.individuals.get("@P1@"));
    const addrRow = byKey(rows, "BIRT.addr");
    expect(addrRow?.state).toBe("incoming-only");
    expect(addrRow?.incoming).toBe("Kidričeva 38/a (porodnišnica)");
  });
});

describe("place reshaping to packed-plac hides addr row", () => {
  // Main has packed-plac layout (parenthetical country in PLAC, no ADDR).
  // Incoming has structured-addr (comma PLAC + separate ADDR).
  // After reshaping to packed-plac, the incoming addr folds into PLAC and the
  // addr row must not appear in the compare dialog.
  const mainGed = `0 HEAD
0 @I1@ INDI
1 NAME Anton /Kovač/
1 BIRT
2 PLAC Kranj (Slovenija)
1 DEAT
2 PLAC Jesenice (Slovenija)
0 TRLR`;

  const compareGed = `0 HEAD
0 @P1@ INDI
1 NAME Anton /Kovač/
1 BIRT
2 PLAC Kranj,Slovenija
2 ADDR Kranj 15
0 TRLR`;

  it("hides addr row when reshaping structured-addr incoming into packed-plac main", () => {
    const m = dataset(mainGed);
    // Reshaping now happens on load, not in individualFieldRows itself.
    const { dataset: c } = normalizeDataset(dataset(compareGed), inferMainProfile(m));
    const rows = individualFieldRows(tr, m.individuals.get("@I1@"), c.individuals.get("@P1@"), m, c);
    // Incoming ADDR ("Kranj 15") folds into packed PLAC; neither side has a
    // standalone addr value, so the addr row must be absent.
    expect(byKey(rows, "BIRT.addr")).toBeUndefined();
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
    // Event links appear as inline icons on the event's Source row.
    expect(byKey(rows, "links")).toBeUndefined(); // no record-level links
    expect(byKey(rows, "BIRT.links")).toBeUndefined(); // no separate links data row
    const birtSources = byKey(rows, "BIRT.sources");
    expect(birtSources?.incomingLinkIcons).toEqual(["https://example.com/birth"]);
    expect(birtSources?.mainLinkIcons).toBeUndefined();
    expect(fieldDiffCounts(rows)).toEqual({ newCount: 0, diffCount: 0, linkCount: 1 });
  });

  it("drops the link icon when a citation on the same side already links to it", () => {
    const ds = dataset(
      `0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n1 BIRT\n2 DATE 1900\n2 WWW https://example.com/birth\n` +
        `2 SOUR @S1@\n0 @S1@ SOUR\n1 TITL Birth register\n1 OBJE @O1@\n0 @O1@ OBJE\n1 FILE https://example.com/birth\n0 TRLR\n`,
    );
    const indi = ds.individuals.get("@I1@")!;
    const rows = individualFieldRows(tr, indi, undefined);
    const birtSources = byKey(rows, "BIRT.sources");
    expect(birtSources?.mainSources).toHaveLength(1);
    expect(birtSources?.mainLinkIcons).toBeUndefined();
  });

  it("keeps the link icon when it points elsewhere than the citation", () => {
    const ds = dataset(
      `0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n1 BIRT\n2 DATE 1900\n2 WWW https://example.com/elsewhere\n` +
        `2 SOUR @S1@\n0 @S1@ SOUR\n1 TITL Birth register\n1 OBJE @O1@\n0 @O1@ OBJE\n1 FILE https://example.com/birth\n0 TRLR\n`,
    );
    const indi = ds.individuals.get("@I1@")!;
    const rows = individualFieldRows(tr, indi, undefined);
    const birtSources = byKey(rows, "BIRT.sources");
    expect(birtSources?.mainSources).toHaveLength(1);
    expect(birtSources?.mainLinkIcons).toEqual(["https://example.com/elsewhere"]);
  });

  it("shows an incoming plain link as the main's own citation when it's the exact same archival page", () => {
    const m = dataset(
      `0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n1 BIRT\n2 DATE 1900\n2 SOUR @S1@\n3 PAGE 56\n` +
        `0 @S1@ SOUR\n1 TITL Krstna knjiga\n1 OBJE @O1@\n0 @O1@ OBJE\n1 FILE https://data.matricula-online.eu/sl/slovenia/ljubljana/kranj/01/?pg=56\n0 TRLR\n`,
    );
    const c = dataset(
      `0 HEAD\n0 @P1@ INDI\n1 NAME A /B/\n1 BIRT\n2 DATE 1900\n` +
        `2 WWW https://data.matricula-online.eu/sl/slovenia/ljubljana/kranj/01/?pg=56\n0 TRLR\n`,
    );
    const rows = individualFieldRows(tr, m.individuals.get("@I1@"), c.individuals.get("@P1@"));
    const birtSources = byKey(rows, "BIRT.sources");
    expect(birtSources?.incomingLinkIcons).toBeUndefined();
    expect(birtSources?.incomingSources).toEqual(birtSources?.mainSources);
    expect(birtSources?.state).toBe("agree");
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

  it("treats Geneanet cemetery links as equal regardless of language code", () => {
    const m = dataset(
      `0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n1 WWW https://en.geneanet.org/cemetery/view/9833663\n0 TRLR\n`,
    );
    const c = dataset(
      `0 HEAD\n0 @P1@ INDI\n1 NAME A /B/\n1 WWW https://de.geneanet.org/friedhof/view/9833663\n0 TRLR\n`,
    );
    const rows = individualFieldRows(tr, m.individuals.get("@I1@"), c.individuals.get("@P1@"));
    expect(byKey(rows, "links")?.state).toBe("agree");
    expect(fieldDiffCounts(rows)).toEqual({ newCount: 0, diffCount: 0, linkCount: 0 });
  });

  it("treats French Geneanet cemetery links (no subdomain, plural word) as equal to other languages", () => {
    const m = dataset(
      `0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n1 WWW https://en.geneanet.org/cemetery/view/9833663\n0 TRLR\n`,
    );
    const c = dataset(
      `0 HEAD\n0 @P1@ INDI\n1 NAME A /B/\n1 WWW https://www.geneanet.org/cimetieres/view/9833663\n0 TRLR\n`,
    );
    const rows = individualFieldRows(tr, m.individuals.get("@I1@"), c.individuals.get("@P1@"));
    expect(byKey(rows, "links")?.state).toBe("agree");
  });

  it("treats accented/percent-encoded Geneanet cemetery words (Swedish, Portuguese) as equal to other languages", () => {
    const m = dataset(
      `0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n1 WWW https://en.geneanet.org/cemetery/view/9833663\n0 TRLR\n`,
    );
    const sv = dataset(
      `0 HEAD\n0 @P1@ INDI\n1 NAME A /B/\n1 WWW https://sv.geneanet.org/kyrkogård/view/9833663\n0 TRLR\n`,
    );
    expect(byKey(individualFieldRows(tr, m.individuals.get("@I1@"), sv.individuals.get("@P1@")), "links")?.state).toBe(
      "agree",
    );
    const pt = dataset(
      `0 HEAD\n0 @P1@ INDI\n1 NAME A /B/\n1 WWW https://pt.geneanet.org/cemit%C3%A9rio/view/9833663\n0 TRLR\n`,
    );
    expect(byKey(individualFieldRows(tr, m.individuals.get("@I1@"), pt.individuals.get("@P1@")), "links")?.state).toBe(
      "agree",
    );
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
    // Record-level links render as icons on the combined "Sources" row.
    expect(byKey(rows, "links")?.mainLinkIcons).toEqual(["https://example.com/x"]);
  });

  it("surfaces a record-level SOUR citation on the combined Sources row", () => {
    const m = dataset(
      `0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n1 SOUR @S1@\n2 PAGE 5\n` +
        `0 @S1@ SOUR\n1 TITL Družinski arhiv\n0 TRLR\n`,
    );
    const c = dataset(`0 HEAD\n0 @P1@ INDI\n1 NAME A /B/\n0 TRLR\n`);
    const rows = individualFieldRows(tr, m.individuals.get("@I1@"), c.individuals.get("@P1@"));
    const sources = byKey(rows, "links");
    expect(sources?.mainSources).toHaveLength(1);
    expect(sources?.mainSources?.[0].title).toBe("Družinski arhiv");
    expect(sources?.state).toBe("main-only");
  });

  it("flags an incoming-only record-level citation as new", () => {
    const m = dataset(`0 HEAD\n0 @I1@ INDI\n1 NAME A /B/\n0 TRLR\n`);
    const c = dataset(
      `0 HEAD\n0 @P1@ INDI\n1 NAME A /B/\n1 SOUR @S1@\n0 @S1@ SOUR\n1 TITL Matična knjiga\n0 TRLR\n`,
    );
    const rows = individualFieldRows(tr, m.individuals.get("@I1@"), c.individuals.get("@P1@"));
    const sources = byKey(rows, "links");
    expect(sources?.incomingSources).toHaveLength(1);
    expect(sources?.state).toBe("incoming-only");
    expect(fieldDiffCounts(rows)).toEqual({ newCount: 1, diffCount: 0, linkCount: 0 });
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
  // Main children: Anna, Berta. Incoming: Anna (match), Doris (new). Berta has
  // no incoming counterpart, Doris no main counterpart. Children surface on the
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
    const m = children.main.split("\n");
    const i = children.incoming.split("\n");
    expect(m.length).toBe(i.length); // both columns have the same number of lines
    expect(m[0]).toContain("Anna");
    expect(i[0]).toContain("Anna"); // matched pair shares line 0
  });

  it("gives an unmatched child its own line with the other column blank", () => {
    const m = children.main.split("\n");
    const i = children.incoming.split("\n");
    // Berta is main-only; Doris is incoming-only — each on a line by itself.
    const bertaLine = m.findIndex((l) => l.includes("Berta"));
    const dorisLine = i.findIndex((l) => l.includes("Doris"));
    expect(i[bertaLine]).toBe(""); // nothing aligned opposite Berta
    expect(m[dorisLine]).toBe(""); // nothing aligned opposite Doris
    expect(children.state).toBe("conflict");
  });

  // Same-named siblings distinguished only by birth year: the incoming child
  // must align with the main sibling born the same year, not the first match.
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
    const m = children.main.split("\n");
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
    const lines = children.main.split("\n");
    expect(lines.map((l) => l.match(/Ana|Berta|Cilka/)?.[0])).toEqual(["Ana", "Berta", "Cilka"]);
  });
});
