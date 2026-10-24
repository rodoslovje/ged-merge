import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import { applyRecordPatches } from "../ui/historyTypes";
import { buildPlaceTree, type PlaceNode } from "./places";
import { placeTranslationSets, setPlaceTranslations } from "./placeTranslations";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

const FILE = `0 HEAD
1 GEDC
2 VERS 7.0.3
0 @I1@ INDI
1 NAME Jurij /Mladič/
1 BIRT
2 PLAC Kranj, Slovenija
3 FORM City, Country
3 TRAN Krainburg
4 LANG de
3 MAP
4 LATI N46.2
4 LONG E14.3
1 DEAT
2 PLAC Gornja Lokvica 15, Metlika, Slovenija
3 TRAN Lokwitz
0 @I2@ INDI
1 NAME Ana /Kos/
1 BIRT
2 PLAC Kranj, Slovenija
1 DEAT
2 PLAC Metlika, Slovenija
0 TRLR`;

const find = (nodes: PlaceNode[], ...path: string[]): PlaceNode => {
  let node: PlaceNode | undefined;
  let list = nodes;
  for (const name of path) {
    node = list.find((n) => n.name === name);
    if (!node) throw new Error(`no ${name}`);
    list = node.children;
  }
  return node!;
};

describe("a place's other names", () => {
  it("reads what the values carry, and says when they disagree", () => {
    const ds = dataset(FILE);
    expect(placeTranslationSets(ds, new Set(["Kranj, Slovenija"]))).toEqual([
      { list: [{ value: "Krainburg", lang: "de" }], n: 1 },
      { list: [], n: 1 },
    ]);
  });

  it("puts a value's names on the row that value is, never on a place above it", () => {
    const tree = buildPlaceTree(dataset(FILE));
    const kranj = find(tree.roots, "Slovenija", "Kranj");
    expect(kranj.translations).toEqual([{ value: "Krainburg", lang: "de" }]);
    expect(kranj.placValues).toEqual(["Kranj, Slovenija"]);
    const house = find(tree.roots, "Slovenija", "Metlika", "Gornja Lokvica", "Gornja Lokvica 15");
    expect(house.translations).toEqual([{ value: "Lokwitz" }]);
    expect(house.placValues).toEqual(["Gornja Lokvica 15, Metlika, Slovenija"]);
    expect(find(tree.roots, "Slovenija", "Metlika", "Gornja Lokvica").translations).toBeUndefined();
    expect(find(tree.roots, "Slovenija", "Metlika").translations).toBeUndefined();
  });

  it("gives a house read off the event's ADDR none of the place's names", () => {
    const tree = buildPlaceTree(dataset(FILE.replace("1 DEAT\n2 PLAC Metlika, Slovenija", "1 DEAT\n2 PLAC Kranj, Slovenija\n2 ADDR Prešernova 1")));
    const street = find(tree.roots, "Slovenija", "Kranj", "Prešernova 1");
    expect(street.placValues).toBeUndefined();
    expect(street.translations).toBeUndefined();
  });

  it("writes one list on every place with the value, in place of the old lines, and undoes", () => {
    const ds = dataset(FILE);
    const original = serializeGedcom(ds.records);
    const patches = setPlaceTranslations(ds, new Set(["Kranj, Slovenija"]), [
      { value: "Krainburg", lang: "de" },
      { value: "Carnium" },
    ]);
    expect(patches).toHaveLength(2);
    const out = serializeGedcom(ds.records);
    // Where the old line stood, and after FORM where there was none.
    expect(out).toContain("2 PLAC Kranj, Slovenija\n3 FORM City, Country\n3 TRAN Krainburg\n4 LANG de\n3 TRAN Carnium\n4 LANG und\n3 MAP\n");
    expect(out).toContain("1 NAME Ana /Kos/\n1 BIRT\n2 PLAC Kranj, Slovenija\n3 TRAN Krainburg\n4 LANG de\n3 TRAN Carnium\n4 LANG und\n");
    // Another place keeps its own.
    expect(out).toContain("3 TRAN Lokwitz\n");
    applyRecordPatches(ds, patches, "undo");
    expect(serializeGedcom(ds.records)).toBe(original);
  });

  it("removes them all with an empty list, and leaves a place that already matches alone", () => {
    const ds = dataset(FILE);
    expect(setPlaceTranslations(ds, new Set(["Kranj, Slovenija"]), [])).toHaveLength(1);
    expect(serializeGedcom(ds.records)).not.toContain("Krainburg");
    expect(setPlaceTranslations(ds, new Set(["Kranj, Slovenija"]), [])).toHaveLength(0);
  });
});
