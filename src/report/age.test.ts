import { describe, expect, it } from "vitest";
import i18next from "i18next";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { displayName, primaryName } from "../match/relatives";
import type { Individual } from "../gedcom/types";
import type { Translate } from "../locales/i18n";
import { en } from "../locales/en";
import { sl } from "../locales/sl";
import { buildDescendants } from "./descendants";
import { narrativeLangFor, narrativeParagraph } from "./narrativeText";
import { planEntry } from "./narrative";
import { factText } from "./text";
import { factAgeSuffix } from "./model";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}
const tr = (key: string) => key;
/** A real i18next t so the narrative templates interpolate the age tail. */
function makeT(lng: "en" | "sl"): Translate {
  const inst = i18next.createInstance();
  void inst.init({
    lng,
    initAsync: false,
    resources: { en: { translation: en }, sl: { translation: sl } },
    interpolation: { escapeValue: false },
  });
  return inst.t.bind(inst) as Translate;
}
const nameOf = (indi: Individual) => displayName(primaryName(indi));
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;

// Peter (I3, b.1896, d.1960) is the child of Janez (I1, b.1870) and Marija
// (I2, b.1872); he ⚭ Eva (I7, b.1900) in 1922.
const GED = wrap(
  "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1870\n1 FAMS @F1@\n" +
    "0 @I2@ INDI\n1 NAME Marija /Oblak/\n1 SEX F\n1 BIRT\n2 DATE 1872\n1 FAMS @F1@\n" +
    "0 @I3@ INDI\n1 NAME Peter /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1896\n1 DEAT\n2 DATE 1960\n1 FAMC @F1@\n1 FAMS @F3@\n" +
    "0 @I7@ INDI\n1 NAME Eva /Zajc/\n1 SEX F\n1 BIRT\n2 DATE 1900\n1 FAMS @F3@\n" +
    "0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n1 CHIL @I3@\n1 MARR\n2 DATE 1895\n" +
    "0 @F3@ FAM\n1 HUSB @I3@\n1 WIFE @I7@\n1 MARR\n2 DATE 1922\n",
);

const ds = dataset(GED);
const peterFacts = (age: boolean) => {
  const data = buildDescendants(ds, "@I1@", nameOf, 2000, { age })!;
  const entry = data.generations.flatMap((g) => g.entries).find((e) => e.id === "@I3@")!;
  return entry.facts;
};

describe("report Age fact option", () => {
  it("shows the parents' sex-tagged ages on a birth", () => {
    const birth = peterFacts(true).find((f) => f.tag === "BIRT")!;
    expect(birth.ages).toEqual(["♂26", "♀24"]);
    expect(factAgeSuffix(birth)).toBe("(♂26 ♀24)");
    expect(factText(tr, birth)).toContain("1896 (♂26 ♀24)");
  });

  it("shows both spouses' sex-tagged ages on a marriage", () => {
    const marr = peterFacts(true).find((f) => f.tag === "MARR")!;
    expect(marr.ages).toEqual(["♂26", "♀22"]);
    expect(factText(tr, marr)).toContain("1922 (♂26 ♀22)");
  });

  it("shows the subject's own age on a personal event (death)", () => {
    const death = peterFacts(true).find((f) => f.tag === "DEAT")!;
    expect(death.age).toBe(64);
    expect(death.ages).toBeUndefined();
    expect(factText(tr, death)).toContain("1960 (64)");
  });

  it("attaches no age when the option is off", () => {
    const facts = peterFacts(false);
    expect(facts.every((f) => f.age === undefined && f.ages === undefined)).toBe(true);
    expect(factText(tr, facts.find((f) => f.tag === "DEAT")!)).not.toContain("(");
  });

  it("weaves the age into the narrative prose", () => {
    const entry = buildDescendants(ds, "@I1@", nameOf, 2000, { age: true })!
      .generations.flatMap((g) => g.entries)
      .find((e) => e.id === "@I3@")!;
    const prose = narrativeParagraph(makeT("en"), narrativeLangFor("en"), entry, planEntry(entry));
    // Personal age uses the gendered age word; couple/birth ages stay as glyphs.
    expect(prose).toContain("(age 64)");
    expect(prose).toContain("(♂26 ♀24)");
  });

  it("uses the gendered age word in the Slovenian narrative", () => {
    const entry = buildDescendants(ds, "@I1@", nameOf, 2000, { age: true })!
      .generations.flatMap((g) => g.entries)
      .find((e) => e.id === "@I3@")!;
    const prose = narrativeParagraph(makeT("sl"), narrativeLangFor("sl"), entry, planEntry(entry));
    // Peter is male → "star", not "stara"; the unit "let" trails the number.
    expect(prose).toContain("(star 64 let)");
  });
});
