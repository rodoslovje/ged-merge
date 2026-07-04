import { describe, expect, it } from "vitest";
import type { Individual } from "../gedcom/types";
import { parsePlace } from "../gedcom/place";
import { ALL_DISPLAY, nodeDisplay, placeLabel, type NodeDisplayOptions } from "./nodeDisplay";

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
});
