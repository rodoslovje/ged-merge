import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { ancestorSurnames, directLine, earliestKnown, ftdnaSurnameRows, placeAt } from "./dna";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;

// Root Janez; father Anton Novak, mother Marija (born Oblak, married name
// Novak); paternal grandfather Jožef NOVAK (capitals); maternal grandmother
// known only as "Neža" (no surname), her mother Uršula Kos fully named.
// Marija also has an adoptive mother, who must not count.
const TREE = wrap(
  "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1950\n1 FAMC @F1@\n" +
    "0 @I2@ INDI\n1 NAME Anton /Novak/\n1 SEX M\n1 BIRT\n2 DATE ABT 1920\n2 PLAC Šentvid, Ljubljana, Slovenija\n1 FAMC @F2@\n1 FAMS @F1@\n" +
    "0 @I3@ INDI\n1 NAME Marija /Novak/\n2 TYPE married\n1 NAME Marija /Oblak/\n2 TYPE birth\n1 SEX F\n1 BIRT\n2 DATE 1922\n2 PLAC Kranj, Slovenija\n" +
    "1 FAMC @F3@\n1 FAMC @F9@\n2 PEDI adopted\n1 FAMS @F1@\n" +
    "0 @I4@ INDI\n1 NAME Jožef /NOVAK/\n1 SEX M\n1 BAPM\n2 DATE 1890\n2 PLAC Šentvid, Ljubljana, Slovenija\n1 FAMS @F2@\n" +
    "0 @I5@ INDI\n1 NAME Neža //\n1 SEX F\n1 FAMC @F4@\n1 FAMS @F3@\n" +
    "0 @I6@ INDI\n1 NAME Uršula /Kos/\n1 SEX F\n1 BIRT\n2 DATE 1860\n2 PLAC Bled, Slovenija\n1 FAMS @F4@\n" +
    "0 @I7@ INDI\n1 NAME Ivan /Oblak/\n1 SEX M\n1 DEAT\n2 PLAC Kranj, Slovenija\n1 FAMS @F3@\n" +
    "0 @I9@ INDI\n1 NAME Rozalija /Zupan/\n1 SEX F\n1 FAMS @F9@\n" +
    "0 @F1@ FAM\n1 HUSB @I2@\n1 WIFE @I3@\n1 CHIL @I1@\n" +
    "0 @F2@ FAM\n1 HUSB @I4@\n1 CHIL @I2@\n" +
    "0 @F3@ FAM\n1 HUSB @I7@\n1 WIFE @I5@\n1 CHIL @I3@\n" +
    "0 @F4@ FAM\n1 WIFE @I6@\n1 CHIL @I5@\n" +
    "0 @F9@ FAM\n1 WIFE @I9@\n1 CHIL @I3@\n",
);

describe("ancestorSurnames", () => {
  const ds = dataset(TREE);

  it("lists birth surnames with places, once per pair, ancestors only", () => {
    const rows = ancestorSurnames(ds, "@I1@", { maxGenerations: 0, place: "localityCountry" });
    expect(rows.map((r) => [r.surname, r.location])).toEqual([
      ["Kos", "Bled, Slovenija"],
      ["Novak", "Šentvid, Slovenija"],
      ["Oblak", "Kranj, Slovenija"],
    ]);
    const novak = rows.find((r) => r.surname === "Novak")!;
    expect(novak.personIds).toEqual(["@I2@", "@I4@"]);
    expect([novak.fromYear, novak.toYear]).toEqual([1890, 1920]);
    // Adoptive mother Zupan is not a DNA ancestor; Neža has no surname.
    expect(rows.some((r) => r.surname === "Zupan")).toBe(false);
  });

  it("stops at the generation limit", () => {
    const rows = ancestorSurnames(ds, "@I1@", { maxGenerations: 1, place: "none" });
    expect(rows.map((r) => [r.surname, r.location])).toEqual([["Novak", ""], ["Oblak", ""]]);
  });

  it("writes FamilyTreeDNA's two columns", () => {
    const rows = ancestorSurnames(ds, "@I1@", { maxGenerations: 1, place: "country" });
    expect(ftdnaSurnameRows(rows)).toEqual([["Surname", "Location"], ["Novak", "Slovenija"], ["Oblak", "Slovenija"]]);
  });
});

describe("directLine / earliestKnown", () => {
  const ds = dataset(TREE);

  it("follows the father's father", () => {
    const line = directLine(ds, "@I1@", "paternal");
    expect(line.map((s) => s.id)).toEqual(["@I2@", "@I4@"]);
    expect(line[0]).toMatchObject({ given: "Anton", surname: "Novak", birthYear: 1920, birthApprox: true });
    expect(earliestKnown(line)?.id).toBe("@I4@");
  });

  it("skips a farthest mother who has no surname, but keeps one above her", () => {
    const line = directLine(ds, "@I1@", "maternal");
    expect(line.map((s) => s.id)).toEqual(["@I3@", "@I5@", "@I6@"]);
    expect(line[0].surname).toBe("Oblak");
    expect(line[1].usable).toBe(false);
    expect(earliestKnown(line)?.id).toBe("@I6@");
    expect(earliestKnown(line.slice(0, 2))?.id).toBe("@I3@");
  });
});

describe("placeAt", () => {
  const place = { raw: "Šentvid, , Ljubljana, Slovenija", parts: ["Šentvid", "", "Ljubljana", "Slovenija"] };
  it("cuts a place to the chosen level, skipping empty parts", () => {
    expect(placeAt(place, "full")).toBe("Šentvid, Ljubljana, Slovenija");
    expect(placeAt(place, "locality")).toBe("Šentvid");
    expect(placeAt(place, "country")).toBe("Slovenija");
    expect(placeAt(place, "none")).toBe("");
  });
});
