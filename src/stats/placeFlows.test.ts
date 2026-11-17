import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { buildStatsFacts } from "./facts";
import { applyCountry, DEFAULT_SCOPE, scopeFacts } from "./scope";
import { NO_PLACE, OTHER, placeDecades, placeFlows, placeStack } from "./placeFlows";

function scoped(text: string) {
  const facts = buildStatsFacts(buildDataset(parseGedcom(new TextEncoder().encode(text).buffer)), "si");
  return applyCountry(facts, scopeFacts(facts, DEFAULT_SCOPE, null, undefined), DEFAULT_SCOPE);
}

const person = (id: string, sex: string, year: string | null, place: string | null, links: string[] = []) =>
  [
    `0 @${id}@ INDI`,
    `1 SEX ${sex}`,
    ...(year || place ? ["1 BIRT", ...(year ? [`2 DATE ${year}`] : []), ...(place ? [`2 PLAC ${place}`] : [])] : []),
    ...links,
  ].join("\n");

/** Father born in Bled, mother in Kranj; two children born in Bled and one in
 *  Ljubljana; a grandchild born in Zagreb to the Ljubljana son, whose wife has
 *  no place; one undated, placeless cousin. */
const FILE = [
  "0 HEAD\n1 CHAR UTF-8",
  person("I1", "M", "1800", "Bled, Slovenija", ["1 FAMS @F1@"]),
  person("I2", "F", "1805", "Kranj, Slovenija", ["1 FAMS @F1@"]),
  person("I3", "M", "1830", "Bled, Slovenija", ["1 FAMC @F1@"]),
  person("I4", "F", "1832", "BLED, Slovenija", ["1 FAMC @F1@"]),
  person("I5", "M", "1835", "Ljubljana, Slovenija", ["1 FAMC @F1@", "1 FAMS @F2@"]),
  person("I6", "F", "1840", null, ["1 FAMS @F2@"]),
  person("I7", "M", "1866", "Zagreb, Hrvaška", ["1 FAMC @F2@"]),
  person("I8", "M", null, null),
  "0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n1 CHIL @I3@\n1 CHIL @I4@\n1 CHIL @I5@",
  "0 @F2@ FAM\n1 HUSB @I5@\n1 WIFE @I6@\n1 CHIL @I7@",
  "0 TRLR",
].join("\n");

describe("placeFlows", () => {
  it("pairs each child with each parent who has a birth place", () => {
    const f = placeFlows(scoped(FILE), "place");
    // 3 children × 2 parents, and the grandchild with the father only.
    expect(f.pairs).toBe(7);
    // Bled→Bled twice stays; the rest moved.
    expect(f.moved).toBe(5);
    expect(new Set(f.movedIds)).toEqual(new Set(["@I3@", "@I4@", "@I5@", "@I7@"]));
    expect(f.parents.map((n) => n.count)).toEqual([3, 3, 1]);
    // Spellings fold together; the commonest one labels the node.
    expect(f.children[0]).toMatchObject({ label: "Bled, Slovenija", count: 4 });
    const bled = f.flows.find((x) => x.from === f.parents[0].key && x.to === f.children[0].key)!;
    expect(bled.count).toBe(2);
    expect(bled.ids).toEqual(["@I3@", "@I4@"]);
  });

  it("folds what lies past the top into other places", () => {
    const f = placeFlows(scoped(FILE), "place", 1);
    expect(f.parents.map((n) => n.key)).toEqual([f.parents[0].key, OTHER]);
    expect(f.children.at(-1)).toMatchObject({ key: OTHER, count: 3 });
    expect(f.flows.reduce((n, x) => n + x.count, 0)).toBe(7);
  });

  it("reads countries at the country level", () => {
    const f = placeFlows(scoped(FILE), "country");
    expect(f.children.map((n) => n.key)).toEqual(["si", "hr"]);
    expect(f.moved).toBe(1);
    expect(f.movedIds).toEqual(["@I7@"]);
  });
});

describe("placeDecades", () => {
  it("gives the commonest birth places a row of decades", () => {
    const d = placeDecades(scoped(FILE));
    expect(d.places).toBe(4);
    expect(d.rows[0].label).toBe("Bled, Slovenija");
    expect([...d.rows[0].byDecade]).toEqual([[1800, ["@I1@"]], [1830, ["@I3@", "@I4@"]]]);
    expect([d.first, d.last, d.max]).toEqual([1800, 1860, 2]);
  });
});

describe("placeStack", () => {
  it("splits each decade by place, with other and no place last", () => {
    const st = placeStack(scoped(FILE), 1);
    expect(st.parts.map((p) => p.key)).toEqual([st.parts[0].key, OTHER, NO_PLACE]);
    expect(st.people).toBe(7);
    expect(st.decades.map((d) => d.decade)).toEqual([1800, 1810, 1820, 1830, 1840, 1850, 1860]);
    expect(st.decades[3].parts).toEqual([["@I3@", "@I4@"], ["@I5@"], []]);
    expect(st.decades[4].parts[2]).toEqual(["@I6@"]);
    expect(st.decades[1].count).toBe(0);
  });
});
