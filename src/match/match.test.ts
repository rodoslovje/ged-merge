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
