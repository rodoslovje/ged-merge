import { describe, expect, it } from "vitest";
import { parseCsvText, parseGiMatchesCsv } from "./giMatches";
import { fatherName, motherName, partnerNames } from "../match/relatives";

const SL_HEADER =
  '"Ime","Priimek","Datum rojstva","Kraj rojstva","Datum smrti","Kraj smrti","Datum pokopa","Kraj pokopa","Povezave","Partnerji","Starši","Rodoslovec","Zaupanje"';

const EN_HEADER =
  '"Name","Surname","Date of Birth","Place of Birth","Date of Death","Place of Death","Burial date","Burial place","Links","Partners","Father","Mother","Genealogist","Confidence"';

function row(cells: string[]): string {
  return cells.map((c) => `"${c.replace(/"/g, '""')}"`).join(",");
}

describe("parseCsvText", () => {
  it("splits quoted fields with embedded commas and quotes", () => {
    const text = '"a, b","say ""hi""",c\n1,2,3\n';
    expect(parseCsvText(text)).toEqual([
      ["a, b", 'say "hi"', "c"],
      ["1", "2", "3"],
    ]);
  });

  it("strips a leading UTF-8 BOM", () => {
    const text = "﻿a,b\n";
    expect(parseCsvText(text)).toEqual([["a", "b"]]);
  });
});

describe("parseGiMatchesCsv", () => {
  it("rejects a CSV with an unexpected header", () => {
    expect(() => parseGiMatchesCsv('"foo","bar"\n')).toThrow(/Unrecognized/);
  });

  it("pairs rows, resolves the master key, and builds a synthetic compare individual (Slovenian header)", () => {
    const masterRow = row([
      "Franc",
      "Vilfan",
      "20 JUL 1877",
      "Srednje Bitnje 23, Kranj",
      "4 APR 1931",
      "",
      "1931",
      "Pokopališče Zgornje Bitnje, Kranj",
      "https://en.geneanet.org/cemetery/view/8657008",
      "Žena: Helena Krt *1883",
      "Franc Vilfan *1832, Marija Kalan *1838",
      "Renko",
      "99",
    ]);
    const incomingRow = row([
      "Franc",
      "Vilfan",
      "20 JUL 1877",
      "(🗒 SRD Cox 20200714)",
      "4 APR 1931",
      "",
      "",
      "Zabnica, Pokopališče Žabnica",
      "https://en.geneanet.org/cemetery/view/8657008",
      "Žena: Helena Krt *1883",
      "",
      "Pokopališča-geneanet",
      "99",
    ]);
    const text = `${SL_HEADER}\n${masterRow}\n${incomingRow}\n`;

    const { dataset, pairs } = parseGiMatchesCsv(text);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].masterKey).toEqual({ given: "Franc", surname: "Vilfan", birthYear: 1877 });
    expect(pairs[0].compareId).toBe("@SGI1@");

    const indi = dataset.individuals.get("@SGI1@");
    expect(indi).toBeDefined();
    expect(indi?.names[0]?.given).toBe("Franc");
    expect(indi?.names[0]?.surname).toBe("Vilfan");

    // Birth place is a "🗒" annotation, not a real place — should be skipped.
    const birth = indi?.events.find((e) => e.tag === "BIRT");
    expect(birth?.date?.raw).toBe("20 JUL 1877");
    expect(birth?.place).toBeUndefined();

    const death = indi?.events.find((e) => e.tag === "DEAT");
    expect(death?.date?.raw).toBe("4 APR 1931");

    const burial = indi?.events.find((e) => e.tag === "BURI");
    expect(burial?.place?.raw).toBe("Zabnica, Pokopališče Žabnica");

    expect(indi?.links).toContain("https://en.geneanet.org/cemetery/view/8657008");
    // The note is built from the second (incoming) row — the master-side
    // "Starši" value above isn't repeated here since the incoming row's is empty.
    expect(indi?.notes?.join("\n")).toBe("Source: indeks.rodoslovje.si – Pokopališča-geneanet (confidence 99%)");

    // "Žena: Helena Krt *1883" becomes a real partner family rather than a note.
    const partners = partnerNames(indi!, dataset);
    expect(partners).toHaveLength(1);
    expect(partners[0]).toEqual(expect.objectContaining({ given: "Helena", surname: "Krt" }));
  });

  it("handles the English header with separate Father/Mother columns", () => {
    const masterRow = row([
      "Stane",
      "Tepina",
      "27 OCT 1939",
      "",
      "4 JUL 2003",
      "",
      "2003",
      "Pokopališče Kranj, Kranj",
      "https://en.geneanet.org/cemetery/view/9849163",
      "",
      "Stanko Tepina | 20 OCT 1906",
      "Ana Bric | 11 JUL 1910",
      "Renko",
      "99",
    ]);
    const incomingRow = row([
      "Stane",
      "Tepina",
      "27 OCT 1939",
      "(🗒 SRD.SI JM202107 segment 9H)",
      "4 JUL 2003",
      "",
      "",
      "Kranj, Pokopališče Kranj",
      "https://en.geneanet.org/cemetery/view/9849163",
      "",
      "",
      "",
      "Pokopališča-geneanet",
      "99",
    ]);
    const text = `${EN_HEADER}\n${masterRow}\n${incomingRow}\n`;

    const { dataset, pairs } = parseGiMatchesCsv(text);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].masterKey).toEqual({ given: "Stane", surname: "Tepina", birthYear: 1939 });

    const indi = dataset.individuals.get("@SGI1@");
    expect(indi?.notes?.join("\n")).toBe("Source: indeks.rodoslovje.si – Pokopališča-geneanet (confidence 99%)");
  });

  it("builds father/mother and partner families from the second row's Father/Mother/Partners fields", () => {
    const masterRow = row([
      "A",
      "B",
      "1 JAN 1900",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "Renko",
      "99",
    ]);
    const incomingRow = row([
      "A",
      "B",
      "1 JAN 1900",
      "",
      "",
      "",
      "",
      "",
      "",
      "Anica Jurejevčič | 7 FEB 1923; <private>",
      "Father Person | 1 JAN 1870",
      "Mother Person | 1 JAN 1875",
      "Pokopališča-geneanet",
      "99",
    ]);
    const text = `${EN_HEADER}\n${masterRow}\n${incomingRow}\n`;

    const { dataset } = parseGiMatchesCsv(text);
    const indi = dataset.individuals.get("@SGI1@")!;

    // Partners/Father/Mother are now real family relationships, not notes.
    expect(indi.notes?.join("\n")).toBe("Source: indeks.rodoslovje.si – Pokopališča-geneanet (confidence 99%)");

    expect(fatherName(indi, dataset)).toEqual(expect.objectContaining({ given: "Father", surname: "Person" }));
    expect(motherName(indi, dataset)).toEqual(expect.objectContaining({ given: "Mother", surname: "Person" }));

    const father = dataset.individuals.get("@SGI1F@");
    expect(father?.events.find((e) => e.tag === "BIRT")?.date?.raw).toBe("1 JAN 1870");
    const mother = dataset.individuals.get("@SGI1M@");
    expect(mother?.events.find((e) => e.tag === "BIRT")?.date?.raw).toBe("1 JAN 1875");

    // "<private>" partner entries are dropped since they carry no name.
    const partners = partnerNames(indi, dataset);
    expect(partners).toHaveLength(1);
    expect(partners[0]).toEqual(expect.objectContaining({ given: "Anica", surname: "Jurejevčič" }));
  });

  it("skips footer rows with a different column count", () => {
    const masterRow = row(["Ana", "Novak", "1 JAN 1900", "", "", "", "", "", "", "", "", "Renko", "99"]);
    const incomingRow = row([
      "Ana",
      "Novak",
      "1 JAN 1900",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "Pokopališča-geneanet",
      "99",
    ]);
    const text = `${SL_HEADER}\n${masterRow}\n${incomingRow}\n"footer","with","fewer","columns"\n`;

    const { pairs } = parseGiMatchesCsv(text);
    expect(pairs).toHaveLength(1);
  });
});
