import { describe, expect, it } from "vitest";
import { parseCsvText, parseGiMatchesCsv } from "./giMatches";
import { childrenNames, fatherName, motherName, partnerNames } from "../match/relatives";

const SL_HEADER =
  '"Ime","Priimek","Datum rojstva","Kraj rojstva","Datum smrti","Kraj smrti","Datum pokopa","Kraj pokopa","Povezave","Partnerji","Starši","Rodoslovec","Zaupanje"';

const EN_HEADER =
  '"Name","Surname","Date of Birth","Place of Birth","Date of Death","Place of Death","Burial date","Burial place","Links","Partners","Father","Mother","Genealogist","Confidence"';

const FAMILY_HEADER =
  '"Husband Name","Husband Surname","Husband Birth","Wife Name","Wife Surname","Wife Birth","Date of Marriage","Place of Marriage","Links","Children","Husband\'s Father","Husband\'s Mother","Wife\'s Father","Wife\'s Mother","Genealogist","Confidence"';

const FAMILY_HEADER_SL =
  '"Ime moža","Priimek moža","Rojstvo moža","Ime žene","Priimek žene","Rojstvo žene","Datum poroke","Kraj poroke","Povezave","Otroci","Oče moža","Mati moža","Oče žene","Mati žene","Rodoslovec","Zaupanje"';

// Current exports: the contributor column is labelled "Vir"/"Source" rather
// than "Rodoslovec"/"Genealogist", and the parents arrive as separate
// per-language "Oče"/"Mati" columns instead of the combined "Starši".
const SL_HEADER_SOURCE =
  '"Ime","Priimek","Datum rojstva","Kraj rojstva","Datum smrti","Kraj smrti","Datum pokopa","Kraj pokopa","Povezave","Partnerji","Oče","Mati","Vir","Zaupanje"';

const FAMILY_HEADER_SL_SOURCE =
  '"Ime moža","Priimek moža","Rojstvo moža","Ime žene","Priimek žene","Rojstvo žene","Datum poroke","Kraj poroke","Povezave","Otroci","Oče moža","Mati moža","Oče žene","Mati žene","Vir","Zaupanje"';

const FAMILY_HEADER_DE =
  '"Vorname des Mannes","Nachname des Mannes","Geburt des Mannes","Vorname der Frau","Nachname der Frau","Geburt der Frau","Heiratsdatum","Heiratsort","Links","Kinder","Vater des Mannes","Mutter des Mannes","Vater der Frau","Mutter der Frau","Quelle","Konfidenz"';

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

  it("pairs rows, resolves the main key, and builds a synthetic compare individual (Slovenian header)", () => {
    const mainRow = row([
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
    const text = `${SL_HEADER}\n${mainRow}\n${incomingRow}\n`;

    const { dataset, pairs } = parseGiMatchesCsv(text);
    expect(pairs[0].mainKey).toEqual({ given: "Franc", surname: "Vilfan", birthYear: 1877 });
    expect(pairs[0].compareId).toBe("@SGI1@");
    // The named partner is offered as a match of her own, after the CSV's row.
    expect(pairs.slice(1)).toEqual([
      { mainKey: { given: "Helena", surname: "Krt", birthYear: 1883 }, compareId: "@SGI1P1@" },
    ]);

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
    expect(indi?.notes).toBeUndefined();

    // "Žena: Helena Krt *1883" becomes a real partner family rather than a note.
    const partners = partnerNames(indi!, dataset);
    expect(partners).toHaveLength(1);
    expect(partners[0]).toEqual(expect.objectContaining({ given: "Helena", surname: "Krt" }));
  });

  it("handles the English header with separate Father/Mother columns", () => {
    const mainRow = row([
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
    const text = `${EN_HEADER}\n${mainRow}\n${incomingRow}\n`;

    const { dataset, pairs } = parseGiMatchesCsv(text);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].mainKey).toEqual({ given: "Stane", surname: "Tepina", birthYear: 1939 });

    const indi = dataset.individuals.get("@SGI1@");
    expect(indi?.notes).toBeUndefined();
  });

  it("accepts the current Slovenian person header (Vir contributor column, Oče/Mati parents)", () => {
    const mainRow = row([
      "Marjeta", "Slobodnik (Stepan)", "8 JUL 1804", "Bojanja vas, Metlika",
      "27 JUN 1843", "Bojanja vas, Metlika", "", "", "",
      "Matija Stepan | 28 JUL 1808",
      "Martin Slobodnik | 5 NOV 1771", "Margaretha Režek | 10 AUG 1772",
      "Renko", "99",
    ]);
    const incomingRow = row([
      "Marjeta", "Slobodnik", "8 JUL 1804", "Bojanja vas 43",
      "27 JUN 1843", "Bojanja vas 43", "", "", "",
      "Matja Stepan | 28 JUL 1808",
      "Martin Slobodnik | 6 SEP 1771", "Marjeta Režek | ABT 1770",
      "Kočevar", "99",
    ]);
    const text = `${SL_HEADER_SOURCE}\n${mainRow}\n${incomingRow}\n`;

    const { dataset, pairs } = parseGiMatchesCsv(text);
    expect(pairs).toEqual([
      { mainKey: { given: "Marjeta", surname: "Slobodnik", birthYear: 1804 }, compareId: "@SGI1@" },
      // Parents and partner are pairable in their own right, keyed on the
      // incoming spelling and birth year the CSV gives them.
      { mainKey: { given: "Martin", surname: "Slobodnik", birthYear: 1771 }, compareId: "@SGI1F@" },
      { mainKey: { given: "Marjeta", surname: "Režek", birthYear: 1770 }, compareId: "@SGI1M@" },
      { mainKey: { given: "Matja", surname: "Stepan", birthYear: 1808 }, compareId: "@SGI1P1@" },
    ]);

    // The Slovenian "Oče"/"Mati" columns must become real parent records.
    const indi = dataset.individuals.get("@SGI1@")!;
    expect(fatherName(indi, dataset)).toEqual(expect.objectContaining({ given: "Martin", surname: "Slobodnik" }));
    expect(motherName(indi, dataset)).toEqual(expect.objectContaining({ given: "Marjeta", surname: "Režek" }));
    expect(partnerNames(indi, dataset)).toEqual([
      expect.objectContaining({ given: "Matja", surname: "Stepan" }),
    ]);
  });

  it("folds a person named in several rows into one record with one family", () => {
    // Two match rows, husband and wife, each naming the other as their partner —
    // and the wife also named as their child's mother in a third row.
    const marko = [
      "Marko", "Kočevar", "14 MAY 1777", "Malo Lešče", "20 DEC 1834", "Malo Lešče", "", "", "",
      "Ana Štefanič | 3 JUN 1789", "", "", "Renko", "99",
    ];
    const ana = [
      "Ana", "Štefanič", "3 JUN 1789", "Malo Lešče", "", "", "", "", "",
      "Marko Kočevar | 14 MAY 1777", "", "", "Renko", "99",
    ];
    const son = [
      "Marko", "Kočevar", "2 FEB 1807", "Malo Lešče", "", "", "", "", "",
      "", "Marko Kočevar | 14 MAY 1777", "Ana Štefanič | 3 JUN 1789", "Renko", "99",
    ];
    const text = [SL_HEADER_SOURCE, row(marko), row(marko), row(ana), row(ana), row(son), row(son)].join("\n");

    const { dataset, pairs } = parseGiMatchesCsv(text);
    // Three people, three match rows — no stand-in records for the relatives.
    expect(dataset.individuals.size).toBe(3);
    expect(pairs.map((p) => p.compareId)).toEqual(["@SGI1@", "@SGI2@", "@SGI3@"]);

    // One marriage, reached as a partner from both spouses and as the son's parents.
    expect(dataset.families.size).toBe(1);
    const fam = [...dataset.families.values()][0];
    expect(fam.husband).toBe("@SGI1@");
    expect(fam.wife).toBe("@SGI2@");
    expect(fam.children).toEqual(["@SGI3@"]);

    const husband = dataset.individuals.get("@SGI1@")!;
    expect(partnerNames(husband, dataset)).toEqual([
      expect.objectContaining({ given: "Ana", surname: "Štefanič" }),
    ]);
    // The wife's record is her own match row, not a name-only stand-in.
    const wife = dataset.individuals.get("@SGI2@")!;
    expect(wife.events.find((e) => e.tag === "BIRT")?.place?.raw).toBe("Malo Lešče");
    expect(childrenNames(husband, dataset)).toEqual([
      expect.objectContaining({ given: "Marko", surname: "Kočevar" }),
    ]);
  });

  it("puts a couple the right way round once a row says who is the father", () => {
    // Ana's row names Marko as her partner without saying which spouse he is,
    // so that family's slots start as a guess. Their son's row then names Marko
    // as his father and Ana as his mother — the guess must give way, or Marko
    // ends up recorded as his wife's wife.
    const ana = [
      "Ana", "Štefanič", "3 JUN 1789", "", "", "", "", "", "",
      "Marko Kočevar | 14 MAY 1777", "", "", "Renko", "99",
    ];
    const son = [
      "Marko", "Kočevar", "2 FEB 1807", "", "", "", "", "", "",
      "", "Marko Kočevar | 14 MAY 1777", "Ana Štefanič | 3 JUN 1789", "Renko", "99",
    ];
    const text = [SL_HEADER_SOURCE, row(ana), row(ana), row(son), row(son)].join("\n");

    const { dataset } = parseGiMatchesCsv(text);
    expect(dataset.families.size).toBe(1);
    const fam = [...dataset.families.values()][0];
    const husband = dataset.individuals.get(fam.husband!)!;
    const wife = dataset.individuals.get(fam.wife!)!;
    expect(husband.names[0]).toEqual(expect.objectContaining({ given: "Marko", surname: "Kočevar" }));
    expect(wife.names[0]).toEqual(expect.objectContaining({ given: "Ana", surname: "Štefanič" }));
    // The roles the index states also give these people a sex.
    expect(husband.sex).toBe("M");
    expect(wife.sex).toBe("F");
  });

  it("settles a guessed marriage from a sex the CSV reveals elsewhere", () => {
    // Ana's row names Marko as her partner without saying which spouse he is,
    // and nothing marries them again. A later row calling Ana somebody's mother
    // is enough to put the couple the right way round.
    const ana = [
      "Ana", "Štefanič", "3 JUN 1789", "", "", "", "", "", "",
      "Marko Kočevar | 14 MAY 1777", "", "", "Renko", "99",
    ];
    const daughter = [
      "Marija", "Kočevar", "8 JUL 1812", "", "", "", "", "", "",
      "", "", "Ana Štefanič | 3 JUN 1789", "Renko", "99",
    ];
    const text = [SL_HEADER_SOURCE, row(ana), row(ana), row(daughter), row(daughter)].join("\n");

    const { dataset } = parseGiMatchesCsv(text);
    const marriage = [...dataset.families.values()].find((f) => f.husband && f.wife)!;
    expect(dataset.individuals.get(marriage.husband!)!.names[0]).toEqual(
      expect.objectContaining({ given: "Marko" }),
    );
    expect(dataset.individuals.get(marriage.wife!)!.names[0]).toEqual(
      expect.objectContaining({ given: "Ana" }),
    );
  });

  it("keeps same-named relatives apart when the CSV gives no birth year", () => {
    const first = [
      "Ana", "Novak", "3 JUN 1789", "", "", "", "", "", "",
      "Janez Kovač", "", "", "Renko", "99",
    ];
    const second = [
      "Marija", "Novak", "7 MAR 1793", "", "", "", "", "", "",
      "Janez Kovač", "", "", "Renko", "99",
    ];
    const text = [SL_HEADER_SOURCE, row(first), row(first), row(second), row(second)].join("\n");

    const { dataset, pairs } = parseGiMatchesCsv(text);
    // Undated "Janez Kovač" is as likely two men as one, so each row keeps its
    // own stand-in — and neither is offered as a match of its own.
    expect(dataset.individuals.size).toBe(4);
    expect(dataset.families.size).toBe(2);
    expect(pairs.map((p) => p.compareId)).toEqual(["@SGI1@", "@SGI2@"]);
  });

  it("accepts the current Slovenian family header (Vir contributor column)", () => {
    const mainRow = row([
      "Štefan", "Slobodnik", "27 SEP 1768",
      "Barbara", "Bajuk (NN)", "21 FEB 1767",
      "15 FEB 1786", "Metlika", "",
      "Stefan Slobodnik | 24 DEC 1793; Marko Slobodnik | 21 MAR 1796",
      "Matija Slobodnik | 21 SEP 1726", "Ana Mateković | 7 SEP 1734", "", "",
      "Renko", "97",
    ]);
    const incomingRow = row([
      "Štefan", "Slobodnik", "27 SEP 1768",
      "Barbara", "Bajuk", "ABT 1770",
      "15 FEB 1786", "", "",
      "Štefan Slobodnik | 24 DEC 1793; Marko Slobodnik | 21 MAR 1796",
      "Matija Slobodnik | ABT 1732", "Ana Mateković | ABT 1739", "", "",
      "Kočevar", "97",
    ]);
    const text = `${FAMILY_HEADER_SL_SOURCE}\n${mainRow}\n${incomingRow}\n`;

    const { dataset, pairs } = parseGiMatchesCsv(text);
    expect(pairs.slice(0, 2)).toEqual([
      { mainKey: { given: "Štefan", surname: "Slobodnik", birthYear: 1768 }, compareId: "@SGI1@" },
      { mainKey: { given: "Barbara", surname: "Bajuk", birthYear: 1767 }, compareId: "@SGI2@" },
    ]);
    // The couple's children and the husband's parents are pairable in their own
    // right, after the two people the row is a match for.
    expect(pairs.slice(2).map((p) => p.compareId)).toEqual([
      "@SGIFAM1C1@",
      "@SGIFAM1C2@",
      "@SGI1F@",
      "@SGI1M@",
    ]);

    const husband = dataset.individuals.get("@SGI1@")!;
    expect(fatherName(husband, dataset)).toEqual(expect.objectContaining({ given: "Matija", surname: "Slobodnik" }));
    expect(childrenNames(husband, dataset)).toEqual([
      expect.objectContaining({ given: "Štefan" }),
      expect.objectContaining({ given: "Marko" }),
    ]);
  });

  it("accepts the German family header", () => {
    const mainRow = row([
      "Anton", "Tabar", "7 JUN 1904",
      "Frančiška", "Bernard", "6 MAR 1904",
      "1 FEB 1931", "", "", "",
      "", "", "Jakob Bernard | 12 JUL 1879", "Frančiška Berčič | 29 JAN 1881",
      "Renko", "97",
    ]);
    const incomingRow = row([
      "Anton", "Tabar", "7 JUN 1904",
      "Frančiška", "Bernard", "6 MAR 1904",
      "1 FEB 1931", "Kranj", "", "Justina Tabar | 1932",
      "", "", "Jakob Bernard | 12 JUL 1879", "Frančiška Berčič | 29 JAN 1881",
      "Kovačič", "97",
    ]);
    const text = `${FAMILY_HEADER_DE}\n${mainRow}\n${incomingRow}\n`;

    const { dataset, pairs } = parseGiMatchesCsv(text);
    expect(pairs.slice(0, 2)).toEqual([
      { mainKey: { given: "Anton", surname: "Tabar", birthYear: 1904 }, compareId: "@SGI1@" },
      { mainKey: { given: "Frančiška", surname: "Bernard", birthYear: 1904 }, compareId: "@SGI2@" },
    ]);

    const wife = dataset.individuals.get("@SGI2@")!;
    expect(fatherName(wife, dataset)).toEqual(expect.objectContaining({ given: "Jakob", surname: "Bernard" }));
  });

  it("builds father/mother and partner families from the second row's Father/Mother/Partners fields", () => {
    const mainRow = row([
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
    const text = `${EN_HEADER}\n${mainRow}\n${incomingRow}\n`;

    const { dataset } = parseGiMatchesCsv(text);
    const indi = dataset.individuals.get("@SGI1@")!;

    // Partners/Father/Mother are now real family relationships, not notes.
    expect(indi.notes).toBeUndefined();

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
    const mainRow = row(["Ana", "Novak", "1 JAN 1900", "", "", "", "", "", "", "", "", "Renko", "99"]);
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
    const text = `${SL_HEADER}\n${mainRow}\n${incomingRow}\n"footer","with","fewer","columns"\n`;

    const { pairs } = parseGiMatchesCsv(text);
    expect(pairs).toHaveLength(1);
  });

  it("resolves a family match (Slovenian header) into husband and wife pairs", () => {
    const mainRow = row([
      "Anton", "Tabar", "7 JUN 1904",
      "Frančiška", "Bernard (Tabar)", "6 MAR 1904",
      "1 FEB 1931", "",
      "", "Justina Tabar | 1932; Marijan Tabar | 11 JUL 1933; <private>",
      "", "", "Jakob Bernard | 12 JUL 1879", "Frančiška Berčič | 29 JAN 1881",
      "Renko", "97",
    ]);
    const incomingRow = row([
      "Anton", "Tabar", "7 JUN 1904",
      "Frančiška", "Bernard", "6 MAR 1904",
      "1 FEB 1931", "",
      "", "<private>; <private>; <private>",
      "", "", "Jakob Bernard | 12 JUL 1879", "Frančiška Berčič | 29 JAN 1881",
      "Kovačič", "97",
    ]);
    const text = `${FAMILY_HEADER_SL}\n${mainRow}\n${incomingRow}\n`;

    const { dataset, pairs } = parseGiMatchesCsv(text);
    expect(pairs.slice(0, 2)).toEqual([
      { mainKey: { given: "Anton", surname: "Tabar", birthYear: 1904 }, compareId: "@SGI1@" },
      { mainKey: { given: "Frančiška", surname: "Bernard", birthYear: 1904 }, compareId: "@SGI2@" },
    ]);

    const husband = dataset.individuals.get("@SGI1@")!;
    const wife = dataset.individuals.get("@SGI2@")!;
    expect(husband.names[0]).toEqual(expect.objectContaining({ given: "Anton", surname: "Tabar" }));
    expect(wife.names[0]).toEqual(expect.objectContaining({ given: "Frančiška", surname: "Bernard" }));

    expect(fatherName(wife, dataset)).toEqual(expect.objectContaining({ given: "Jakob", surname: "Bernard" }));
    expect(motherName(wife, dataset)).toEqual(expect.objectContaining({ given: "Frančiška", surname: "Berčič" }));
  });

  it("strips a parenthetical alternate-spelling/maiden-name annotation from surnames on both rows", () => {
    // The Matricula-extraction ("Modrijan-matricula") row annotates the
    // archive's own (German-transliterated) spelling in parens; the main
    // row can likewise carry a maiden/married-name cross-reference. Neither
    // should pollute the literal surname used for matching or scoring.
    const mainRow = row([
      "Jurij", "Jakopič", "ABT 1795",
      "Marija", "Babič (Jakopič)", "8 AUG 1794",
      "BEF 1822", "",
      "", "",
      "", "", "", "",
      "Renko", "87",
    ]);
    const incomingRow = row([
      "Jurij", "Jakopič (Jakopetsch)", "",
      "Marija", "Babič (Babitsch)", "",
      "26 FEB 1810", "Dobrepolje - Videm",
      "", "",
      "", "", "", "",
      "Modrijan-matricula", "87",
    ]);
    const text = `${FAMILY_HEADER_SL}\n${mainRow}\n${incomingRow}\n`;

    const { dataset, pairs } = parseGiMatchesCsv(text);
    expect(pairs).toEqual([
      { mainKey: { given: "Jurij", surname: "Jakopič", birthYear: 1795 }, compareId: "@SGI1@" },
      { mainKey: { given: "Marija", surname: "Babič", birthYear: 1794 }, compareId: "@SGI2@" },
    ]);

    const husband = dataset.individuals.get("@SGI1@")!;
    const wife = dataset.individuals.get("@SGI2@")!;
    expect(husband.names[0]).toEqual(expect.objectContaining({ given: "Jurij", surname: "Jakopič" }));
    expect(wife.names[0]).toEqual(expect.objectContaining({ given: "Marija", surname: "Babič" }));
  });

  it("resolves a family match (Husband/Wife header) into husband and wife pairs", () => {
    const mainRow = row([
      "Franc",
      "Benedik",
      "1 SEP 1875",
      "Frančiška",
      "Volčič",
      "24 OCT 1878",
      "30 JAN 1907",
      "Stražišče, Kranj",
      "",
      "",
      "",
      "",
      "",
      "",
      "Renko",
      "85",
    ]);
    const incomingRow = row([
      "Franc",
      "Benedik",
      "1 SEP 1875",
      "Frančiška",
      "Volčič",
      "24 OCT 1878",
      "30 JAN 1907",
      "Stražišče, Kranj",
      "https://en.geneanet.org/cemetery/view/8419923",
      "Marija | 24 JUN 1901; Kristina | 22 JUL 1907",
      "Jakob Benedik | 1 JAN 1840",
      "",
      "Jakob Volčič | 3 MAY 1839",
      "Jera Rakovec | 27 FEB 1838",
      "Pokopališča-geneanet",
      "85",
    ]);
    const text = `${FAMILY_HEADER}\n${mainRow}\n${incomingRow}\n`;

    const { dataset, pairs } = parseGiMatchesCsv(text);
    expect(pairs.slice(0, 2)).toEqual([
      { mainKey: { given: "Franc", surname: "Benedik", birthYear: 1875 }, compareId: "@SGI1@" },
      { mainKey: { given: "Frančiška", surname: "Volčič", birthYear: 1878 }, compareId: "@SGI2@" },
    ]);

    const husband = dataset.individuals.get("@SGI1@")!;
    const wife = dataset.individuals.get("@SGI2@")!;
    expect(husband.names[0]).toEqual(expect.objectContaining({ given: "Franc", surname: "Benedik" }));
    expect(wife.names[0]).toEqual(expect.objectContaining({ given: "Frančiška", surname: "Volčič" }));
    expect(husband.notes).toBeUndefined();
    expect(wife.notes).toBeUndefined();

    // The shared family carries the marriage event (with its link) and children.
    const fam = dataset.families.get("@SGIFAM1@")!;
    expect(fam.husband).toBe("@SGI1@");
    expect(fam.wife).toBe("@SGI2@");
    const marr = fam.events.find((e) => e.tag === "MARR");
    expect(marr?.links).toContain("https://en.geneanet.org/cemetery/view/8419923");
    expect(marr?.place?.raw).toBe("Stražišče, Kranj");

    const children = childrenNames(husband, dataset);
    expect(children).toEqual([
      expect.objectContaining({ given: "Marija" }),
      expect.objectContaining({ given: "Kristina" }),
    ]);

    // Each side's parents become their own family.
    expect(fatherName(husband, dataset)).toEqual(expect.objectContaining({ given: "Jakob", surname: "Benedik" }));
    expect(fatherName(wife, dataset)).toEqual(expect.objectContaining({ given: "Jakob", surname: "Volčič" }));
    expect(motherName(wife, dataset)).toEqual(expect.objectContaining({ given: "Jera", surname: "Rakovec" }));
  });

  it("links a couple's child to their own marriage row", () => {
    // Row 1 marries Marko and Ana and names their son; row 2 is that son's own
    // marriage — the two rows must describe one man, not a stand-in plus a match.
    const parents = ["Marko", "Kočevar", "14 MAY 1777", "Ana", "Štefanič", "3 JUN 1789", "20 JAN 1806", "Metlika", "", "Marko Kočevar | 2 FEB 1807", "", "", "", "", "Renko", "97"];
    const son = ["Marko", "Kočevar", "2 FEB 1807", "Marija", "Jakljevič", "9 SEP 1810", "4 FEB 1833", "Metlika", "", "", "", "", "", "", "Renko", "97"];
    const text = [FAMILY_HEADER, row(parents), row(parents), row(son), row(son)].join("\n");

    const { dataset, pairs } = parseGiMatchesCsv(text);
    // Marko senior, Ana, Marko junior, Marija — the son is not doubled.
    expect(dataset.individuals.size).toBe(4);
    expect(pairs).toHaveLength(4);

    const junior = dataset.individuals.get("@SGI3@")!;
    expect(junior.names[0]).toEqual(expect.objectContaining({ given: "Marko", surname: "Kočevar" }));
    // He hangs under his parents' marriage and heads his own.
    expect(childrenNames(dataset.individuals.get("@SGI1@")!, dataset)).toEqual([
      expect.objectContaining({ given: "Marko", surname: "Kočevar" }),
    ]);
    expect(fatherName(junior, dataset)).toEqual(expect.objectContaining({ given: "Marko" }));
    expect(partnerNames(junior, dataset)).toEqual([
      expect.objectContaining({ given: "Marija", surname: "Jakljevič" }),
    ]);
  });

  it("merges multiple family rows for the same husband into one match entry with multiple FAMS", () => {
    // Anton Tabar married twice: first to Frančiška, then to Ana.
    const mainRow1 = row(["Anton", "Tabar", "7 JUN 1904", "Frančiška", "Bernard", "6 MAR 1904", "1 FEB 1931", "", "", "", "", "", "", "", "Renko", "97"]);
    const incomingRow1 = row(["Anton", "Tabar", "7 JUN 1904", "Frančiška", "Bernard", "6 MAR 1904", "1 FEB 1931", "Kranj", "", "Justina Tabar | 1932", "Franc Tabar | 1870", "Marija Krt | 1875", "", "", "Kovačič", "97"]);
    const mainRow2 = row(["Anton", "Tabar", "7 JUN 1904", "Ana", "Novak", "12 APR 1910", "5 MAR 1936", "", "", "", "", "", "", "", "Renko", "90"]);
    const incomingRow2 = row(["Anton", "Tabar", "7 JUN 1904", "Ana", "Novak", "12 APR 1910", "5 MAR 1936", "Ljubljana", "", "", "", "", "", "", "Kovačič", "90"]);
    const text = `${FAMILY_HEADER}\n${mainRow1}\n${incomingRow1}\n${mainRow2}\n${incomingRow2}\n`;

    const { dataset, pairs } = parseGiMatchesCsv(text);

    // Anton appears in two rows but produces only ONE match entry. The three
    // spouses lead; the child and Anton's parents follow as their own entries.
    expect(pairs.slice(0, 3).map((p) => p.mainKey.given)).toEqual(["Anton", "Frančiška", "Ana"]);
    expect(pairs.slice(3).map((p) => p.mainKey.given)).toEqual(["Justina", "Franc", "Marija"]);
    const antonPair = pairs.find((p) => p.mainKey.given === "Anton");
    const franciskaPair = pairs.find((p) => p.mainKey.given === "Frančiška");
    const anaPair = pairs.find((p) => p.mainKey.given === "Ana");
    expect(antonPair).toBeDefined();
    expect(franciskaPair).toBeDefined();
    expect(anaPair).toBeDefined();
    // All three should have distinct compare IDs.
    const ids = [antonPair!.compareId, franciskaPair!.compareId, anaPair!.compareId];
    expect(new Set(ids).size).toBe(3);

    // Anton's single compare individual has FAMS pointers to both marriages.
    const anton = dataset.individuals.get(antonPair!.compareId)!;
    expect(anton.spouseOf).toHaveLength(2);

    // Both marriage families exist and reference Anton.
    const fam1 = dataset.families.get("@SGIFAM1@")!;
    const fam2 = dataset.families.get("@SGIFAM2@")!;
    expect(fam1.husband).toBe(antonPair!.compareId);
    expect(fam2.husband).toBe(antonPair!.compareId);

    // Parents come from the first row that has them (fam1's incoming row).
    expect(fatherName(anton, dataset)).toEqual(expect.objectContaining({ given: "Franc", surname: "Tabar" }));
    expect(motherName(anton, dataset)).toEqual(expect.objectContaining({ given: "Marija", surname: "Krt" }));

    // Child from the first marriage is linked correctly.
    const children = childrenNames(anton, dataset);
    expect(children).toEqual([expect.objectContaining({ given: "Justina" })]);
  });
});
