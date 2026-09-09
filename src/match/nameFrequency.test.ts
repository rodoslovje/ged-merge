import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import type { Dataset, PersonName } from "../gedcom/types";
import { findDuplicates } from "../tools/duplicates";
import { matchDatasets } from "./engine";
import { buildNameFrequencies, nameFrequenciesFor, nameKey } from "./nameFrequency";
import { nameEvidenceFactor, scoreIndividualPair } from "./scoreIndividual";
import { DEFAULT_CONFIG } from "./types";

function dataset(body: string): Dataset {
  const text = `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer as ArrayBuffer));
}

function pn(given: string | undefined, surname: string | undefined): PersonName {
  return { given, surname, full: [given, surname].filter(Boolean).join(" ") };
}

/** One person: name, sex, an optional birth date line ("1900", "ABT 1900", "3 MAY 1900"). */
function person(id: string, name: string, sex: "M" | "F", birth?: string, extra = ""): string {
  return `0 @${id}@ INDI\n1 NAME ${name}\n1 SEX ${sex}\n${birth ? `1 BIRT\n2 DATE ${birth}\n` : ""}${extra}`;
}

/** Twenty Janez Novaks born across 1890–1909, plus one Svitoslav Peruzzi. */
function crowd(prefix: string, opts: { approx?: boolean } = {}): string {
  let out = "";
  for (let i = 0; i < 20; i++) {
    out += person(`${prefix}N${i}`, "Janez /Novak/", "M", `${opts.approx ? "ABT " : ""}${1890 + i}`);
  }
  out += person(`${prefix}P`, "Svitoslav /Peruzzi/", "M", `${opts.approx ? "ABT " : ""}1900`);
  return out;
}

describe("nameKey", () => {
  it("folds the surname and canonicalizes the first given token through the variant table", () => {
    expect(nameKey(pn("Janez", "Novák"))).toBe(nameKey(pn("Johann Baptist", "Novak")));
    expect(nameKey(pn("Ivan", "Novak"))).toBe(nameKey(pn("Janez", "Novak")));
    expect(nameKey(pn("Franc", "Novak"))).not.toBe(nameKey(pn("Janez", "Novak")));
  });

  it("is undefined without both parts", () => {
    expect(nameKey(pn(undefined, "Novak"))).toBeUndefined();
    expect(nameKey(pn("Janez", undefined))).toBeUndefined();
    expect(nameKey(undefined)).toBeUndefined();
  });
});

describe("buildNameFrequencies", () => {
  const ds = dataset(crowd("A"));
  const freq = buildNameFrequencies([ds]);
  const indi = (id: string) => ds.individuals.get(`@${id}@`)!;

  it("counts the era window's other bearers for a pair, leaving the two records out", () => {
    // Nineteen other Janez Novaks, all within 30 years of 1895.
    expect(freq.pairNamesakes(indi("AN5"), ds, indi("AN6"), ds)).toBe(18);
    expect(freq.pairNamesakes(indi("AP"), ds, indi("AP"), ds)).toBe(0);
  });

  it("counts each side's own name when the two names differ", () => {
    // Janez Novak against Svitoslav Peruzzi: the Novak side has 19 others.
    expect(freq.pairNamesakes(indi("AN0"), ds, indi("AP"), ds)).toBe(19);
  });

  it("restricts the window to the era, and widens to every era for an undated pair", () => {
    const spread = dataset(
      person("E1", "Marija /Hafner/", "F", "1700") +
        person("E2", "Marija /Hafner/", "F", "1800") +
        person("E3", "Marija /Hafner/", "F", "1802") +
        person("E4", "Marija /Hafner/", "F") +
        person("E5", "Marija /Hafner/", "F"),
    );
    const f = buildNameFrequencies([spread]);
    const e = (id: string) => spread.individuals.get(`@${id}@`)!;
    // 1800 vs 1802: the 1700 bearer is out of the window; the two undated
    // ones sit in every window.
    expect(f.pairNamesakes(e("E2"), spread, e("E3"), spread)).toBe(2);
    // An undated record is placed in its counterpart's era.
    expect(f.pairNamesakes(e("E4"), spread, e("E2"), spread)).toBe(2);
    // Neither side dated: every bearer counts.
    expect(f.pairNamesakes(e("E4"), spread, e("E5"), spread)).toBe(3);
  });

  it("pools both files for a cross-file match", () => {
    const other = dataset(person("B", "Svitoslav /Peruzzi/", "M", "1901"));
    const both = buildNameFrequencies([ds, other]);
    expect(both.pairNamesakes(indi("AP"), ds, other.individuals.get("@B@")!, other)).toBe(0);
    expect(both.pairNamesakes(indi("AN0"), ds, other.individuals.get("@B@")!, other)).toBe(19);
  });

  it("answers a relative's name over a span", () => {
    expect(freq.namesakesOf(pn("Janez", "Novak"), 1900, 60)).toBe(19);
    expect(freq.namesakesOf(pn("Svitoslav", "Peruzzi"), 1900, 60)).toBe(0);
    expect(freq.namesakesOf(pn("Nobody", "Here"), 1900, 60)).toBe(0);
  });

  it("memoizes per dataset until the record count changes", () => {
    const a = nameFrequenciesFor(ds);
    expect(nameFrequenciesFor(ds)).toBe(a);
    ds.individuals.delete("@AN19@");
    expect(nameFrequenciesFor(ds)).not.toBe(a);
  });
});

describe("nameEvidenceFactor", () => {
  it("keeps the full weight up to a family's worth of namesakes, then falls to a floor", () => {
    expect(nameEvidenceFactor(0)).toBe(1);
    expect(nameEvidenceFactor(3)).toBe(1);
    expect(nameEvidenceFactor(4)).toBeLessThan(1);
    expect(nameEvidenceFactor(4)).toBeGreaterThan(nameEvidenceFactor(10));
    expect(nameEvidenceFactor(1000)).toBe(0.5);
  });
});

describe("frequency-aware scoring", () => {
  it("never calls a pair strong on a crowd name and an estimated year alone", () => {
    const main = dataset(crowd("M", { approx: true }));
    const compare = dataset(crowd("C", { approx: true }));
    const r = matchDatasets(main, compare).individuals;
    const novak = r.filter((c) => c.mainId.startsWith("@MN"));
    expect(novak.length).toBeGreaterThan(0);
    for (const c of novak) expect(c.category).not.toBe("strong");
    // The rare name, on the same evidence, is anchored by itself.
    const peruzzi = r.find((c) => c.mainId === "@MP@");
    expect(peruzzi?.compareId).toBe("@CP@");
    expect(peruzzi?.category).toBe("strong");
  });

  it("keeps a day-precision date agreement strong whatever the name", () => {
    const main = dataset(crowd("M") + person("MX", "Janez /Novak/", "M", "3 MAY 1900"));
    const compare = dataset(person("CX", "Janez /Novak/", "M", "3 MAY 1900"));
    const r = matchDatasets(main, compare).individuals.find((c) => c.compareId === "@CX@");
    expect(r?.mainId).toBe("@MX@");
    expect(r?.score).toBe(100);
  });

  it("keeps a stub-and-record pair listed by the duplicate finder, as probable", () => {
    // Six Ana Simoničs of one era — a crowd; the stub "~1805" and the
    // christening record "19 MAR 1806" stay in the list, just short of strong.
    const ds = dataset(
      person("S1", "Ana /Simonič/", "F", "ABT 1805") +
        person("S2", "Ana /Simonič/", "F", "19 MAR 1806") +
        person("S3", "Ana /Simonič/", "F", "ABT 1811") +
        person("S4", "Ana /Simonič/", "F", "1790") +
        person("S5", "Ana /Simonič/", "F", "1820") +
        person("S6", "Ana /Simonič/", "F", "1830"),
    );
    const pair = findDuplicates(ds).find((p) => [p.aId, p.bId].sort().join() === "@S1@,@S2@");
    expect(pair).toBeDefined();
    expect(pair!.category).toBe("probable");
    expect(pair!.score).toBeGreaterThanOrEqual(80);
  });

  it("scores as before when no frequency index is supplied", () => {
    const ds = dataset(crowd("M", { approx: true }));
    const a = ds.individuals.get("@MN5@")!;
    const b = ds.individuals.get("@MN6@")!;
    const bare = scoreIndividualPair(a, b, ds, ds, DEFAULT_CONFIG);
    const aware = scoreIndividualPair(a, b, ds, ds, DEFAULT_CONFIG, buildNameFrequencies([ds]));
    expect(bare.category).toBe("strong");
    expect(aware.score).toBeLessThan(bare.score);
    expect(aware.components.find((c) => c.key === "surname")!.weight).toBeLessThan(
      bare.components.find((c) => c.key === "surname")!.weight,
    );
  });

  it("withholds the relative bonus for a relative with a crowd name", () => {
    // Two files with the same child; the father is a Janez Novak among many
    // on one run and a Svitoslav Peruzzi on the other. Same evidence
    // otherwise, so the bonus is the only difference.
    const family = (prefix: string, father: string, extra: string) =>
      person(`${prefix}K`, "Marija /Bajuk/", "F", `${prefix === "M" ? 1850 : 1851}`, `1 FAMC @${prefix}F@\n`) +
      person(`${prefix}D`, father, "M", "1820", `1 FAMS @${prefix}F@\n`) +
      `0 @${prefix}F@ FAM\n1 HUSB @${prefix}D@\n1 CHIL @${prefix}K@\n` +
      extra;
    const score = (father: string, extra: string) => {
      const main = dataset(family("M", father, extra));
      const compare = dataset(family("C", father, ""));
      return matchDatasets(main, compare).individuals.find((c) => c.mainId === "@MK@" && c.compareId === "@CK@")!.score;
    };
    const rare = score("Svitoslav /Peruzzi/", "");
    const common = score("Janez /Novak/", crowd("X"));
    expect(rare - common).toBeCloseTo(DEFAULT_CONFIG.parentMatchBonus, 1);
  });
});
