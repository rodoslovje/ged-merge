import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { parseGiMatchesCsv } from "../csv/giMatches";
import { matchGiPairs } from "./giMatch";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

const MAIN = `0 HEAD
1 GEDC
2 VERS 5.5.1
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Franc /Vilfan/
1 SEX M
1 BIRT
2 DATE 20 JUL 1877
2 PLAC Srednje Bitnje, Kranj
0 @I2@ INDI
1 NAME Janez /Novak/
1 SEX M
1 BIRT
2 DATE 1 JAN 1900
0 TRLR
`;

const HEADER =
  '"Ime","Priimek","Datum rojstva","Kraj rojstva","Datum smrti","Kraj smrti","Datum pokopa","Kraj pokopa","Povezave","Partnerji","Starši","Rodoslovec","Zaupanje"';

function row(cells: string[]): string {
  return cells.map((c) => `"${c.replace(/"/g, '""')}"`).join(",");
}

describe("matchGiPairs", () => {
  it("resolves a pair whose main key matches and scores it against the compare individual", () => {
    const mainRow = row([
      "Franc",
      "Vilfan",
      "20 JUL 1877",
      "Srednje Bitnje, Kranj",
      "4 APR 1931",
      "",
      "1931",
      "Pokopališče Zgornje Bitnje, Kranj",
      "https://en.geneanet.org/cemetery/view/8657008",
      "",
      "",
      "Renko",
      "99",
    ]);
    const incomingRow = row([
      "Franc",
      "Vilfan",
      "20 JUL 1877",
      "",
      "4 APR 1931",
      "",
      "",
      "Zabnica, Pokopališče Žabnica",
      "https://en.geneanet.org/cemetery/view/8657008",
      "",
      "",
      "Pokopališča-geneanet",
      "99",
    ]);
    const csv = `${HEADER}\n${mainRow}\n${incomingRow}\n`;

    const mainDs = dataset(MAIN);
    const { dataset: compareDs, pairs } = parseGiMatchesCsv(csv);

    const result = matchGiPairs(mainDs, compareDs, pairs);
    expect(result.individuals).toHaveLength(1);
    expect(result.individuals[0].mainId).toBe("@I1@");
    expect(result.individuals[0].compareId).toBe("@SGI1@");
    expect(result.individuals[0].score).toBeGreaterThan(80);
  });

  it("matches a partner the CSV only names inside another person's row", () => {
    const mainRow = row(["Franc", "Vilfan", "20 JUL 1877", "", "", "", "", "", "", "", "", "Renko", "99"]);
    // Janez is in the main file under his own name and birth year, but the CSV
    // only ever mentions him as Franc's partner.
    const incomingRow = row(["Franc", "Vilfan", "20 JUL 1877", "", "", "", "", "", "", "Janez Novak *1 JAN 1900", "", "Pokopališča-geneanet", "99"]);
    const csv = `${HEADER}\n${mainRow}\n${incomingRow}\n`;

    const mainDs = dataset(MAIN);
    const { dataset: compareDs, pairs } = parseGiMatchesCsv(csv);

    const result = matchGiPairs(mainDs, compareDs, pairs);
    expect(result.individuals.map((c) => [c.mainId, c.compareId])).toEqual([
      ["@I1@", "@SGI1@"],
      ["@I2@", "@SGI1P1@"],
    ]);
  });

  it("never offers a second candidate for a person the index already matched", () => {
    const mainRow = row(["Franc", "Vilfan", "20 JUL 1877", "", "", "", "", "", "", "", "", "Renko", "99"]);
    // The partner cell repeats Franc himself (same name, same birth year), so it
    // must not become a second candidate competing for the same main record.
    const incomingRow = row(["Franc", "Vilfan", "20 JUL 1877", "", "", "", "", "", "", "Franc Vilfan *20 JUL 1877", "", "Pokopališča-geneanet", "99"]);
    const csv = `${HEADER}\n${mainRow}\n${incomingRow}\n`;

    const mainDs = dataset(MAIN);
    const { dataset: compareDs, pairs } = parseGiMatchesCsv(csv);

    const result = matchGiPairs(mainDs, compareDs, pairs);
    expect(result.individuals).toHaveLength(1);
    expect(result.individuals[0].mainId).toBe("@I1@");
  });

  it("skips a pair whose main key doesn't match any individual", () => {
    const mainRow = row([
      "Unknown",
      "Person",
      "1 JAN 1800",
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
      "Unknown",
      "Person",
      "1 JAN 1800",
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
    const csv = `${HEADER}\n${mainRow}\n${incomingRow}\n`;

    const mainDs = dataset(MAIN);
    const { dataset: compareDs, pairs } = parseGiMatchesCsv(csv);

    const result = matchGiPairs(mainDs, compareDs, pairs);
    expect(result.individuals).toHaveLength(0);
  });
});
