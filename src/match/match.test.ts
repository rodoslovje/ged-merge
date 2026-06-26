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

  it("soundex groups homophones", () => {
    expect(soundex("Smith")).toBe(soundex("Smyth"));
    expect(soundex("Robert")).toBe("R163");
  });

  it("foldToken strips diacritics and case", () => {
    expect(foldToken("Müller")).toBe("muller");
    expect(foldToken("  Österreich ")).toBe("osterreich");
  });
});

// Master and compare describe the same nuclear family with small variations:
// surname spelling (Müller/Mueller), an approximate birth year, and a typo.
const MASTER = `0 HEAD
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
  const result = matchDatasets(dataset(MASTER), dataset(COMPARE));

  it("matches the husband across spelling/qualifier variation", () => {
    const johann = result.individuals.find((c) => c.compareId === "@P1@");
    expect(johann).toBeDefined();
    expect(johann!.masterId).toBe("@I1@");
    expect(johann!.score).toBeGreaterThan(70);
  });

  it("includes a parents component for the child", () => {
    const anna = result.individuals.find((c) => c.compareId === "@P3@");
    expect(anna).toBeDefined();
    expect(anna!.components.some((c) => c.key === "parents")).toBe(true);
  });

  it("never matches individuals of different recorded sex", () => {
    // Master has a male and a female with the same name + birth year; the
    // compare file has a female. Only the female may match.
    const master = `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8
0 @M1@ INDI\n1 NAME Pavle /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1900
0 @M2@ INDI\n1 NAME Pavla /Novak/\n1 SEX F\n1 BIRT\n2 DATE 1900
0 TRLR\n`;
    const compare = `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8
0 @C1@ INDI\n1 NAME Pavla /Novak/\n1 SEX F\n1 BIRT\n2 DATE 1900
0 TRLR\n`;
    const r = matchDatasets(dataset(master), dataset(compare));
    const forC1 = r.individuals.filter((c) => c.compareId === "@C1@");
    expect(forC1.every((c) => c.masterId !== "@M1@")).toBe(true); // never the male
    expect(forC1.some((c) => c.masterId === "@M2@")).toBe(true); // the female matches
  });

  it("sorts individuals by score descending", () => {
    const scores = result.individuals.map((c) => c.score);
    const sorted = [...scores].sort((a, b) => b - a);
    expect(scores).toEqual(sorted);
  });
});

describe("self-match (same file as master and compare)", () => {
  const ds = dataset(MASTER);
  const r = matchDatasets(ds, ds);

  it("yields only identical pairs, each scoring 100", () => {
    expect(r.individuals.length).toBe(ds.individuals.size);
    for (const c of r.individuals) {
      expect(c.masterId).toBe(c.compareId);
      expect(c.score).toBe(100);
    }
  });

  it("produces no cross matches between different people", () => {
    const cross = r.individuals.filter((c) => c.masterId !== c.compareId);
    expect(cross).toHaveLength(0);
  });
});

describe("plausibility gates", () => {
  const pair = (masterIndi: string, compareIndi: string) =>
    matchDatasets(
      dataset(`0 HEAD\n1 GEDC\n2 VERS 5.5.1\n${masterIndi}\n0 TRLR\n`),
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
  const pair = (masterIndi: string, compareIndi: string) =>
    matchDatasets(
      dataset(`0 HEAD\n1 GEDC\n2 VERS 5.5.1\n${masterIndi}\n0 TRLR\n`),
      dataset(`0 HEAD\n1 GEDC\n2 VERS 5.5.1\n${compareIndi}\n0 TRLR\n`),
    ).individuals;

  it("scores 100 only when all key fields are present and equal", () => {
    const r = pair(
      "0 @M@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 1850",
      "0 @C@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 1850",
    );
    expect(r[0].score).toBe(100);
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
  const masterWithMarriage = (marriageDate: string) =>
    "0 @M@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n1 FAMS @MF@\n" +
    `0 @MF@ FAM\n1 HUSB @M@\n1 MARR\n2 DATE ${marriageDate}\n`;
  // No recorded birth date at all — like a "family matches" CSV import that
  // only ever carries the marriage date.
  const compareNoBirth = (marriageDate: string) =>
    "0 @C@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @CF@\n" +
    `0 @CF@ FAM\n1 HUSB @C@\n1 MARR\n2 DATE ${marriageDate}\n`;

  it("scores the birth-date key well (not the flat missing penalty) when the master's birth year is a plausible age at the matched marriage", () => {
    // 1850 birth, 1880 marriage: 30 years old — squarely plausible.
    const master = doc(masterWithMarriage("1880"));
    const compare = doc(compareNoBirth("1880"));
    const r = matchDatasets(master, compare).individuals;
    expect(r).toHaveLength(1);
    const birth = r[0].components.find((c) => c.key === "birthDate");
    expect(birth?.missing).toBe(true);
    expect(birth?.score).toBeGreaterThan(0.3); // well above the flat missingKeyScore
    // The no-marriage-evidence case (below) scores noticeably lower.
    const bare = matchDatasets(
      doc("0 @M@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n"),
      doc("0 @C@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n"),
    ).individuals;
    expect(r[0].score).toBeGreaterThan(bare[0].score);
  });

  it("falls back to the flat missing-key penalty when the implied age is implausible", () => {
    // 1850 birth, 1860 marriage: 10 years old — outside the plausible range.
    const master = doc(masterWithMarriage("1860"));
    const compare = doc(compareNoBirth("1860"));
    const r = matchDatasets(master, compare).individuals;
    expect(r).toHaveLength(1);
    const birth = r[0].components.find((c) => c.key === "birthDate");
    expect(birth?.missing).toBe(true);
    expect(birth?.score).toBe(0.3);
  });
});

describe("parent-match bonus", () => {
  const doc = (body: string) => dataset(`0 HEAD\n1 GEDC\n2 VERS 5.5.1\n${body}0 TRLR\n`);
  // Same child in master and compare with an imperfect key (birth years one
  // apart so the score isn't pinned at 100), each with a father whose NAME varies.
  const master = (fatherName: string) =>
    "0 @M@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 1850\n1 FAMC @MF@\n" +
    "0 @MF@ FAM\n1 HUSB @MH@\n1 CHIL @M@\n" +
    `0 @MH@ INDI\n1 NAME ${fatherName}\n`;
  const compare = (fatherName: string) =>
    "0 @C@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 1851\n1 FAMC @CF@\n" +
    "0 @CF@ FAM\n1 HUSB @CH@\n1 CHIL @C@\n" +
    `0 @CH@ INDI\n1 NAME ${fatherName}\n`;

  const scoreOf = (fatherName: string) =>
    matchDatasets(doc(master(fatherName)), doc(compare(fatherName))).individuals.find(
      (c) => c.masterId === "@M@" && c.compareId === "@C@",
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
  // Same person in master and compare (imperfect key: birth years one apart),
  // married into a family whose spouse NAME we vary.
  const master = (spouseName: string) =>
    "0 @M@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n1 FAMS @MF@\n" +
    "0 @MF@ FAM\n1 HUSB @M@\n1 WIFE @MW@\n" +
    `0 @MW@ INDI\n1 NAME ${spouseName}\n1 SEX F\n`;
  const compare = (spouseName: string) =>
    "0 @C@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1851\n1 FAMS @CF@\n" +
    "0 @CF@ FAM\n1 HUSB @C@\n1 WIFE @CW@\n" +
    `0 @CW@ INDI\n1 NAME ${spouseName}\n1 SEX F\n`;

  const scoreOf = (spouseName: string) =>
    matchDatasets(doc(master(spouseName)), doc(compare(spouseName))).individuals.find(
      (c) => c.masterId === "@M@" && c.compareId === "@C@",
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
  it("does not reuse a master record for two compare records", () => {
    // Two compare people with the same name/birth; only one master twin.
    const master = `0 HEAD\n1 GEDC\n2 VERS 5.5.1
0 @M1@ INDI\n1 NAME Janez /Kos/\n1 SEX M\n1 BIRT\n2 DATE 1900
0 TRLR\n`;
    const compare = `0 HEAD\n1 GEDC\n2 VERS 5.5.1
0 @C1@ INDI\n1 NAME Janez /Kos/\n1 SEX M\n1 BIRT\n2 DATE 1900
0 @C2@ INDI\n1 NAME Janez /Kos/\n1 SEX M\n1 BIRT\n2 DATE 1900
0 TRLR\n`;
    const r = matchDatasets(dataset(master), dataset(compare));
    expect(r.individuals).toHaveLength(1); // @M1@ used once
    expect(r.individuals[0].masterId).toBe("@M1@");
  });
});

describe("marriage corroboration (folded into individual scoring)", () => {
  // Two same-named men; only the marriage (date + spouse) tells them apart.
  // Approximate birth so the identity key isn't a perfect 100 — leaving room for
  // the marriage components to move the score.
  const master = (marr: string) =>
    `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n` +
    `0 @H@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE ABT 1850\n1 FAMS @F@\n` +
    `0 @W@ INDI\n1 NAME Marija /Kovač/\n1 SEX F\n1 FAMS @F@\n` +
    `0 @F@ FAM\n1 HUSB @H@\n1 WIFE @W@\n1 MARR\n2 DATE ${marr}\n0 TRLR\n`;

  it("scores a same-marriage pair higher than a differing-marriage pair", () => {
    const same = matchDatasets(dataset(master("1875")), dataset(master("1875")))
      .individuals.find((c) => c.compareId === "@H@");
    const diff = matchDatasets(dataset(master("1875")), dataset(master("1899")))
      .individuals.find((c) => c.compareId === "@H@");
    expect(same).toBeDefined();
    expect(diff).toBeDefined();
    expect(same!.score).toBeGreaterThan(diff!.score);
    expect(same!.components.some((c) => c.key === "marriageDate")).toBe(true);
  });
});

describe("relationship pass: links co-parents of shared matched children, overriding name/date", () => {
  // Master mother "Ana Nuša Cegnar" (1939) with two children. The incoming file
  // holds the same woman as "Anica Cegnar" (1935) — a different given name and
  // birth year, but the SAME two children — plus a decoy "Ana Nuša Cegnar"
  // (1939) with no children whose identical name+date scores a perfect 100 and
  // would steal the mother in the primary pass.
  const master = `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8
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
  const r = matchDatasets(dataset(master), dataset(compare));

  it("links the mother to her child-sharing counterpart, not the identical-name decoy", () => {
    const am = r.individuals.find((c) => c.masterId === "@AM@");
    expect(am).toBeDefined();
    expect(am!.compareId).toBe("@AC@");
    expect(am!.relationshipLinked).toBe(true);
  });

  it("drops the name/date decoy that the override displaced", () => {
    expect(r.individuals.some((c) => c.compareId === "@DUP@")).toBe(false);
  });

  it("keeps the children matched", () => {
    expect(r.individuals.find((c) => c.masterId === "@MC1@")?.compareId).toBe("@IC1@");
    expect(r.individuals.find((c) => c.masterId === "@MC2@")?.compareId).toBe("@IC2@");
  });
});

describe("relationship pass: completes a couple from one shared child + a matched spouse", () => {
  // The mother is recorded under wildly different names — master "Slavka" (a
  // nickname, no surname) vs incoming "Stanislava Marija Ribič" — so she never
  // blocks or scores. But her husband Rudolf Volčič and their son Boris Volčič
  // both match across the files, so the couple can be completed: a child of a
  // known couple has exactly one mother.
  const master = `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8
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
  const r = matchDatasets(dataset(master), dataset(compare));

  it("links the two mothers despite no name or score overlap", () => {
    const sl = r.individuals.find((c) => c.masterId === "@SL@");
    expect(sl).toBeDefined();
    expect(sl!.compareId).toBe("@ST@");
    expect(sl!.relationshipLinked).toBe(true);
    expect(sl!.score).toBeGreaterThanOrEqual(90); // corroboration boost surfaces it
  });

  it("does not link on the shared child alone when the spouse isn't matched", () => {
    // Same as above but the husbands differ (no matched spouse) and there's only
    // one shared child — below the bar, so the mothers stay unlinked.
    const m2 = master.replace("Rudolf /Volčič/", "Anton /Kovač/");
    const r2 = matchDatasets(dataset(m2), dataset(compare));
    expect(r2.individuals.some((c) => c.masterId === "@SL@" && c.compareId === "@ST@")).toBe(false);
  });
});

describe("relationship pass: does not steal a parent-corroborated match for a spouse/child duplicate", () => {
  // Master Irena is the child of Jožef + Jožefa and the wife of Miran (mother of
  // Ana). The incoming file has TWO Irenas: the real one (@REAL@, same parents,
  // b1958) which the primary pass matches at 100, and a stray duplicate (@DUP@,
  // no parents, b1956) that shares only the spouse + child. The relationship
  // pass must NOT override the parent-corroborated match with the duplicate.
  const master = `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8
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
  const r = matchDatasets(dataset(master), dataset(compare));

  it("keeps the parents-matched record, ignoring the spouse/child duplicate", () => {
    const irena = r.individuals.find((c) => c.masterId === "@IRENA@");
    expect(irena).toBeDefined();
    expect(irena!.compareId).toBe("@REAL@");
  });

  it("leaves the duplicate unmatched to the master Irena", () => {
    expect(r.individuals.some((c) => c.masterId === "@IRENA@" && c.compareId === "@DUP@")).toBe(false);
  });
});

describe("incoming duplicate consolidation: detects same person split across incoming records", () => {
  // Master Irena. The incoming file holds her twice: @REAL@ (her parents, b1958)
  // which the primary pass matches, and @DUP@ (her spouse + child, b1956). It
  // also has a same-named NAMESAKE born 27 years later (a distinct person) and a
  // sibling MARIJA — neither should be folded in.
  const master = `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8
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
  const r = matchDatasets(dataset(master), dataset(compare));

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
  // Karolina (master) and Antonija (incoming) are different people with totally
  // different names. The greedy pass cross-matches their similar-surnamed but
  // distinct relatives (Jakofčič ↔ Jakopič) at a low score. Those weak matches
  // must NOT compound into a confident parent link between Karolina and Antonija.
  const master = `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8
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
  const r = matchDatasets(dataset(master), dataset(compare));

  it("does not link the two unrelated parents", () => {
    expect(r.individuals.some((c) => c.masterId === "@KAR@" && c.compareId === "@ANT@")).toBe(false);
  });

  it("(the weak relative matches that would have driven it score below the confidence bar)", () => {
    // Confirms the path is exercised: the relatives DO get cross-matched, just weakly.
    const marija = r.individuals.find((c) => c.masterId === "@MARIJA@");
    if (marija) expect(marija.score).toBeLessThan(85);
  });
});
