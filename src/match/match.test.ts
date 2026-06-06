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

  it("matches the family via spouses and marriage", () => {
    const fam = result.families.find((c) => c.compareId === "@G1@");
    expect(fam).toBeDefined();
    expect(fam!.masterId).toBe("@F1@");
    expect(fam!.score).toBeGreaterThan(70);
    expect(fam!.category === "strong" || fam!.category === "probable").toBe(true);
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

  it("matches families to themselves at 100", () => {
    for (const c of r.families) {
      expect(c.masterId).toBe(c.compareId);
      expect(c.score).toBe(100);
    }
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
