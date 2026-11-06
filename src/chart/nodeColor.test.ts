import { describe, expect, it } from "vitest";
import { parseGedcom } from "../gedcom/parser";
import { buildDataset } from "../gedcom/builder";
import type { Individual } from "../gedcom/types";
import type { TreeNode } from "./personTree";
import { OWN_BRANCH } from "./kinshipWheel";
import { axisWithin, categoryColor, colorAxesFor, COLOR_AXES, createNodeColorer, indexPositions, lineColor, sanitizeColorAxis, type ColorContext } from "./nodeColor";

const GED = `0 HEAD
1 GEDC
2 VERS 5.5.1
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Janez /Novak/
1 SEX M
1 BIRT
2 DATE 1950
2 PLAC Kranj, Slovenija
2 SOUR @S1@
1 FAMC @F1@
1 FAMS @F2@
0 @I2@ INDI
1 NAME Franc /Novak/
1 SEX M
1 BIRT
2 DATE 1920
2 PLAC Graz, Österreich
1 DEAT
2 DATE 1990
1 FAMS @F1@
0 @I3@ INDI
1 NAME Ana /Kovač/
1 SEX F
1 BIRT
2 DATE 1925
2 PLAC Kranj
1 DEAT
2 DATE 2010
1 FAMS @F1@
0 @I4@ INDI
1 NAME Maja /Novak/
1 SEX F
1 BIRT
2 DATE 1980
1 FAMC @F2@
0 @I5@ INDI
1 NAME Petra /Zupan/
1 SEX F
1 FAMS @F2@
0 @F1@ FAM
1 HUSB @I2@
1 WIFE @I3@
1 CHIL @I1@
1 MARR
2 DATE 1948
2 SOUR @S1@
0 @F2@ FAM
1 HUSB @I1@
1 WIFE @I5@
1 CHIL @I4@
0 @S1@ SOUR
1 TITL Matične knjige
0 TRLR
`;

const ds = buildDataset(parseGedcom(new TextEncoder().encode(GED).buffer as ArrayBuffer));
const indi = (id: string): Individual => ds.individuals.get(`@${id}@`)!;
const t = ((key: string, opts?: Record<string, unknown>) => (opts?.n !== undefined ? `${key}:${opts.n}` : key)) as ColorContext["t"];
const ctx: ColorContext = { ds, t, lang: "en", home: "si", now: 2026 };

function node(key: string, id: string | undefined, sex: "M" | "F" | "U", children: TreeNode[] = [], partners: TreeNode[] = []): TreeNode {
  return { key, main: id ? indi(id) : undefined, status: "main-only", name: key, years: "", living: false, sex, detail: "", children, partners };
}

describe("indexPositions", () => {
  it("signs generations by direction and names the lines by grandparent / child", () => {
    // Ancestors: root ← father (I2) ← [gf, gm]; mother (I3) ← [mgm only].
    const anc = node("R", "I1", "M", [
      node("F", "I2", "M", [node("FF", undefined, "M", [node("FFF", undefined, "M")]), node("FM", undefined, "F")]),
      node("M", "I3", "F", [node("MM", undefined, "F")]),
    ]);
    const { positions, branches } = indexPositions(anc, "ancestors");
    expect(positions.get("R")).toEqual({ gen: 0, branch: OWN_BRANCH });
    expect(positions.get("F")).toEqual({ gen: 1, branch: OWN_BRANCH });
    expect(positions.get("FF")).toEqual({ gen: 2, branch: "FF" });
    expect(positions.get("FFF")).toEqual({ gen: 3, branch: "FF" });
    // A lone grandmother on the mother's side keeps the mother's-mother colour.
    expect(positions.get("MM")).toEqual({ gen: 2, branch: "MM" });
    expect(branches.get("FF")?.color).toBe(lineColor(0, 4, "ancestors"));
    expect(branches.get("FM")?.color).toBe(lineColor(1, 4, "ancestors"));
    expect(branches.get("MM")?.color).toBe(lineColor(3, 4, "ancestors"));
    expect(lineColor(0, 4, "ancestors")).toContain("--kin-anc-near");
    expect(lineColor(3, 4, "ancestors")).toContain("100.0%");
    expect(branches.get("FF")?.label).toBe("FF");

    // Descendants: root + spouse → child (I4) → grandchild; a spouseless child.
    const desc = node("R", "I1", "M", [node("C2", undefined, "M")], [node("S", "I5", "F", [node("C1", "I4", "F", [node("G", undefined, "M")])])]);
    const d = indexPositions(desc, "descendants", "a:");
    expect(d.positions.get("a:R")).toEqual({ gen: 0, branch: OWN_BRANCH });
    expect(d.positions.get("a:S")).toEqual({ gen: 0, branch: OWN_BRANCH });
    // The child's line is keyed by their id; a union's children come first.
    expect(d.positions.get("a:C1")).toEqual({ gen: -1, branch: "@I4@" });
    expect(d.positions.get("a:G")).toEqual({ gen: -2, branch: "@I4@" });
    expect(d.positions.get("a:C2")).toEqual({ gen: -1, branch: "C2" });
    expect([...d.branches.keys()]).toEqual(["@I4@", "C2"]);
    expect(d.branches.get("@I4@")?.color).toBe(lineColor(0, 2, "descendants"));
    expect(d.branches.get("C2")?.color).toContain("--kin-desc-far");
  });
});

describe("createNodeColorer", () => {
  const subjects = ["I1", "I2", "I3", "I4", "I5"].map((id) => ({ indi: indi(id) }));

  it("is silent on the plain axis", () => {
    const c = createNodeColorer("plain", ctx, subjects);
    expect(c.colorOf(c.categoryOf(indi("I1")))).toBeUndefined();
    expect(c.legend).toEqual([]);
  });

  it("reads sex and living, in a fixed legend order", () => {
    const sex = createNodeColorer("sex", ctx, subjects);
    expect(sex.legend.map((e) => [e.key, e.count])).toEqual([["M", 2], ["F", 3]]);
    expect(sex.colorOf("F")).toBe("var(--sex-female)");
    const living = createNodeColorer("living", ctx, subjects);
    expect(living.categoryOf(indi("I2"))).toBe("deceased");
    expect(living.categoryOf(indi("I4"))).toBe("living");
    expect(living.legend.map((e) => e.key)).toEqual(["living", "deceased"]);
  });

  it("takes the country from the first placed event, the home country for a bare place", () => {
    const c = createNodeColorer("country", ctx, subjects);
    expect(c.categoryOf(indi("I1"))).toBe("si");
    expect(c.categoryOf(indi("I2"))).toBe("at");
    expect(c.categoryOf(indi("I3"))).toBe("si"); // "Kranj" names no country
    expect(c.categoryOf(indi("I4"))).toBe(""); // no place at all
    expect(c.legend.map((e) => [e.key, e.count])).toEqual([["si", 2], ["at", 1]]);
    expect(c.legend[0].label).toContain("Slovenia");
  });

  it("falls back on the burial place when birth, residence and death name none", () => {
    const c = createNodeColorer("country", ctx, subjects);
    const buried = { ...indi("I4"), events: [{ ...indi("I2").events[0], tag: "BURI" }] } as Individual;
    expect(c.categoryOf(buried)).toBe("at");
  });

  /** Janez, born at `plac` instead. */
  const bornAt = (plac: string) => {
    const base = indi("I1");
    const birth = base.events.find((e) => e.tag === "BIRT")!;
    return { ...base, events: [{ ...birth, place: { ...birth.place!, raw: plac, parts: plac.split(", ") } }] } as Individual;
  };

  it("keeps the home country calm and colours neighbouring countries alike", () => {
    const people = ["Graz, Austria", "Wien, Austria", "Zagreb, Croatia", "Chicago, USA", "Kranj", "Bled", "Ptuj"].map((p) => ({ indi: bornAt(p) }));
    const c = createNodeColorer("country", ctx, people);
    expect(c.legend.map((e) => e.key)).toEqual(["si", "at", "hr", "us"]);
    expect(c.colorOf("si")).toContain("--node-main");
    const hue = (k: string) => Number(/ (\d+)\)$/.exec(c.colorOf(k)!)![1]);
    // Croatia sits next to Austria, the United States far from both.
    expect(Math.abs(hue("hr") - hue("at"))).toBeLessThan(40);
    expect(Math.abs(hue("us") - hue("hr"))).toBeGreaterThan(60);
  });

  it("calms the commonest country when the home country is not on the chart", () => {
    const people = ["Graz, Austria", "Wien, Austria", "Zagreb, Croatia"].map((p) => ({ indi: bornAt(p) }));
    const c = createNodeColorer("country", ctx, people);
    expect(c.colorOf("at")).toContain("--node-main");
    expect(c.colorOf("hr")).toContain("oklch(");
  });

  it("groups birth places by country, the commonest place calm", () => {
    const people = ["Kranj", "Kranj", "Graz, Austria", "Bled", "Wien, Austria", "Ptuj"].map((p) => ({ indi: bornAt(p) }));
    const c = createNodeColorer("birthPlace", ctx, people);
    // Kranj first and calm, then the rest of Slovenia, then Austria.
    expect(c.legend[0].key).toBe("Kranj");
    expect(c.legend[0].color).toContain("--node-main");
    expect(c.legend.slice(1).map((e) => e.key)).toEqual(["Bled", "Ptuj", "Graz", "Wien"]);
    expect(new Set(c.legend.map((e) => e.color)).size).toBe(5);
  });

  it("clusters a country's places by their second level", () => {
    const people = [
      "Kranj, Kranj, Slovenia", "Kranj, Kranj, Slovenia",
      "Krasinec, Metlika, Slovenia", "Gradac, Metlika, Slovenia", "Klošter, Metlika, Slovenia",
      "Žabnica, Kranj, Slovenia", "Jama, Kranj, Slovenia", "Bitnje, Kranj, Slovenia",
      "Ravna Gora, Primorje-Gorski Kotar, Croatia", "Stara Sušica, Primorje-Gorski Kotar, Croatia",
    ];
    const c = createNodeColorer("birthPlace", ctx, people.map((p) => ({ indi: bornAt(p) })));
    // Kranj calm; then Slovenia by area (Kranj's counting the calm Kranj,
    // so ahead of Metlika), then Croatia.
    expect(c.legend.map((e) => e.key)).toEqual([
      "Kranj", "Žabnica", "Jama", "Bitnje", "Krasinec", "Gradac", "Klošter", "Ravna Gora", "Stara Sušica",
    ]);
    const hue = (k: string) => Number(/ (\d+)\)$/.exec(c.colorOf(k)!)![1]);
    const kranj = ["Žabnica", "Jama", "Bitnje"].map(hue);
    const metlika = ["Krasinec", "Gradac", "Klošter"].map(hue);
    // Inside an area the steps are smaller than the gap between the areas.
    const step = Math.max(kranj[1] - kranj[0], kranj[2] - kranj[1]);
    expect(metlika[0] - kranj[2]).toBeGreaterThan(step);
    expect(new Set(c.legend.map((e) => e.color)).size).toBe(9);
  });

  it("calms the home country's commonest place, though a foreign one is commoner", () => {
    const people = ["Zagreb, Croatia", "Zagreb, Croatia", "Zagreb, Croatia", "Split, Croatia", "Kranj", "Kranj", "Bled"];
    const c = createNodeColorer("birthPlace", ctx, people.map((p) => ({ indi: bornAt(p) })));
    expect(c.legend[0].key).toBe("Kranj");
    expect(c.colorOf("Kranj")).toContain("--node-main");
    expect(c.colorOf("Zagreb")).toContain("oklch(");
  });

  it("colours a person with no birth place by the place their label shows", () => {
    const born = bornAt("Stara Sušica, Croatia");
    const resident = { ...born, events: [{ ...born.events[0], tag: "RESI" }] } as Individual;
    const c = createNodeColorer("birthPlace", ctx, [{ indi: born }, { indi: resident }]);
    expect(c.categoryOf(resident)).toBe("Stara Sušica");
    expect(c.colorFor(resident)).toBe(c.colorFor(born));
  });

  it("gives each country's places one family of hues, the countries far apart", () => {
    const si = ["Bled", "Ptuj", "Celje", "Koper", "Kranj", "Kranj"];
    const hr = ["Zagreb, Croatia", "Split, Croatia", "Rijeka, Croatia"];
    const c = createNodeColorer("birthPlace", ctx, [...si, ...hr].map((p) => ({ indi: bornAt(p) })));
    const hue = (k: string) => Number(/ (\d+)\)$/.exec(c.colorOf(k)!)![1]);
    const spread = (ks: string[]) => Math.max(...ks.map(hue)) - Math.min(...ks.map(hue));
    const siKeys = ["Bled", "Ptuj", "Celje", "Koper"];
    const hrKeys = ["Zagreb", "Split", "Rijeka"];
    expect(spread(siKeys)).toBeLessThan(60);
    expect(spread(hrKeys)).toBeLessThan(60);
    const between = Math.min(...siKeys.flatMap((a) => hrKeys.map((b) => Math.abs(hue(a) - hue(b)))));
    expect(between).toBeGreaterThan(60);
    expect(new Set(c.legend.map((e) => e.color)).size).toBe(8);
    for (const k of [...siKeys, ...hrKeys]) expect(hue(k) >= 90 && hue(k) < 125).toBe(false);
  });

  it("never paints a category in the muddy band", () => {
    for (let n = 1; n <= 12; n++) {
      for (let i = 0; i < n; i++) {
        const h = Number(/ (\d+)\)$/.exec(categoryColor(i, n))![1]);
        expect(h >= 90 && h < 125).toBe(false);
      }
    }
  });

  it("folds a long tail of surnames into other", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      indi: { ...indi("I1"), names: [{ given: "X", surname: `S${i}`, full: `X S${i}` }] } as Individual,
    }));
    const c = createNodeColorer("surname", ctx, [...many, ...many.slice(0, 3)]);
    expect(c.legend).toHaveLength(12);
    expect(c.legend[11].label).toBe("chartColor.other");
    expect(c.legend[11].count).toBe(9);
    expect(c.categoryOf(many[19].indi)).toBe(c.legend[11].key);
    expect(c.categoryOf(many[0].indi)).toBe("S0");
  });

  it("buckets the parents' average age at birth and the sourced share", () => {
    const parents = createNodeColorer("parentAge", ctx, subjects);
    // Franc (1920) was 30 and Ana (1925) 25 at Janez's birth: 27.5 → the 25–29
    // bucket. Maja's mother has no birth date, so her father's 30 stands alone.
    expect(parents.categoryOf(indi("I1"))).toBe("25");
    expect(parents.categoryOf(indi("I4"))).toBe("30");
    expect(parents.categoryOf(indi("I2"))).toBe("");
    expect(parents.legend.map((e) => e.label)).toEqual(["25–29", "30–34"]);
    // Buckets take hues in value order.
    expect(parents.colorOf("25")).not.toBe(parents.colorOf("30"));
    expect(parents.colorOf("25")).toContain("oklch(");
    const sources = createNodeColorer("sources", ctx, subjects);
    // Janez: birth cited, marriage F2 has no MARR → 1 of 1; Franc: birth, death
    // uncited, marriage F1 cited → 1 of 3.
    expect(sources.categoryOf(indi("I1"))).toBe("all");
    expect(sources.categoryOf(indi("I2"))).toBe("some");
    expect(sources.categoryOf(indi("I5"))).toBe("");
  });

  it("colours generations from the position, scaled to the chart's span", () => {
    const subjectsWithPos = [
      { indi: indi("I1"), pos: { gen: 0, branch: OWN_BRANCH } },
      { indi: indi("I2"), pos: { gen: 1, branch: OWN_BRANCH } },
      { indi: indi("I4"), pos: { gen: -1, branch: "@I4@" } },
      { indi: indi("I3"), pos: { gen: 7, branch: "x" } },
    ];
    const c = createNodeColorer("generation", ctx, subjectsWithPos);
    expect(c.legend.map((e) => e.key)).toEqual(["7", "1", "0", "-1"]);
    expect(c.legend[0].label).toBe("kin.gen.up.n:7");
    expect(c.colorOf("0")).toBe("var(--kin-gen-0)");
    expect(c.colorOf("1")).toContain("--kin-anc-near");
    expect(c.legend[3].label).toBe("kin.gen.down.1");
  });

  it("sanitizes a stored axis", () => {
    expect(sanitizeColorAxis("country")).toBe("country");
    expect(sanitizeColorAxis("nope")).toBe("plain");
    expect(sanitizeColorAxis("motherAge")).toBe("parentAge");
  });

  it("leaves a spouse riding beside the line out of the chart-reading axes", () => {
    // A descendant fan: the root, their child, and the child's spouse on a band.
    const subjectsWithBand = [
      { indi: indi("I1"), pos: { gen: 0, branch: OWN_BRANCH } },
      { indi: indi("I4"), pos: { gen: -1, branch: "@I4@" } },
      { indi: indi("I5"), pos: { gen: -1, branch: "@I4@", offLine: true } },
    ];
    const gen = createNodeColorer("generation", ctx, subjectsWithBand);
    // The band counts for neither generation: one person stands at −1.
    expect(gen.categoryOf(indi("I5"), { gen: -1, branch: "@I4@", offLine: true })).toBe("");
    expect(gen.legend.map((e) => [e.key, e.count])).toEqual([["0", 1], ["-1", 1]]);
    const line = createNodeColorer("branch", ctx, subjectsWithBand);
    expect(line.legend.map((e) => [e.key, e.count])).toEqual([[OWN_BRANCH, 1], ["@I4@", 1]]);
    // A record axis still reads the spouse: their own sex is theirs to show.
    const sex = createNodeColorer("sex", ctx, subjectsWithBand);
    expect(sex.categoryOf(indi("I5"), { gen: -1, branch: "@I4@", offLine: true })).toBe("F");
    expect(sex.legend.map((e) => [e.key, e.count])).toEqual([["M", 1], ["F", 2]]);
  });

  it("offers a chart only the axes it can honour", () => {
    expect(colorAxesFor("all")).toEqual(COLOR_AXES);
    expect(colorAxesFor("noBranch")).not.toContain("branch");
    expect(colorAxesFor("noBranch")).toContain("generation");
    expect(colorAxesFor("none")).toEqual([]);
    // A choice made on another chart falls back rather than painting one colour.
    expect(axisWithin("branch", "noBranch")).toBe("plain");
    expect(axisWithin("sex", "noBranch")).toBe("sex");
    expect(axisWithin("sex", "none")).toBe("plain");
  });
});
