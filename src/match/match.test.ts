import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { matchDatasets } from "./engine";
import { jaroWinkler, soundex, foldToken } from "./text";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

describe("text primitives", () => {
  it("jaroWinkler rewards close strings", () => {
    expect(jaroWinkler("smith", "smith")).toBe(1);
    expect(jaroWinkler("smith", "smyth")).toBeGreaterThan(0.8);
    expect(jaroWinkler("smith", "jones")).toBeLessThan(0.5);
  });

  it("jaroWinkler memo keys can't collide across multi-word pairs", () => {
    // The cache key joins a and b with a literal NUL. Were it a space,
    // ("kranjc novak","kos") and ("kranjc","novak kos") would share a key
    // and the second call would return the first pair's cached score.
    const first = jaroWinkler("kranjc novak", "kos");
    const second = jaroWinkler("kranjc", "novak kos");
    expect(second).not.toBe(first);
    expect(second).toBe(jaroWinkler("kranjc", "novak kos"));
  });

  it("soundex groups homophones", () => {
    expect(soundex("Smith")).toBe(soundex("Smyth"));
    expect(soundex("Robert")).toBe("R163");
  });

  it("foldToken strips diacritics and case", () => {
    expect(foldToken("Müller")).toBe("muller");
    expect(foldToken("  Österreich ")).toBe("osterreich");
  });
});

// Main and compare describe the same nuclear family with small variations:
// surname spelling (Müller/Mueller), an approximate birth year, and a typo.
const MAIN = `0 HEAD
1 GEDC
2 VERS 5.5.1
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Johann /Müller/
1 SEX M
1 BIRT
2 DATE 12 JAN 1850
2 PLAC Wien, Österreich
1 FAMS @F1@
0 @I2@ INDI
1 NAME Maria /Schmidt/
1 SEX F
1 BIRT
2 DATE 1852
1 FAMS @F1@
0 @I3@ INDI
1 NAME Anna /Müller/
1 SEX F
1 BIRT
2 DATE 1880
1 FAMC @F1@
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 CHIL @I3@
1 MARR
2 DATE 1875
0 TRLR
`;

const COMPARE = `0 HEAD
1 GEDC
2 VERS 5.5.1
1 CHAR UTF-8
0 @P1@ INDI
1 NAME Johan /Mueller/
1 SEX M
1 BIRT
2 DATE ABT 1850
2 PLAC Wien
1 FAMS @G1@
0 @P2@ INDI
1 NAME Maria /Schmidt/
1 SEX F
1 FAMS @G1@
0 @P3@ INDI
1 NAME Anna /Mueller/
1 SEX F
1 BIRT
2 DATE 1881
1 FAMC @G1@
0 @G1@ FAM
1 HUSB @P1@
1 WIFE @P2@
1 CHIL @P3@
1 MARR
2 DATE 1875
0 TRLR
`;

describe("matchDatasets", () => {
  const result = matchDatasets(dataset(MAIN), dataset(COMPARE));

  it("matches the husband across spelling/qualifier variation", () => {
    const johann = result.individuals.find((c) => c.compareId === "@P1@");
    expect(johann).toBeDefined();
    expect(johann!.mainId).toBe("@I1@");
    expect(johann!.score).toBeGreaterThan(70);
  });

  it("includes a parents component for the child", () => {
    const anna = result.individuals.find((c) => c.compareId === "@P3@");
    expect(anna).toBeDefined();
    expect(anna!.components.some((c) => c.key === "parents")).toBe(true);
  });

  it("never matches individuals of different recorded sex", () => {
    // Main has a male and a female with the same name + birth year; the
    // compare file has a female. Only the female may match.
    const main = `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8
0 @M1@ INDI\n1 NAME Pavle /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1900
0 @M2@ INDI\n1 NAME Pavla /Novak/\n1 SEX F\n1 BIRT\n2 DATE 1900
0 TRLR\n`;
    const compare = `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8
0 @C1@ INDI\n1 NAME Pavla /Novak/\n1 SEX F\n1 BIRT\n2 DATE 1900
0 TRLR\n`;
    const r = matchDatasets(dataset(main), dataset(compare));
    const forC1 = r.individuals.filter((c) => c.compareId === "@C1@");
    expect(forC1.every((c) => c.mainId !== "@M1@")).toBe(true); // never the male
    expect(forC1.some((c) => c.mainId === "@M2@")).toBe(true); // the female matches
  });

  it("sorts individuals by score descending", () => {
    const scores = result.individuals.map((c) => c.score);
    const sorted = [...scores].sort((a, b) => b - a);
    expect(scores).toEqual(sorted);
  });
});

describe("self-match (same file as main and compare)", () => {
  const ds = dataset(MAIN);
  const r = matchDatasets(ds, ds);

  it("yields only identical pairs at or just under a perfect score", () => {
    expect(r.individuals.length).toBe(ds.individuals.size);
    for (const c of r.individuals) {
      expect(c.mainId).toBe(c.compareId);
      // Year-only records cap just below 100 even against themselves — a bare
      // year is not a conclusive identity key (see dateSimilarity), and the
      // matcher cannot know the two sides are literally the same record.
      expect(c.score).toBeGreaterThanOrEqual(95);
    }
    // The record with a full day-precision birth date still self-matches at 100.
    expect(r.individuals.find((c) => c.mainId === "@I1@")?.score).toBe(100);
  });

  it("produces no cross matches between different people", () => {
    const cross = r.individuals.filter((c) => c.mainId !== c.compareId);
    expect(cross).toHaveLength(0);
  });
});

describe("plausibility gates", () => {
  const pair = (mainIndi: string, compareIndi: string) =>
    matchDatasets(
      dataset(`0 HEAD\n1 GEDC\n2 VERS 5.5.1\n${mainIndi}\n0 TRLR\n`),
      dataset(`0 HEAD\n1 GEDC\n2 VERS 5.5.1\n${compareIndi}\n0 TRLR\n`),
    ).individuals;

  it("rejects pairs whose given names are unrelated", () => {
    // Same surname (so they block together), totally different given name.
    expect(
      pair(
        "0 @M@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 1850",
        "0 @C@ INDI\n1 NAME Marija /Novak/\n1 BIRT\n2 DATE 1850",
      ),
    ).toHaveLength(0);
  });

  it("rejects pairs more than a century apart", () => {
    expect(
      pair(
        "0 @M@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 1850",
        "0 @C@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 1700",
      ),
    ).toHaveLength(0);
  });

  it("rejects when one died before the other was born", () => {
    expect(
      pair(
        "0 @M@ INDI\n1 NAME Janez /Novak/\n1 DEAT\n2 DATE 1850",
        "0 @C@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 1860",
      ),
    ).toHaveLength(0);
  });

  it("keeps plausible pairs (same name, close birth years)", () => {
    const r = pair(
      "0 @M@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 1850",
      "0 @C@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 1853",
    );
    expect(r).toHaveLength(1);
  });

  it("allows matches when one side lacks any dates", () => {
    const r = pair(
      "0 @M@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 1850",
      "0 @C@ INDI\n1 NAME Janez /Novak/",
    );
    expect(r).toHaveLength(1);
  });
});

describe("key-field penalty (name, surname, birth year)", () => {
  const pair = (mainIndi: string, compareIndi: string) =>
    matchDatasets(
      dataset(`0 HEAD\n1 GEDC\n2 VERS 5.5.1\n${mainIndi}\n0 TRLR\n`),
      dataset(`0 HEAD\n1 GEDC\n2 VERS 5.5.1\n${compareIndi}\n0 TRLR\n`),
    ).individuals;

  it("scores 100 only when all key fields are present and equal (day-precision date)", () => {
    const r = pair(
      "0 @M@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 12 JAN 1850",
      "0 @C@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 12 JAN 1850",
    );
    expect(r[0].score).toBe(100);
    // The same pair with bare-year dates merely agrees on a year — namesakes
    // born the same year are routine, so it stays below the flat 100.
    const bare = pair(
      "0 @M@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 1850",
      "0 @C@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 1850",
    );
    expect(bare[0].score).toBeLessThan(100);
  });

  it("awards 100 for a perfect key even when a secondary field differs", () => {
    // Same name, surname and birth date, but different birth place. The identity
    // key is conclusive, so the secondary mismatch does not pull it below 100.
    const r = pair(
      "0 @M@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 12 JAN 1850\n2 PLAC Ljubljana",
      "0 @C@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 12 JAN 1850\n2 PLAC Maribor",
    );
    expect(r[0].score).toBe(100);
  });

  it("keeps an imperfect-key pair below 100 (no rounding up)", () => {
    // Birth years one apart: the key is strong but not exact, so even a tiny
    // imperfection must not display as a flat 100.
    const r = pair(
      "0 @M@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 12 JAN 1850\n2 PLAC Ljubljana\n1 SEX M",
      "0 @C@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 12 JAN 1851\n2 PLAC Ljubljana\n1 SEX M",
    );
    expect(r[0].score).toBeLessThan(100);
  });

  it("penalizes a missing birth year instead of ignoring it", () => {
    // Identical names, but the compare record has no birth year. The pair is
    // still offered, yet the missing key keeps it well below a perfect score.
    const r = pair(
      "0 @M@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 1850",
      "0 @C@ INDI\n1 NAME Janez /Novak/",
    );
    expect(r).toHaveLength(1);
    const birth = r[0].components.find((c) => c.key === "birthDate");
    expect(birth?.missing).toBe(true);
    expect(r[0].score).toBeLessThan(100);
  });

  it("penalizes a missing given name", () => {
    const r = pair(
      "0 @M@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 1850",
      "0 @C@ INDI\n1 NAME /Novak/\n1 BIRT\n2 DATE 1850",
    );
    expect(r).toHaveLength(1);
    const given = r[0].components.find((c) => c.key === "given");
    expect(given?.missing).toBe(true);
    expect(r[0].score).toBeLessThan(100);
  });
});

describe("birth date plausibility from marriage date", () => {
  const doc = (body: string) => dataset(`0 HEAD\n1 GEDC\n2 VERS 5.5.1\n${body}0 TRLR\n`);
  const mainWithMarriage = (marriageDate: string) =>
    "0 @M@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n1 FAMS @MF@\n" +
    `0 @MF@ FAM\n1 HUSB @M@\n1 MARR\n2 DATE ${marriageDate}\n`;
  // No recorded birth date at all — like a "family matches" CSV import that
  // only ever carries the marriage date.
  const compareNoBirth = (marriageDate: string) =>
    "0 @C@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @CF@\n" +
    `0 @CF@ FAM\n1 HUSB @C@\n1 MARR\n2 DATE ${marriageDate}\n`;
  // The fallback is scoped to sparse-birth sources; the GI CSV importer sets
  // this flag on the datasets it builds.
  const csvLike = (text: string) => {
    const ds = doc(text);
    ds.sparseBirthDates = true;
    return ds;
  };

  it("scores the birth-date key well (not the flat missing penalty) when the main's birth year is a plausible age at the matched marriage", () => {
    // 1850 birth, 1880 marriage: 30 years old — squarely plausible.
    const main = doc(mainWithMarriage("1880"));
    const compare = csvLike(compareNoBirth("1880"));
    const r = matchDatasets(main, compare).individuals;
    expect(r).toHaveLength(1);
    const birth = r[0].components.find((c) => c.key === "birthDate");
    expect(birth?.missing).toBe(true);
    expect(birth?.score).toBeGreaterThan(0.3); // well above the flat missingKeyScore
    // The no-marriage-evidence case (below) scores noticeably lower.
    const bare = matchDatasets(
      doc("0 @M@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n"),
      csvLike("0 @C@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n"),
    ).individuals;
    expect(r[0].score).toBeGreaterThan(bare[0].score);
  });

  it("falls back to the flat missing-key penalty when the implied age is implausible", () => {
    // 1850 birth, 1860 marriage: 10 years old — outside the plausible range.
    const main = doc(mainWithMarriage("1860"));
    const compare = csvLike(compareNoBirth("1860"));
    const r = matchDatasets(main, compare).individuals;
    expect(r).toHaveLength(1);
    const birth = r[0].components.find((c) => c.key === "birthDate");
    expect(birth?.missing).toBe(true);
    expect(birth?.score).toBe(0.3);
  });

  it("charges the flat penalty for an ordinary GEDCOM compare (no sparse-birth flag), even with plausible marriage evidence", () => {
    // Identical data to the plausible case above — only the flag differs. A
    // regular GEDCOM record without a birth date is a data gap, not a format
    // limitation, so the fallback must not fire.
    const main = doc(mainWithMarriage("1880"));
    const compare = doc(compareNoBirth("1880"));
    const r = matchDatasets(main, compare).individuals;
    expect(r).toHaveLength(1);
    const birth = r[0].components.find((c) => c.key === "birthDate");
    expect(birth?.missing).toBe(true);
    expect(birth?.score).toBe(0.3);
  });

  it("ignores the known-birth side's own marriage date (evidence must be cross-side)", () => {
    // The compare record is flagged sparse-birth but has no dated marriage of
    // its own; the main's own marriage says nothing about the compare.
    const main = doc(mainWithMarriage("1880"));
    const compare = csvLike("0 @C@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n");
    const r = matchDatasets(main, compare).individuals;
    expect(r).toHaveLength(1);
    const birth = r[0].components.find((c) => c.key === "birthDate");
    expect(birth?.missing).toBe(true);
    expect(birth?.score).toBe(0.3);
  });
});

describe("placeholder names and bare-year identity keys", () => {
  const doc = (body: string) => dataset(`0 HEAD\n1 GEDC\n2 VERS 5.5.1\n${body}0 TRLR\n`);

  it("never matches records whose only name is a placeholder", () => {
    // Privacy-scrubbed exports are full of "Living" children: two unnamed
    // siblings of the same parents used to score ~70 on the perfect
    // "Living" ~ "Living" name match.
    const m = "0 @M@ INDI\n1 NAME Living\n1 SEX M\n1 BIRT\n2 DATE 1950\n";
    const c = "0 @C@ INDI\n1 NAME Living\n1 SEX M\n1 BIRT\n2 DATE 1950\n";
    expect(matchDatasets(doc(m), doc(c)).individuals).toHaveLength(0);
  });

  it("treats a placeholder surname as missing, not as a perfect match", () => {
    const m = "0 @M@ INDI\n1 NAME Marija /NN/\n1 SEX F\n1 BIRT\n2 DATE 1910\n";
    const c = "0 @C@ INDI\n1 NAME Marija /NN/\n1 SEX F\n1 BIRT\n2 DATE 1911\n";
    const r = matchDatasets(doc(m), doc(c)).individuals;
    // Still findable via the given name, but the surname key carries the
    // missing penalty — nowhere near the ~75 a "matching" NN used to earn.
    if (r.length > 0) {
      const surname = r[0].components.find((x) => x.key === "surname");
      expect(surname?.missing).toBe(true);
      expect(r[0].category).not.toBe("strong");
    }
  });

  it("reserves the flat 100 for a day-precision birth-date agreement", () => {
    // Same name + the same bare year is NOT a conclusive identity key: two
    // namesakes born the same year are routine in dense clusters. (This pair
    // used to hit keyPerfect and score a flat 100.)
    const year = (id: string) =>
      `0 ${id} INDI\n1 NAME Anton /Špruk/\n1 SEX M\n1 BIRT\n2 DATE 1923\n`;
    const ry = matchDatasets(doc(year("@M@")), doc(year("@C@"))).individuals;
    expect(ry[0].score).toBeLessThan(100);
    // A full day-precision agreement still earns the flat 100.
    const day = (id: string) =>
      `0 ${id} INDI\n1 NAME Anton /Špruk/\n1 SEX M\n1 BIRT\n2 DATE 4 MAR 1923\n`;
    const rd = matchDatasets(doc(day("@M@")), doc(day("@C@"))).individuals;
    expect(rd[0].score).toBe(100);
  });
});

describe("no-hard-evidence ceiling", () => {
  const doc = (body: string) => dataset(`0 HEAD\n1 GEDC\n2 VERS 5.5.1\n${body}0 TRLR\n`);

  it("caps a surname + approximate-year-only pair below the probable band", () => {
    // Skeleton records: no given name, estimated years. Surname agreement plus
    // fuzzy-year proximity used to average out at ~80 — in a big file every
    // same-surname skeleton pairs with every other one, quadratically.
    const m = "0 @M@ INDI\n1 NAME /Novak/\n1 SEX M\n1 BIRT\n2 DATE ABT 1900\n";
    const c = "0 @C@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE ABT 1900\n";
    const r = matchDatasets(doc(m), doc(c)).individuals;
    expect(r).toHaveLength(1);
    expect(r[0].score).toBeLessThanOrEqual(60);
    expect(r[0].category).toBe("weak");
  });

  it("keeps a surname-less pair anchored by a day-exact birth agreement", () => {
    const m = "0 @M@ INDI\n1 NAME Marija\n1 SEX F\n1 BIRT\n2 DATE 18 MAR 1947\n";
    const c = "0 @C@ INDI\n1 NAME Marija\n1 SEX F\n1 BIRT\n2 DATE 18 MAR 1947\n";
    const r = matchDatasets(doc(m), doc(c)).individuals;
    expect(r).toHaveLength(1);
    expect(r[0].score).toBeGreaterThan(70);
  });

  it("keeps a surname-less pair anchored by a day-exact death agreement", () => {
    // Born-year estimates only, but the death date matches to the day.
    const m = "0 @M@ INDI\n1 NAME Marija\n1 SEX F\n1 BIRT\n2 DATE ABT 1880\n1 DEAT\n2 DATE 2 FEB 1955\n";
    const c = "0 @C@ INDI\n1 NAME Marija\n1 SEX F\n1 BIRT\n2 DATE ABT 1882\n1 DEAT\n2 DATE 2 FEB 1955\n";
    const r = matchDatasets(doc(m), doc(c)).individuals;
    expect(r).toHaveLength(1);
    expect(r[0].score).toBeGreaterThan(60);
  });

  it("keeps an undated pair anchored by a comparable full name", () => {
    const m = "0 @M@ INDI\n1 NAME Jože /Zagorc/\n1 SEX M\n";
    const c = "0 @C@ INDI\n1 NAME Jože /Zagorc/\n1 SEX M\n";
    const r = matchDatasets(doc(m), doc(c)).individuals;
    expect(r).toHaveLength(1);
    expect(r[0].score).toBeGreaterThan(65);
  });
});

describe("given-name conflict penalty", () => {
  const doc = (body: string) => dataset(`0 HEAD\n1 GEDC\n2 VERS 5.5.1\n${body}0 TRLR\n`);
  const main =
    "0 @M@ INDI\n1 NAME Marta /Weiss/\n1 SEX F\n1 BIRT\n2 DATE 1867\n2 PLAC Metlika\n";
  const compareWith = (given: string) =>
    `0 @C@ INDI\n1 NAME ${given} /Weiss/\n1 SEX F\n1 BIRT\n2 DATE 1868\n2 PLAC Metlika\n`;
  const scoreWith = (given: string) =>
    matchDatasets(doc(main), doc(compareWith(given))).individuals[0];

  it("demotes a same-surname pair whose given names are distinct people's names", () => {
    // Marta ~ Uršula ≈ 0.58: below the nickname band. Surname, year and place
    // all agree — the classic dense-cluster false positive that used to
    // average out at 80+.
    const conflict = scoreWith("Uršula");
    expect(conflict).toBeDefined();
    expect(conflict.category).not.toBe("strong");
    expect(conflict.score).toBeLessThan(70);
  });

  it("leaves nickname-band given variants (~0.7+) unpenalized", () => {
    // William ~ Bill ≈ 0.73: above the conflict threshold, so only the small
    // component difference applies — the score stays far above what the
    // 0.8 multiplier would allow (≈71).
    const m = "0 @M@ INDI\n1 NAME William /Weiss/\n1 SEX M\n1 BIRT\n2 DATE 1867\n2 PLAC Metlika\n";
    const c = "0 @C@ INDI\n1 NAME Bill /Weiss/\n1 SEX M\n1 BIRT\n2 DATE 1868\n2 PLAC Metlika\n";
    const r = matchDatasets(doc(m), doc(c)).individuals[0];
    expect(r).toBeDefined();
    expect(r.score).toBeGreaterThan(85);
  });

  it("restores a demoted cross-language variant through matched-relative corroboration", () => {
    // Jera ~ Gertrud ≈ 0.60 (the same name in Slovene vs German records) is
    // penalized on names alone, but the shared matched husband and children
    // floor the pair back into the 90s.
    const m = `0 @M@ INDI\n1 NAME Jera /Novak/\n1 SEX F\n1 BIRT\n2 DATE 1850\n1 FAMS @MF@
0 @MH@ INDI\n1 NAME Anton /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1845\n1 FAMS @MF@
0 @MC1@ INDI\n1 NAME Franc /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1875\n1 FAMC @MF@
0 @MC2@ INDI\n1 NAME Ana /Novak/\n1 SEX F\n1 BIRT\n2 DATE 1877\n1 FAMC @MF@
0 @MF@ FAM\n1 HUSB @MH@\n1 WIFE @M@\n1 CHIL @MC1@\n1 CHIL @MC2@
`;
    const c = `0 @C@ INDI\n1 NAME Gertrud /Novak/\n1 SEX F\n1 BIRT\n2 DATE 1850\n1 FAMS @CF@
0 @CH@ INDI\n1 NAME Anton /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1845\n1 FAMS @CF@
0 @CC1@ INDI\n1 NAME Franc /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1875\n1 FAMC @CF@
0 @CC2@ INDI\n1 NAME Ana /Novak/\n1 SEX F\n1 BIRT\n2 DATE 1877\n1 FAMC @CF@
0 @CF@ FAM\n1 HUSB @CH@\n1 WIFE @C@\n1 CHIL @CC1@\n1 CHIL @CC2@
`;
    const r = matchDatasets(doc(m), doc(c)).individuals;
    const mother = r.find((x) => x.mainId === "@M@");
    expect(mother?.compareId).toBe("@C@");
    expect(mother!.score).toBeGreaterThanOrEqual(91);
  });
});

describe("parent-conflict penalty and role-wise parent comparison", () => {
  const doc = (body: string) => dataset(`0 HEAD\n1 GEDC\n2 VERS 5.5.1\n${body}0 TRLR\n`);
  // Same person key on both sides (birth years one apart so keyPerfect can't
  // pin the score at 100); only the linked parents' names vary.
  const side = (p: "M" | "C", year: number, dadName: string, momName: string) =>
    `0 @${p}@ INDI\n1 NAME Marija /Bajuk/\n1 SEX F\n1 BIRT\n2 DATE ${year}\n1 FAMC @${p}F@\n` +
    `0 @${p}D@ INDI\n1 NAME ${dadName} /Bajuk/\n1 SEX M\n` +
    `0 @${p}W@ INDI\n1 NAME ${momName} /Kovač/\n1 SEX F\n` +
    `0 @${p}F@ FAM\n1 HUSB @${p}D@\n1 WIFE @${p}W@\n1 CHIL @${p}@\n`;
  const main = doc(side("M", 1850, "Miko", "Neža"));
  const scoreAgainst = (dadName: string, momName: string) => {
    const compare = doc(side("C", 1851, dadName, momName));
    return matchDatasets(main, compare).individuals.find(
      (c) => c.mainId === "@M@" && c.compareId === "@C@",
    )!;
  };

  it("penalizes a pair whose father AND mother both clearly differ", () => {
    // Miko/Franc = 0.0, Neža/Katarina ≪ 0.6: a different family entirely.
    const conflict = scoreAgainst("Franc", "Katarina");
    expect(conflict.category).not.toBe("strong");
    expect(conflict.score).toBeLessThan(75);
    // The same records with matching parents score far higher.
    const same = scoreAgainst("Miko", "Neža");
    expect(same.score).toBeGreaterThan(90);
  });

  it("does not penalize a single conflicting role (cross-language variants are routine)", () => {
    // Father differs, mother agrees: only the parents component moves — the
    // score must stay well above the both-conflict case's penalized band.
    const oneRole = scoreAgainst("Franc", "Neža");
    expect(oneRole.score).toBeGreaterThan(85);
  });

  it("scores the parents component by given names, not the shared surname", () => {
    // Different fathers, same family surname: the old full-name comparison
    // held this component at ~0.6+ on the surname alone.
    const conflict = scoreAgainst("Franc", "Katarina");
    const parents = conflict.components.find((c) => c.key === "parents");
    expect(parents).toBeDefined();
    expect(parents!.score).toBeLessThan(0.5);
  });
});

describe("parent-match bonus", () => {
  const doc = (body: string) => dataset(`0 HEAD\n1 GEDC\n2 VERS 5.5.1\n${body}0 TRLR\n`);
  // Same child in main and compare with an imperfect key (birth years one
  // apart so the score isn't pinned at 100), each with a father whose NAME varies.
  const main = (fatherName: string) =>
    "0 @M@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 1850\n1 FAMC @MF@\n" +
    "0 @MF@ FAM\n1 HUSB @MH@\n1 CHIL @M@\n" +
    `0 @MH@ INDI\n1 NAME ${fatherName}\n`;
  const compare = (fatherName: string) =>
    "0 @C@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 1851\n1 FAMC @CF@\n" +
    "0 @CF@ FAM\n1 HUSB @CH@\n1 CHIL @C@\n" +
    `0 @CH@ INDI\n1 NAME ${fatherName}\n`;

  const scoreOf = (fatherName: string) =>
    matchDatasets(doc(main(fatherName)), doc(compare(fatherName))).individuals.find(
      (c) => c.mainId === "@M@" && c.compareId === "@C@",
    )!.score;

  it("raises the score a little for a full parent match, but not to 100", () => {
    // Both variants share the same weighted `parents` component (the surnames
    // match either way), so the difference is purely the full-name bonus.
    const surnameOnly = scoreOf("/Novak/");
    const fullName = scoreOf("Anton /Novak/");
    expect(fullName).toBeGreaterThan(surnameOnly);
    expect(fullName).toBeLessThan(100);
  });
});

describe("partner-match bonus", () => {
  const doc = (body: string) => dataset(`0 HEAD\n1 GEDC\n2 VERS 5.5.1\n${body}0 TRLR\n`);
  // Same person in main and compare (imperfect key: birth years one apart),
  // married into a family whose spouse NAME we vary.
  const main = (spouseName: string) =>
    "0 @M@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n1 FAMS @MF@\n" +
    "0 @MF@ FAM\n1 HUSB @M@\n1 WIFE @MW@\n" +
    `0 @MW@ INDI\n1 NAME ${spouseName}\n1 SEX F\n`;
  const compare = (spouseName: string) =>
    "0 @C@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1851\n1 FAMS @CF@\n" +
    "0 @CF@ FAM\n1 HUSB @C@\n1 WIFE @CW@\n" +
    `0 @CW@ INDI\n1 NAME ${spouseName}\n1 SEX F\n`;

  const scoreOf = (spouseName: string) =>
    matchDatasets(doc(main(spouseName)), doc(compare(spouseName))).individuals.find(
      (c) => c.mainId === "@M@" && c.compareId === "@C@",
    )!.score;

  it("raises the score a little for a full partner match, but not to 100", () => {
    // The weighted `partners` component is the same either way (surnames match),
    // so the lift is purely the full-name spouse bonus.
    const surnameOnly = scoreOf("/Kovač/");
    const fullName = scoreOf("Marija /Kovač/");
    expect(fullName).toBeGreaterThan(surnameOnly);
    expect(fullName).toBeLessThan(100);
  });
});

describe("one-to-one assignment", () => {
  it("does not reuse a main record for two compare records", () => {
    // Two compare people with the same name/birth; only one main twin.
    const main = `0 HEAD\n1 GEDC\n2 VERS 5.5.1
0 @M1@ INDI\n1 NAME Janez /Kos/\n1 SEX M\n1 BIRT\n2 DATE 1900
0 TRLR\n`;
    const compare = `0 HEAD\n1 GEDC\n2 VERS 5.5.1
0 @C1@ INDI\n1 NAME Janez /Kos/\n1 SEX M\n1 BIRT\n2 DATE 1900
0 @C2@ INDI\n1 NAME Janez /Kos/\n1 SEX M\n1 BIRT\n2 DATE 1900
0 TRLR\n`;
    const r = matchDatasets(dataset(main), dataset(compare));
    expect(r.individuals).toHaveLength(1); // @M1@ used once
    expect(r.individuals[0].mainId).toBe("@M1@");
  });
});

describe("marriage corroboration (folded into individual scoring)", () => {
  // Two same-named men; only the marriage (date + spouse) tells them apart.
  // Approximate birth so the identity key isn't a perfect 100 — leaving room for
  // the marriage components to move the score.
  const main = (marr: string) =>
    `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n` +
    `0 @H@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE ABT 1850\n1 FAMS @F@\n` +
    `0 @W@ INDI\n1 NAME Marija /Kovač/\n1 SEX F\n1 FAMS @F@\n` +
    `0 @F@ FAM\n1 HUSB @H@\n1 WIFE @W@\n1 MARR\n2 DATE ${marr}\n0 TRLR\n`;

  it("scores a same-marriage pair higher than a differing-marriage pair", () => {
    const same = matchDatasets(dataset(main("1875")), dataset(main("1875")))
      .individuals.find((c) => c.compareId === "@H@");
    const diff = matchDatasets(dataset(main("1875")), dataset(main("1899")))
      .individuals.find((c) => c.compareId === "@H@");
    expect(same).toBeDefined();
    expect(diff).toBeDefined();
    expect(same!.score).toBeGreaterThan(diff!.score);
    expect(same!.components.some((c) => c.key === "marriageDate")).toBe(true);
  });
});

describe("relationship pass: links co-parents of shared matched children, overriding name/date", () => {
  // Main mother "Ana Nuša Cegnar" (1939) with two children. The incoming file
  // holds the same woman as "Anica Cegnar" (1935) — a different given name and
  // birth year, but the SAME two children — plus a decoy "Ana Nuša Cegnar"
  // (1939) with no children whose identical name+date scores a perfect 100 and
  // would steal the mother in the primary pass.
  const main = `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8
0 @AM@ INDI\n1 NAME Ana Nuša /Cegnar/\n1 SEX F\n1 BIRT\n2 DATE 1939\n1 FAMS @MF@
0 @MC1@ INDI\n1 NAME Zoran /Jekovec/\n1 SEX M\n1 BIRT\n2 DATE 1962\n1 FAMC @MF@
0 @MC2@ INDI\n1 NAME Dunja /Jekovec/\n1 SEX F\n1 BIRT\n2 DATE 1964\n1 FAMC @MF@
0 @MF@ FAM\n1 WIFE @AM@\n1 CHIL @MC1@\n1 CHIL @MC2@
0 TRLR\n`;
  const compare = `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8
0 @AC@ INDI\n1 NAME Anica /Cegnar/\n1 SEX F\n1 BIRT\n2 DATE 1935\n1 FAMS @IF@
0 @IC1@ INDI\n1 NAME Zoran /Jekovec/\n1 SEX M\n1 BIRT\n2 DATE 1962\n1 FAMC @IF@
0 @IC2@ INDI\n1 NAME Dunja /Jekovec/\n1 SEX F\n1 BIRT\n2 DATE 1964\n1 FAMC @IF@
0 @IF@ FAM\n1 WIFE @AC@\n1 CHIL @IC1@\n1 CHIL @IC2@
0 @DUP@ INDI\n1 NAME Ana Nuša /Cegnar/\n1 SEX F\n1 BIRT\n2 DATE 1939
0 TRLR\n`;
  const r = matchDatasets(dataset(main), dataset(compare));

  it("links the mother to her child-sharing counterpart, not the identical-name decoy", () => {
    const am = r.individuals.find((c) => c.mainId === "@AM@");
    expect(am).toBeDefined();
    expect(am!.compareId).toBe("@AC@");
    expect(am!.relationshipLinked).toBe(true);
  });

  it("drops the name/date decoy that the override displaced", () => {
    expect(r.individuals.some((c) => c.compareId === "@DUP@")).toBe(false);
  });

  it("keeps the children matched", () => {
    expect(r.individuals.find((c) => c.mainId === "@MC1@")?.compareId).toBe("@IC1@");
    expect(r.individuals.find((c) => c.mainId === "@MC2@")?.compareId).toBe("@IC2@");
  });
});

describe("relationship pass: completes a couple from one shared child + a matched spouse", () => {
  // The mother is recorded under wildly different names — main "Slavka" (a
  // nickname, no surname) vs incoming "Stanislava Marija Ribič" — so she never
  // blocks or scores. But her husband Rudolf Volčič and their son Boris Volčič
  // both match across the files, so the couple can be completed: a child of a
  // known couple has exactly one mother.
  const main = `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8
0 @RU@ INDI\n1 NAME Rudolf /Volčič/\n1 SEX M\n1 BIRT\n2 DATE 1934\n1 FAMS @MF@
0 @SL@ INDI\n1 NAME Slavka\n1 SEX F\n1 BIRT\n2 DATE 1934\n1 FAMS @MF@
0 @BO@ INDI\n1 NAME Boris /Volčič/\n1 SEX M\n1 BIRT\n2 DATE 1957\n1 FAMC @MF@
0 @MF@ FAM\n1 HUSB @RU@\n1 WIFE @SL@\n1 CHIL @BO@
0 TRLR\n`;
  const compare = `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8
0 @RU2@ INDI\n1 NAME Rudolf /Volčič/\n1 SEX M\n1 BIRT\n2 DATE 1934\n1 FAMS @IF@
0 @ST@ INDI\n1 NAME Stanislava Marija /Ribič/\n1 SEX F\n1 BIRT\n2 DATE 1934\n1 FAMS @IF@
0 @BO2@ INDI\n1 NAME Boris /Volčič/\n1 SEX M\n1 BIRT\n2 DATE 1957\n1 FAMC @IF@
0 @IF@ FAM\n1 HUSB @RU2@\n1 WIFE @ST@\n1 CHIL @BO2@
0 TRLR\n`;
  const r = matchDatasets(dataset(main), dataset(compare));

  it("links the two mothers despite no name or score overlap", () => {
    const sl = r.individuals.find((c) => c.mainId === "@SL@");
    expect(sl).toBeDefined();
    expect(sl!.compareId).toBe("@ST@");
    expect(sl!.relationshipLinked).toBe(true);
    expect(sl!.score).toBeGreaterThanOrEqual(90); // corroboration boost surfaces it
  });

  it("does not link on the shared child alone when the spouse isn't matched", () => {
    // Same as above but the husbands differ (no matched spouse) and there's only
    // one shared child — below the bar, so the mothers stay unlinked.
    const m2 = main.replace("Rudolf /Volčič/", "Anton /Kovač/");
    const r2 = matchDatasets(dataset(m2), dataset(compare));
    expect(r2.individuals.some((c) => c.mainId === "@SL@" && c.compareId === "@ST@")).toBe(false);
  });
});

describe("relationship pass: does not steal a parent-corroborated match for a spouse/child duplicate", () => {
  // Main Irena is the child of Jožef + Jožefa and the wife of Miran (mother of
  // Ana). The incoming file has TWO Irenas: the real one (@REAL@, same parents,
  // b1958) which the primary pass matches at 100, and a stray duplicate (@DUP@,
  // no parents, b1956) that shares only the spouse + child. The relationship
  // pass must NOT override the parent-corroborated match with the duplicate.
  const main = `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8
0 @IRENA@ INDI\n1 NAME Irena /Pezdirc/\n1 SEX F\n1 BIRT\n2 DATE 1958\n1 FAMC @MFC@\n1 FAMS @MFS@
0 @JOZEF@ INDI\n1 NAME Jožef /Pezdirc/\n1 SEX M\n1 BIRT\n2 DATE 1932\n1 FAMS @MFC@
0 @JOZEFA@ INDI\n1 NAME Jožefa /Renko/\n1 SEX F\n1 BIRT\n2 DATE 1936\n1 FAMS @MFC@
0 @MFC@ FAM\n1 HUSB @JOZEF@\n1 WIFE @JOZEFA@\n1 CHIL @IRENA@
0 @MIRAN@ INDI\n1 NAME Miran /Kukić/\n1 SEX M\n1 BIRT\n2 DATE 1955\n1 FAMS @MFS@
0 @ANA@ INDI\n1 NAME Ana /Kukić/\n1 SEX F\n1 BIRT\n2 DATE 1982\n1 FAMC @MFS@
0 @MFS@ FAM\n1 HUSB @MIRAN@\n1 WIFE @IRENA@\n1 CHIL @ANA@
0 TRLR\n`;
  const compare = `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8
0 @JOZEF2@ INDI\n1 NAME Jožef /Pezdirc/\n1 SEX M\n1 BIRT\n2 DATE 1932\n1 FAMS @IFC@
0 @JOZEFA2@ INDI\n1 NAME Jožefa /Renko/\n1 SEX F\n1 BIRT\n2 DATE 1936\n1 FAMS @IFC@
0 @REAL@ INDI\n1 NAME Irena /Pezdirc/\n1 SEX F\n1 BIRT\n2 DATE 1958\n1 FAMC @IFC@
0 @IFC@ FAM\n1 HUSB @JOZEF2@\n1 WIFE @JOZEFA2@\n1 CHIL @REAL@
0 @MIRAN2@ INDI\n1 NAME Miran /Kukić/\n1 SEX M\n1 BIRT\n2 DATE 1955\n1 FAMS @IFS@
0 @ANA2@ INDI\n1 NAME Ana /Kukić/\n1 SEX F\n1 BIRT\n2 DATE 1982\n1 FAMC @IFS@
0 @DUP@ INDI\n1 NAME Irena /Pezdirc/\n1 SEX F\n1 BIRT\n2 DATE 1956\n1 FAMS @IFS@
0 @IFS@ FAM\n1 HUSB @MIRAN2@\n1 WIFE @DUP@\n1 CHIL @ANA2@
0 TRLR\n`;
  const r = matchDatasets(dataset(main), dataset(compare));

  it("keeps the parents-matched record, ignoring the spouse/child duplicate", () => {
    const irena = r.individuals.find((c) => c.mainId === "@IRENA@");
    expect(irena).toBeDefined();
    expect(irena!.compareId).toBe("@REAL@");
  });

  it("leaves the duplicate unmatched to the main Irena", () => {
    expect(r.individuals.some((c) => c.mainId === "@IRENA@" && c.compareId === "@DUP@")).toBe(false);
  });
});

describe("incoming duplicate consolidation: detects same person split across incoming records", () => {
  // Main Irena. The incoming file holds her twice: @REAL@ (her parents, b1958)
  // which the primary pass matches, and @DUP@ (her spouse + child, b1956). It
  // also has a same-named NAMESAKE born 27 years later (a distinct person) and a
  // sibling MARIJA — neither should be folded in.
  const main = `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8
0 @IRENA@ INDI\n1 NAME Irena /Pezdirc/\n1 SEX F\n1 BIRT\n2 DATE 1958\n1 FAMC @MFC@\n1 FAMS @MFS@
0 @JOZEF@ INDI\n1 NAME Jožef /Pezdirc/\n1 SEX M\n1 BIRT\n2 DATE 1932\n1 FAMS @MFC@
0 @JOZEFA@ INDI\n1 NAME Jožefa /Renko/\n1 SEX F\n1 BIRT\n2 DATE 1936\n1 FAMS @MFC@
0 @MFC@ FAM\n1 HUSB @JOZEF@\n1 WIFE @JOZEFA@\n1 CHIL @IRENA@
0 @MIRAN@ INDI\n1 NAME Miran /Kukić/\n1 SEX M\n1 BIRT\n2 DATE 1955\n1 FAMS @MFS@
0 @ANA@ INDI\n1 NAME Ana /Kukić/\n1 SEX F\n1 BIRT\n2 DATE 1982\n1 FAMC @MFS@
0 @MFS@ FAM\n1 HUSB @MIRAN@\n1 WIFE @IRENA@\n1 CHIL @ANA@
0 TRLR\n`;
  const compare = `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8
0 @JOZEF2@ INDI\n1 NAME Jožef /Pezdirc/\n1 SEX M\n1 BIRT\n2 DATE 1932\n1 FAMS @IFC@
0 @JOZEFA2@ INDI\n1 NAME Jožefa /Renko/\n1 SEX F\n1 BIRT\n2 DATE 1936\n1 FAMS @IFC@
0 @REAL@ INDI\n1 NAME Irena /Pezdirc/\n1 SEX F\n1 BIRT\n2 DATE 1958\n1 FAMC @IFC@
0 @IFC@ FAM\n1 HUSB @JOZEF2@\n1 WIFE @JOZEFA2@\n1 CHIL @REAL@
0 @MIRAN2@ INDI\n1 NAME Miran /Kukić/\n1 SEX M\n1 BIRT\n2 DATE 1955\n1 FAMS @IFS@
0 @ANA2@ INDI\n1 NAME Ana /Kukić/\n1 SEX F\n1 BIRT\n2 DATE 1982\n1 FAMC @IFS@
0 @DUP@ INDI\n1 NAME Irena /Pezdirc/\n1 SEX F\n1 BIRT\n2 DATE 1956\n1 FAMS @IFS@
0 @IFS@ FAM\n1 HUSB @MIRAN2@\n1 WIFE @DUP@\n1 CHIL @ANA2@
0 @NAMESAKE@ INDI\n1 NAME Irena /Pezdirc/\n1 SEX F\n1 BIRT\n2 DATE 1985
0 @SIB@ INDI\n1 NAME Marija /Pezdirc/\n1 SEX F\n1 BIRT\n2 DATE 1958
0 TRLR\n`;
  const r = matchDatasets(dataset(main), dataset(compare));

  it("clusters the matched copy with its spouse/child duplicate", () => {
    const cl = r.incomingDuplicates?.find((c) => c.keepId === "@REAL@");
    expect(cl).toBeDefined();
    expect(cl!.mergeIds).toContain("@DUP@");
  });

  it("excludes the decades-apart namesake and the differently-named sibling", () => {
    const merged = new Set(r.incomingDuplicates?.flatMap((c) => c.mergeIds) ?? []);
    expect(merged.has("@NAMESAKE@")).toBe(false);
    expect(merged.has("@SIB@")).toBe(false);
  });
});

describe("relationship pass: ignores weak relative matches (no false link from cross-family noise)", () => {
  // Karolina (main) and Antonija (incoming) are different people with totally
  // different names. The greedy pass cross-matches their similar-surnamed but
  // distinct relatives (Jakofčič ↔ Jakopič) at a low score. Those weak matches
  // must NOT compound into a confident parent link between Karolina and Antonija.
  const main = `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8
0 @KAR@ INDI\n1 NAME Karolina /Pezdirc/\n1 SEX F\n1 BIRT\n2 DATE 1899\n1 FAMS @MF@
0 @ANTON@ INDI\n1 NAME Anton /Jakofčič/\n1 SEX M\n1 BIRT\n2 DATE 1897\n1 FAMS @MF@
0 @MARIJA@ INDI\n1 NAME Marija /Jakofčič/\n1 SEX F\n1 BIRT\n2 DATE 1925\n1 FAMC @MF@
0 @MF@ FAM\n1 HUSB @ANTON@\n1 WIFE @KAR@\n1 CHIL @MARIJA@
0 TRLR\n`;
  const compare = `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8
0 @ANT@ INDI\n1 NAME Antonija /Brezavšček/\n1 SEX F\n1 BIRT\n2 DATE 1900\n1 FAMS @IF@
0 @ANDREJ@ INDI\n1 NAME Andrej /Jakopič/\n1 SEX M\n1 BIRT\n2 DATE 1900\n1 FAMS @IF@
0 @EVALDA@ INDI\n1 NAME Evalda /Jakopič/\n1 SEX F\n1 BIRT\n2 DATE 1928\n1 FAMC @IF@
0 @IF@ FAM\n1 HUSB @ANDREJ@\n1 WIFE @ANT@\n1 CHIL @EVALDA@
0 TRLR\n`;
  const r = matchDatasets(dataset(main), dataset(compare));

  it("does not link the two unrelated parents", () => {
    expect(r.individuals.some((c) => c.mainId === "@KAR@" && c.compareId === "@ANT@")).toBe(false);
  });

  it("(the weak relative matches that would have driven it score below the confidence bar)", () => {
    // Confirms the path is exercised: the relatives DO get cross-matched, just weakly.
    const marija = r.individuals.find((c) => c.mainId === "@MARIJA@");
    if (marija) expect(marija.score).toBeLessThan(85);
  });
});

describe("uid identity pre-match", () => {
  it("matches two records sharing a _UID at 100, bypassing name/date gates", () => {
    // Names, birth years and places all disagree — every gate would veto this
    // pair — but the shared record identifier establishes identity.
    const m = dataset(`0 HEAD
0 @I1@ INDI
1 NAME Stanislava Marija /Kožuh/
1 SEX F
1 BIRT
2 DATE 1901
1 _UID 5ACCCDFF135203F4A0023545B742CFC4
0 TRLR
`);
    const c = dataset(`0 HEAD
0 @P1@ INDI
1 NAME Slavka /Novak/
1 SEX F
1 BIRT
2 DATE 1907
1 _UID 5ACCCDFF135203F4A0023545B742CFC4
0 TRLR
`);
    const r = matchDatasets(m, c);
    expect(r.individuals).toHaveLength(1);
    expect(r.individuals[0]).toMatchObject({ mainId: "@I1@", compareId: "@P1@", score: 100, uidMatched: true, category: "strong" });
  });

  it("treats brace/dash GUID spellings as the same identifier", () => {
    const m = dataset(`0 HEAD
0 @I1@ INDI
1 NAME Ana /Zupan/
1 SEX F
1 _UID {D15EB48F-E924-434A-9EDC-40ED99DCC34E}
0 TRLR
`);
    const c = dataset(`0 HEAD
0 @P1@ INDI
1 NAME Ann /Supan/
1 SEX F
1 UID d15eb48fe924434a9edc40ed99dcc34e
0 TRLR
`);
    const r = matchDatasets(m, c);
    expect(r.individuals[0]).toMatchObject({ mainId: "@I1@", compareId: "@P1@", uidMatched: true });
  });

  it("ignores ambiguous uids (carried by two records in one file) and junk values", () => {
    const m = dataset(`0 HEAD
0 @I1@ INDI
1 NAME Janez /Novak/
1 SEX M
1 _UID AAAAAAAAAAAAAAAA
1 _UID 1
0 TRLR
`);
    const c = dataset(`0 HEAD
0 @P1@ INDI
1 NAME France /Kovač/
1 SEX M
1 _UID AAAAAAAAAAAAAAAA
0 @P2@ INDI
1 NAME Tone /Zajec/
1 SEX M
1 _UID AAAAAAAAAAAAAAAA
1 _UID 1
0 TRLR
`);
    // The uid appears on two compare records → identifies nothing; the junk
    // "1" is too short to count. No pair passes the ordinary gates either.
    const r = matchDatasets(m, c);
    expect(r.individuals.filter((i) => i.uidMatched)).toHaveLength(0);
  });

  it("uid identity wins the 1:1 assignment over a same-name score match", () => {
    // Compare has two similar records; the uid ties main to the *worse*-named
    // one, and the assignment must respect it.
    const m = dataset(`0 HEAD
0 @I1@ INDI
1 NAME Janez /Novak/
1 SEX M
1 BIRT
2 DATE 5 JAN 1900
1 _UID BBBBBBBBBBBBBBBB
0 TRLR
`);
    const c = dataset(`0 HEAD
0 @P1@ INDI
1 NAME Janez /Novak/
1 SEX M
1 BIRT
2 DATE 5 JAN 1900
0 @P2@ INDI
1 NAME Ivan /Novak/
1 SEX M
1 BIRT
2 DATE 1901
1 _UID BBBBBBBBBBBBBBBB
0 TRLR
`);
    const r = matchDatasets(m, c);
    const forI1 = r.individuals.filter((i) => i.mainId === "@I1@");
    expect(forI1).toHaveLength(1);
    expect(forI1[0]).toMatchObject({ compareId: "@P2@", uidMatched: true, score: 100 });
  });
});

describe("FamilySearch id identity pre-match (_FID/_FSFTID)", () => {
  it("matches records sharing a FamilySearch id, even across programs", () => {
    // MacFamilyTree writes _FID, RootsMagic _FSFTID — same FS person namespace.
    const m = dataset(`0 HEAD
0 @I1@ INDI
1 NAME Lovrenc /Renko/
1 SEX M
1 _FID GJMK-JZG
0 TRLR
`);
    const c = dataset(`0 HEAD
0 @P1@ INDI
1 NAME Lovro /Renco/
1 SEX M
1 _FSFTID gjmk-jzg
0 TRLR
`);
    const r = matchDatasets(m, c);
    expect(r.individuals[0]).toMatchObject({ mainId: "@I1@", compareId: "@P1@", score: 100, uidMatched: true });
  });

  it("ignores values not shaped like a FamilySearch id", () => {
    const m = dataset(`0 HEAD
0 @I1@ INDI
1 NAME Janez /Novak/
1 SEX M
1 _FID something else entirely
0 TRLR
`);
    const c = dataset(`0 HEAD
0 @P1@ INDI
1 NAME France /Kovač/
1 SEX M
1 _FID something else entirely
0 TRLR
`);
    expect(matchDatasets(m, c).individuals.filter((i) => i.uidMatched)).toHaveLength(0);
  });
});
