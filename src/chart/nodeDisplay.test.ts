import { describe, expect, it } from "vitest";
import type { Individual } from "../gedcom/types";
import { parsePlace } from "../gedcom/place";
import { ALL_DISPLAY, formatMarriage, homePlaceOf, lifespanLine, marriageApprox, nodeDisplay, placeLabel, type NodeDisplayOptions } from "./nodeDisplay";
import { marriageOf } from "./personTree";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { yearsSegments } from "../gedcom/lifespan";

/** Minimal Individual carrying only the events `placeLabel` and `homePlaceOf` read. */
function person(events: { tag: string; place?: string; address?: string; year?: number }[]): Individual {
  return {
    events: events.map((e) => ({
      tag: e.tag,
      place: e.place ? parsePlace(e.place) : undefined,
      address: e.address ? parsePlace(e.address) : undefined,
      date: e.year === undefined ? undefined : { raw: String(e.year), qualifier: "exact", year: e.year },
    })),
  } as unknown as Individual;
}

const opts = (patch: Partial<NodeDisplayOptions> = {}): NodeDisplayOptions => ({ ...ALL_DISPLAY, ...patch });
const base = { name: "Janez Novak", years: "1817–1890", place: "Kranj", kinship: "2nd cousin", livingLabel: "Living" };

describe("placeLabel", () => {
  it("prefers birth, then residence, then death", () => {
    expect(placeLabel(person([{ tag: "RESI", place: "Maribor" }, { tag: "BIRT", place: "Kranj" }]))).toBe("Kranj");
    expect(placeLabel(person([{ tag: "RESI", place: "Maribor" }, { tag: "DEAT", place: "Celje" }]))).toBe("Maribor");
    expect(placeLabel(person([{ tag: "DEAT", place: "Celje" }]))).toBe("Celje");
  });

  it("strips the house number from the locality and skips placeless events", () => {
    expect(placeLabel(person([{ tag: "BIRT", place: "Kranj 22, Slovenija" }]))).toBe("Kranj");
    expect(placeLabel(person([{ tag: "BIRT" }, { tag: "DEAT", place: "Celje" }]))).toBe("Celje");
    expect(placeLabel(person([]))).toBeUndefined();
  });
});

describe("homePlaceOf", () => {
  it("prefers the last residence, then birth, then death", () => {
    const resi = person([{ tag: "BIRT", place: "Kranj" }, { tag: "RESI", place: "Maribor" }, { tag: "DEAT", place: "Celje" }]);
    expect(homePlaceOf(resi)?.label).toBe("Maribor");
    expect(homePlaceOf(person([{ tag: "DEAT", place: "Celje" }, { tag: "BIRT", place: "Kranj" }]))?.label).toBe("Kranj");
    expect(homePlaceOf(person([{ tag: "BIRT" }, { tag: "DEAT", place: "Celje" }]))?.tag).toBe("DEAT");
    expect(homePlaceOf(person([]))).toBeUndefined();
  });

  it("takes the latest dated residence, else the last one written", () => {
    const dated = person([
      { tag: "RESI", place: "Ptuj", year: 1890 },
      { tag: "RESI", place: "Maribor", year: 1870 },
      { tag: "RESI", place: "Lendava" },
    ]);
    expect(homePlaceOf(dated)?.label).toBe("Ptuj");
    expect(homePlaceOf(person([{ tag: "RESI", place: "Ptuj" }, { tag: "RESI", place: "Maribor" }]))?.label).toBe("Maribor");
  });

  it("writes Place · Address, keeping the house number", () => {
    expect(homePlaceOf(person([{ tag: "BIRT", place: "Šentvid 23, Slovenija" }]))?.label).toBe("Šentvid 23");
    const home = homePlaceOf(person([{ tag: "RESI", place: "Ljubljana, Slovenija", address: "Celovška 12" }]));
    expect(home).toEqual({ tag: "RESI", label: "Ljubljana · Celovška 12", full: "Ljubljana, Slovenija · Celovška 12" });
    expect(homePlaceOf(person([{ tag: "RESI", address: "Celovška 12" }]))?.label).toBe("Celovška 12");
  });
});

describe("nodeDisplay", () => {
  it("shows every field when all toggles are on", () => {
    const d = nodeDisplay(opts(), base);
    expect(d).toMatchObject({ name: "Janez Novak", years: "1817–1890", place: "Kranj", kinship: "2nd cousin", showPhoto: true });
  });

  it("hides each field independently", () => {
    expect(nodeDisplay(opts({ showLifespan: false }), base).years).toBeUndefined();
    expect(nodeDisplay(opts({ showPlace: false }), base).place).toBeUndefined();
    expect(nodeDisplay(opts({ showKinship: false }), base).kinship).toBeUndefined();
    expect(nodeDisplay(opts({ showPhoto: false }), base).showPhoto).toBe(false);
  });

  it("redacts a living person to their kinship under privacy", () => {
    const d = nodeDisplay(opts({ privacyLiving: true }), { ...base, living: true });
    expect(d).toMatchObject({ name: "2nd cousin", years: undefined, place: undefined, kinship: undefined, showPhoto: false });
  });

  it("falls back to the Living placeholder when no kinship is known", () => {
    const d = nodeDisplay(opts({ privacyLiving: true }), { ...base, kinship: undefined, living: true });
    expect(d.name).toBe("Living");
  });

  it("leaves living people untouched when privacy is off", () => {
    const d = nodeDisplay(opts({ privacyLiving: false }), { ...base, living: true });
    expect(d.name).toBe("Janez Novak");
    expect(d.years).toBe("1817–1890");
  });

  it("does not redact deceased people even with privacy on", () => {
    const d = nodeDisplay(opts({ privacyLiving: true }), { ...base, living: false });
    expect(d.name).toBe("Janez Novak");
  });

  it("folds age into the lifespan line when both are shown", () => {
    const d = nodeDisplay(opts({ showAge: true }), { ...base, age: 73, ageText: "age 73" });
    expect(d.years).toBe("1817–1890 (73)");
  });

  it("shows the standalone age phrase when the lifespan is hidden", () => {
    const d = nodeDisplay(opts({ showLifespan: false, showAge: true }), { ...base, age: 73, ageText: "star 73 let" });
    expect(d.years).toBe("star 73 let");
  });

  it("leaves the lifespan alone when age is off or unknown", () => {
    expect(nodeDisplay(opts({ showAge: false }), { ...base, age: 73, ageText: "age 73" }).years).toBe("1817–1890");
    expect(nodeDisplay(opts({ showAge: true }), { ...base, age: undefined, ageText: "age" }).years).toBe("1817–1890");
  });
});

describe("lifespanLine", () => {
  const of = (o: { showLifespan: boolean; showAge: boolean }, i: { years?: string; age?: number; ageText?: string }) =>
    lifespanLine(o, i);

  it("combines lifespan and age in parentheses", () => {
    expect(of({ showLifespan: true, showAge: true }, { years: "1850–1920", age: 70, ageText: "age 70" })).toBe("1850–1920 (70)");
  });

  it("shows the standalone age phrase alone when the lifespan is off", () => {
    expect(of({ showLifespan: false, showAge: true }, { years: "1850–1920", age: 70, ageText: "stara 70 let" })).toBe("stara 70 let");
  });

  it("falls back to the bare number when no phrase is supplied", () => {
    expect(of({ showLifespan: false, showAge: true }, { years: "1850–1920", age: 70 })).toBe("70");
  });

  it("returns just the lifespan when age is off", () => {
    expect(of({ showLifespan: true, showAge: false }, { years: "1850–1920", age: 70, ageText: "age 70" })).toBe("1850–1920");
  });

  it("returns nothing when neither is shown or no data backs them", () => {
    expect(of({ showLifespan: false, showAge: false }, { years: "1850–1920", age: 70, ageText: "age 70" })).toBeUndefined();
    expect(of({ showLifespan: true, showAge: true }, { years: "", age: undefined, ageText: "age" })).toBeUndefined();
  });
});

describe("formatMarriage", () => {
  const both = { date: true, place: true };
  const couple = { year: "1962", place: "Ljubljana" };

  it("joins the fields it is asked for", () => {
    expect(formatMarriage(couple, both)).toBe("⚭ 1962 Ljubljana");
    expect(formatMarriage(couple, { date: true, place: false })).toBe("⚭ 1962");
    expect(formatMarriage(couple, { date: false, place: false })).toBeUndefined();
  });

  it("says nothing about a couple with a living partner while redacting", () => {
    const living = { ...couple, living: true };
    expect(formatMarriage(living, both, true)).toBeUndefined();
    // The flag alone changes nothing — only the privacy switch acts on it.
    expect(formatMarriage(living, both)).toBe("⚭ 1962 Ljubljana");
    // …and a couple both long dead keeps its label under the switch.
    expect(formatMarriage(couple, both, true)).toBe("⚭ 1962 Ljubljana");
  });
});

describe("marriageApprox", () => {
  const ds = buildDataset(parseGedcom(new TextEncoder().encode(
    "0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n" +
      "0 @F1@ FAM\n1 MARR\n2 DATE ABT 1764\n2 PLAC Kranj\n0 @F2@ FAM\n1 MARR\n2 DATE 3 MAY 1764\n0 TRLR\n",
  ).buffer));

  it("sets an ABT/BEF/… marriage year in italics, and only the year", () => {
    const m = marriageOf(ds.families.get("@F1@"), ds);
    expect(m?.approx).toBe(true);
    const text = formatMarriage(m, { date: true, place: true })!;
    expect(yearsSegments(text, marriageApprox(m, text))).toEqual([
      { text: "⚭ ", approx: false }, { text: "1764", approx: true }, { text: " Kranj", approx: false },
    ]);
    // Place only — no year on the label, nothing to italicize.
    expect(marriageApprox(m, formatMarriage(m, { date: false, place: true }))).toBeUndefined();
  });

  it("leaves an exact date upright", () => {
    const m = marriageOf(ds.families.get("@F2@"), ds);
    expect(marriageApprox(m, formatMarriage(m, { date: true, place: false }))).toBeUndefined();
  });
});
