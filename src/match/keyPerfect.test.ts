import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { scoreIndividualPair } from "./scoreIndividual";
import { DEFAULT_CONFIG } from "./types";
import { serializeGedcom } from "../gedcom/serialize";
import { decisionKey, type CandidateDecision } from "../review/types";
import { mergeDecisions } from "../merge/merge";

const dataset = (text: string) => buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;

/** A person @X1@ born 3 MAR 1850, with an optional sex and parents. */
const person = (sex: string, father?: string, mother?: string) => wrap(
  `0 @X1@ INDI\n1 NAME Janez /Novak/\n1 SEX ${sex}\n1 BIRT\n2 DATE 3 MAR 1850\n2 PLAC Kranj\n` +
  (father ? "1 FAMC @XF@\n" : "") +
  (father ? `0 @XP@ INDI\n1 NAME ${father} /Novak/\n1 SEX M\n1 FAMS @XF@\n0 @XM@ INDI\n1 NAME ${mother} /Kos/\n1 SEX F\n1 FAMS @XF@\n` +
    "0 @XF@ FAM\n1 HUSB @XP@\n1 WIFE @XM@\n1 CHIL @X1@\n" : ""),
);

function score(a: string, b: string): number {
  const main = dataset(a);
  const compare = dataset(b);
  return scoreIndividualPair(main.individuals.get("@X1@")!, compare.individuals.get("@X1@")!, main, compare, DEFAULT_CONFIG).score;
}

describe("a perfect identity key does not outrank contrary evidence", () => {
  it("still scores a flat 100 for a perfect key with nothing against it", () => {
    expect(score(person("M", "Jakob", "Marija"), person("M", "Jakob", "Marija"))).toBe(100);
  });

  it("does not lift a pair of opposite sex to 100", () => {
    expect(score(person("M"), person("F"))).toBeLessThan(100);
  });

  it("does not lift a pair whose parents both conflict to 100", () => {
    expect(score(person("M", "Jakob", "Marija"), person("M", "Tomaž", "Helena"))).toBeLessThan(DEFAULT_CONFIG.strongThreshold * 100);
  });

  it("keeps a perfect key whose parents both conflict in review as probable", () => {
    // Parents copied wrong onto one record must not hide the duplicate, even
    // when its death disagrees too (that pair scores 62.5 on its components).
    const died = (text: string, deat: string, plac: string) =>
      text.replace("2 PLAC Kranj\n", `2 PLAC Kranj\n1 DEAT\n2 DATE ${deat}\n2 PLAC ${plac}\n`);
    expect(score(
      died(person("M", "Jakob", "Marija"), "1900", "Kranj"),
      died(person("M", "Tomaž", "Helena"), "1931", "Celje"),
    )).toBeGreaterThanOrEqual(DEFAULT_CONFIG.probableThreshold * 100);
  });
});

describe("a suggested match of opposite sex is never a join point", () => {
  it("imports the incoming spouse rather than fusing them with a man", () => {
    // A suggestion the matcher itself would never make (it gates on sex), but
    // one an imported matches table or a shared _UID can carry.
    const main = dataset(wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n" +
      "0 @I2@ INDI\n1 NAME Ana /Kos/\n1 SEX M\n1 BIRT\n2 DATE 1852\n",
    ));
    const compare = dataset(wrap(
      "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n1 FAMS @G1@\n" +
      "0 @P2@ INDI\n1 NAME Ana /Kos/\n1 SEX F\n1 BIRT\n2 DATE 1852\n1 FAMS @G1@\n" +
      "0 @G1@ FAM\n1 HUSB @P1@\n1 WIFE @P2@\n",
    ));
    const matches = { individuals: [
      { mainId: "@I1@", compareId: "@P1@", score: 100 },
      { mainId: "@I2@", compareId: "@P2@", score: 100 },
    ] } as never;
    const decisions = new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields: {} }],
    ]);
    const out = serializeGedcom(mergeDecisions(main, compare, decisions, matches, (k: string) => k).records);
    expect(out).not.toMatch(/1 WIFE @I2@/);
    expect(out).toMatch(/0 @I\d+@ INDI\n1 NAME Ana \/Kos\/\n1 SEX F/);
  });
});
