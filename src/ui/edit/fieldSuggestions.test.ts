import { describe, expect, it } from "vitest";
import { buildDataset } from "../../gedcom/builder";
import { parseGedcom } from "../../gedcom/parser";
import { rebuildFamily, rebuildIndividual } from "../../gedcom/edit/cache";
import type { GedNode } from "../../gedcom/types";
import { ChangeJournal } from "../../state/mainSync";
import { buildFieldSuggestions, FieldSuggestionIndex, placeAddrCoordKey, placeKey, suggestQuery } from "./fieldSuggestions";
import { foldSearch } from "../globalSearch";

function build(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

describe("suggestQuery", () => {
  const hits = (query: string, text: string) => suggestQuery(query).hits(foldSearch(text));
  const leads = (query: string, text: string) => suggestQuery(query).leads(foldSearch(text));

  it("matches a part of each word, in any order and without accents", () => {
    expect(hits("Zg Bitnj", "Zgornje Bitnje")).toBe(true);
    expect(hits("pok Zg", "Pokopališče Zgornje Bitnje")).toBe(true);
    expect(hits("bitnje zgornje", "Zgornje Bitnje")).toBe(true);
    expect(hits("skofja", "Škofja Loka")).toBe(true);
    expect(hits("Zg Bitnj", "Spodnje Bitnje")).toBe(false);
  });

  it("leads with the texts that open with the first term", () => {
    expect(leads("Zg Bitnj", "Zgornje Bitnje")).toBe(true);
    expect(leads("pok Zg", "Pokopališče Zgornje Bitnje")).toBe(true);
    expect(leads("Bitnj Zg", "Zgornje Bitnje")).toBe(false);
  });

  it("matches nothing for a blank query", () => {
    expect(suggestQuery("   ").terms).toEqual([]);
    expect(leads("  ", "Kranj")).toBe(false);
  });
});

// Two Kranj events: one plain (the settlement's own coordinate), one at a house
// with its own. Plus a second event at that same house, uncoordinated.
const FILE = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 BIRT
2 PLAC Kranj, Slovenija
3 MAP
4 LATI N46.23887
4 LONG E14.35561
1 RESI
2 PLAC Kranj, Slovenija
3 MAP
4 LATI N46.24137
4 LONG E14.35580
2 ADDR Kidričeva cesta 38
1 CENS
2 PLAC Kranj, Slovenija
2 ADDR Kidričeva cesta 38
0 TRLR
`;

describe("buildFieldSuggestions coordinates", () => {
  const sug = buildFieldSuggestions(build(FILE));

  it("takes a place's coordinate only from events with no address", () => {
    // Otherwise the house at Kidričeva 38 could become "the coordinate of Kranj"
    // and get inherited by every other Kranj event.
    expect(sug.placeCoords.get(placeKey("Kranj, Slovenija"))).toEqual({ lat: 46.23887, lon: 14.35561 });
  });

  it("keeps the house coordinate against its own place+address pair", () => {
    expect(sug.pairCoords.get(placeAddrCoordKey("Kranj, Slovenija", "Kidričeva cesta 38"))).toEqual({
      lat: 46.24137,
      lon: 14.3558,
    });
  });

  it("prefers the most frequent coordinate when occurrences disagree", () => {
    const ds = build(`0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 BIRT
2 PLAC Bled
3 MAP
4 LATI N46.3683
4 LONG E14.1136
1 DEAT
2 PLAC Bled
3 MAP
4 LATI N46.3683
4 LONG E14.1136
1 RESI
2 PLAC Bled
3 MAP
4 LATI N46.0
4 LONG E14.0
0 TRLR
`);
    expect(buildFieldSuggestions(ds).placeCoords.get(placeKey("Bled"))).toEqual({ lat: 46.3683, lon: 14.1136 });
  });

  it("has no entry for a place the file never coordinates", () => {
    const ds = build(`0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 BIRT
2 PLAC Neznano
0 TRLR
`);
    expect(buildFieldSuggestions(ds).placeCoords.size).toBe(0);
    expect(buildFieldSuggestions(ds).pairCoords.size).toBe(0);
  });
});

describe("coordinate maps as the \"file uses locations\" signal", () => {
  // The Edit pin renders only when the file uses coordinates somewhere; between
  // them these two maps cover every PLAC that carries a MAP, so both being empty
  // is that test. Guarding it here keeps the pin from reappearing on files that
  // have no locations at all.
  it("is empty for a file with places but no coordinates", () => {
    const sug = buildFieldSuggestions(
      build(`0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 BIRT
2 PLAC Kranj, Slovenija
1 RESI
2 PLAC Kranj, Slovenija
2 ADDR Kidričeva cesta 38
0 TRLR
`),
    );
    expect(sug.placeCoords.size + sug.pairCoords.size).toBe(0);
  });

  it("is non-empty as soon as one coordinate exists, whether or not it has an address", () => {
    const onlyAddressed = buildFieldSuggestions(
      build(`0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 RESI
2 PLAC Kranj, Slovenija
3 MAP
4 LATI N46.24137
4 LONG E14.35580
2 ADDR Kidričeva cesta 38
0 TRLR
`),
    );
    // Covered by pairCoords alone — placeCoords ignores addressed events.
    expect(onlyAddressed.placeCoords.size).toBe(0);
    expect(onlyAddressed.placeCoords.size + onlyAddressed.pairCoords.size).toBe(1);
  });
});

describe("buildFieldSuggestions place FORM", () => {
  it("offers the FORM the file already writes for that place", () => {
    const sug = buildFieldSuggestions(build(`0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 BIRT
2 PLAC Kranj, Kranj, Slovenija
3 FORM Place,Upravna Enota,Country
0 TRLR
`));
    expect(sug.placeForms.get(placeKey("Kranj, Kranj, Slovenija"))).toBe("Place,Upravna Enota,Country");
    // Nothing is said about a place the file has never labelled.
    expect(sug.placeForms.get(placeKey("Bled, Slovenija"))).toBeUndefined();
  });

  it("takes the most-used wording when the file disagrees with itself", () => {
    const sug = buildFieldSuggestions(build(`0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 BIRT
2 PLAC Kranj, Kranj, Slovenija
3 FORM Place,Upravna Enota,Country
1 DEAT
2 PLAC Kranj, Kranj, Slovenija
3 FORM Place,Upravna Enota,Country
0 @I2@ INDI
1 BIRT
2 PLAC Kranj, Kranj, Slovenija
3 FORM Place,Občina,Country
0 TRLR
`));
    expect(sug.placeForms.get(placeKey("Kranj, Kranj, Slovenija"))).toBe("Place,Upravna Enota,Country");
  });

  it("ignores a FORM that doesn't label every part of its place", () => {
    const sug = buildFieldSuggestions(build(`0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 BIRT
2 PLAC Slovenija, Slovenija
3 FORM Place,Upravna Enota,Country
0 TRLR
`));
    expect(sug.placeForms.size).toBe(0);
  });
});

describe("address ordering", () => {
  it("sorts a place's addresses by house number, not lexicographically", () => {
    const sug = buildFieldSuggestions(build(`0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 BIRT
2 PLAC Tupaliče, Preddvor, Slovenija
2 ADDR Tupaliče 11
1 RESI
2 PLAC Tupaliče, Preddvor, Slovenija
2 ADDR Tupaliče 8
1 CENS
2 PLAC Tupaliče, Preddvor, Slovenija
2 ADDR Tupaliče 9 (pd Celar)
1 EVEN
2 PLAC Tupaliče, Preddvor, Slovenija
2 ADDR Tupaliče 13
0 TRLR
`));
    expect(sug.placeToAddrs.get(placeKey("Tupaliče, Preddvor, Slovenija"))).toEqual([
      "Tupaliče 8",
      "Tupaliče 9 (pd Celar)",
      "Tupaliče 11",
      "Tupaliče 13",
    ]);
  });
});

describe("buildFieldSuggestions agencies", () => {
  const sug = buildFieldSuggestions(build(`0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 BIRT
2 PLAC Kranj, Slovenija
2 AGNC župnija Kranj - Šmartin
1 DEAT
2 PLAC Kranj, Slovenija
2 AGNC ŽUPNIJA KRANJ - ŠMARTIN
0 @F1@ FAM
1 MARR
2 PLAC Kranj, Slovenija
2 AGNC Upravna enota Kranj
0 TRLR
`));

  it("offers every agency the file's events already name, from families too", () => {
    expect(sug.agencySuggestions).toEqual(["Upravna enota Kranj", "župnija Kranj - Šmartin"]);
  });

  it("snaps a retyped agency back to the casing the file writes most", () => {
    // The same parish shouted once and written properly once: the field
    // completes to one spelling rather than offering both.
    expect(sug.agencyCanonical.get("župnija kranj - šmartin")).toBe("župnija Kranj - Šmartin");
  });
});

describe("buildFieldSuggestions causes", () => {
  const sug = buildFieldSuggestions(build(`0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 DEAT
2 CAUS Pljučnica
0 @I2@ INDI
1 DEAT
2 CAUS PLJUČNICA
0 @I3@ INDI
1 DEAT
2 CAUS Starost
0 @I4@ INDI
1 BURI
2 CAUS Pljučnica
0 TRLR
`));

  it("offers the file's own causes, the most used one first", () => {
    // Frequency order, not alphabetical: the dropdown opens before anything is
    // typed, and the cause that already carries the file is the likely answer.
    expect(sug.causeSuggestions).toEqual(["Pljučnica", "Starost"]);
  });

  it("snaps a retyped cause back to the casing the file writes most", () => {
    expect(sug.causeCanonical.get("pljučnica")).toBe("Pljučnica");
  });
});

describe("buildFieldSuggestions per-tag values and types", () => {
  const sug = buildFieldSuggestions(build(`0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 OCCU Kmet
1 RELI rimskokatoliška
1 EDUC Ljudska šola
1 REFN 1874-12
0 @I2@ INDI
1 OCCU Kmet
1 OCCU Učitelj
1 RELI RIMSKOKATOLIŠKA
1 REFN 1881-04
0 @I3@ INDI
1 NCHI 7
0 @F1@ FAM
1 MARR
2 TYPE cerkvena
0 @F2@ FAM
1 MARR
2 TYPE cerkvena
0 @F3@ FAM
1 MARR
2 TYPE civilna
0 TRLR
`));

  it("keeps each tag's values to itself", () => {
    // An occupation completes from occupations: a religion in the same list
    // would be an answer to a question nobody asked here.
    expect(sug.tagSuggestions.values.get("OCCU")?.suggestions).toEqual(["Kmet", "Učitelj"]);
    expect(sug.tagSuggestions.values.get("RELI")?.suggestions).toEqual(["rimskokatoliška"]);
    expect(sug.tagSuggestions.values.get("EDUC")?.suggestions).toEqual(["Ljudska šola"]);
  });

  it("orders a tag's values by how often the file uses them", () => {
    expect(sug.tagSuggestions.values.get("OCCU")?.suggestions[0]).toBe("Kmet");
  });

  it("snaps a retyped value to the casing the tag writes most", () => {
    expect(sug.tagSuggestions.values.get("RELI")?.canonical.get("rimskokatoliška")).toBe("rimskokatoliška");
  });

  it("completes a type from the same tag's types", () => {
    expect(sug.tagSuggestions.types.get("MARR")?.suggestions).toEqual(["cerkvena", "civilna"]);
  });

  it("offers nothing for a reference number or a child count", () => {
    // Both are answers about one person — a list of the file's others would
    // invite the wrong one rather than save typing.
    expect(sug.tagSuggestions.values.has("REFN")).toBe(false);
    expect(sug.tagSuggestions.values.has("NCHI")).toBe(false);
  });
});

describe("FieldSuggestionIndex", () => {
  const person = (i: number) =>
    `0 @I${i}@ INDI\n1 NAME A${i} /B/\n` +
    `1 BIRT\n2 DATE ${1 + (i % 28)} JAN 1850\n2 PLAC ${["Kranj", "Ljubljana", "Celje", "kranj"][i % 4]}\n` +
    (i % 3 ? `2 ADDR Breg ${i % 7}\n` : "") +
    (i % 5 ? "" : `1 RESI\n2 PLAC Metlika\n3 MAP\n4 LATI N45.6\n4 LONG E15.3\n`) +
    `1 OCCU ${["Kmet", "kmet", "Učitelj"][i % 3]}\n` +
    `1 DEAT\n2 CAUS ${["jetika", "starost"][i % 2]}\n2 AGNC župnija ${["Kranj", "Šmartin"][i % 2]}\n`;
  const FILE_N = `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n${Array.from({ length: 40 }, (_, i) => person(i + 1)).join("")}` +
    "0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n1 MARR\n2 TYPE cerkvena\n2 PLAC Kranj\n0 TRLR\n";
  const linesOf = (text: string): GedNode[] =>
    parseGedcom(new TextEncoder().encode(`0 HEAD\n0 @X@ INDI\n${text}0 TRLR\n`).buffer as ArrayBuffer).records[1].children;

  it("follows edits record by record into the lists a full build gives", () => {
    const ds = build(FILE_N);
    const journal = new ChangeJournal();
    const index = new FieldSuggestionIndex();
    let version = 0;
    const edit = (id: string, change: (raw: GedNode) => void) => {
      const indi = ds.individuals.get(id);
      const fam = ds.families.get(id);
      change((indi ?? fam)!.raw);
      if (indi) rebuildIndividual(ds, indi);
      else rebuildFamily(ds, fam!);
      journal.record(++version, [id]);
    };
    const check = () => {
      const got = index.get(ds, journal, version);
      expect(got).toEqual(buildFieldSuggestions(ds));
      return got;
    };
    const first = check();

    // A date: no list changes, so the very same object comes back.
    edit("@I3@", (raw) => {
      raw.children[1].children[0].value = "3 FEB 1851";
    });
    expect(check()).toBe(first);

    // A new place, address, coordinate, occupation, cause and agency.
    edit("@I4@", (raw) => {
      raw.children.push(...linesOf(
        "1 RESI\n2 PLAC Novo Mesto\n2 ADDR Glavni trg 1\n2 MAP\n3 LATI N45.8\n3 LONG E15.2\n" +
          "1 OCCU Mlinar\n1 BURI\n2 CAUS kolera\n2 AGNC župnija Novo mesto\n",
      ));
    });
    const added = check();
    expect(added.placeSuggestions).toContain("Novo Mesto");
    expect(added.placeSuggestions).not.toBe(first.placeSuggestions);

    // The last use of a place goes; a spelling's majority flips.
    edit("@I4@", (raw) => {
      raw.children = raw.children.filter((c) => c.tag !== "RESI");
    });
    for (const id of ["@I1@", "@I5@", "@I9@", "@I13@", "@I17@", "@I21@", "@I25@", "@I29@", "@I33@", "@I37@"]) {
      edit(id, (raw) => {
        raw.children[1].children.find((c) => c.tag === "PLAC")!.value = "kranj";
      });
    }
    expect(check().placeCanonical.get("kranj")).toBe("kranj");

    // A family's type, and a person deleted outright.
    edit("@F1@", (raw) => {
      raw.children.find((c) => c.tag === "MARR")!.children[0].value = "civilna";
    });
    ds.records.splice(ds.records.findIndex((r) => r.xref === "@I10@"), 1);
    ds.individuals.delete("@I10@");
    journal.record(++version, ["@I10@"]);
    check();

    // A change the journal cannot name: built again from every event.
    journal.record(++version, null);
    check();
  });

  it("builds afresh for a record changed under the same object", () => {
    const ds = build(FILE_N);
    const journal = new ChangeJournal();
    const index = new FieldSuggestionIndex();
    index.get(ds, journal, 0);
    ds.individuals.get("@I1@")!.events[0].place!.raw = "Postojna";
    journal.record(1, ["@I1@"]);
    expect(index.get(ds, journal, 1).placeSuggestions).toContain("Postojna");
  });
});
