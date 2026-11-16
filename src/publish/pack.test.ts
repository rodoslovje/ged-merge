import { describe, expect, it } from "vitest";
import type { PublishedTree } from "./model";
import { packTree, unpackTree } from "./pack";

const tree: PublishedTree = {
  format: "gedmerge-site",
  version: 1,
  title: "Rodbina",
  created: "2026-11-16",
  lang: "sl",
  people: [
    {
      id: "a",
      given: "Ana",
      events: [
        { tag: "BIRT", date: "1900", place: "Kranj, Slovenia", lat: 46.24, lon: 14.36 },
        { tag: "RESI", date: "1920", place: "Kranj, Slovenia", lat: 46.24, lon: 14.36, address: "Glavni trg 1" },
        { tag: "OCCU", value: "Učiteljica" },
      ],
    },
    { id: "b", given: "Bor", events: [{ tag: "BIRT", place: "Kranj, Slovenia", lat: 46.24, lon: 14.36 }] },
    { id: "c", given: "Cene" },
  ],
  families: [{ id: "f", husband: "b", wife: "a", events: [{ tag: "MARR", place: "Kranj, Slovenia", lat: 46.24, lon: 14.36 }] }],
};

describe("packTree", () => {
  it("writes each place once and gives the tree back unchanged", () => {
    const packed = packTree(tree);
    expect(packed.places).toEqual([
      { place: "Kranj, Slovenia", lat: 46.24, lon: 14.36 },
      { place: "Kranj, Slovenia", address: "Glavni trg 1", lat: 46.24, lon: 14.36 },
    ]);
    expect(packed.people[1].events).toEqual([{ tag: "BIRT", pl: 0 }]);
    expect(packed.people[0].events![2]).toEqual({ tag: "OCCU", value: "Učiteljica" });
    expect(packed.families[0].events).toEqual([{ tag: "MARR", pl: 0 }]);
    // The couple by their number in people.
    expect(packed.families[0]).toMatchObject({ husband: 1, wife: 0 });
    // Through JSON, as the page carries it.
    expect(unpackTree(JSON.parse(JSON.stringify(packed)))).toEqual(tree);
  });

  it("keeps the id of a family member who is not among the people", () => {
    const odd = { ...tree, families: [{ id: "g", husband: "a", children: ["zz"] }] };
    const packed = packTree(odd);
    expect(packed.families[0]).toMatchObject({ husband: 0, children: ["zz"] });
    expect(unpackTree(JSON.parse(JSON.stringify(packed)))).toEqual(odd);
  });

  it("reads a page written before the table as it is", () => {
    expect(unpackTree(tree as never)).toEqual(tree);
    expect(packTree({ ...tree, people: [{ id: "c" }], families: [] }).places).toBeUndefined();
  });
});
