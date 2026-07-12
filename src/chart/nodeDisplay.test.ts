import { describe, expect, it } from "vitest";
import type { Individual } from "../gedcom/types";
import { parsePlace } from "../gedcom/place";
import { ALL_DISPLAY, lifespanLine, nodeDisplay, placeLabel, type NodeDisplayOptions } from "./nodeDisplay";

/** Minimal Individual carrying only the events `placeLabel` reads. */
function person(events: { tag: string; place?: string }[]): Individual {
  return {
    events: events.map((e) => ({ tag: e.tag, place: e.place ? parsePlace(e.place) : undefined })),
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
