import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { detectPlaceLayout, inferDateProfile, inferMasterProfile } from "./profile";
import { normalizeDataset } from "./normalize";
import { formatGedDate } from "./date";
import { parseDate } from "../gedcom/date";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

// Master uses lowercase full month names, zero-padded days, and the spelling
// "Wien" / "Österreich". Compare uses standard uppercase abbreviations and
// lowercase place names. (Cross-language month translation is out of scope:
// detection covers month case, abbreviated-vs-full, and day padding.)
const MASTER = `0 HEAD
1 GEDC
2 VERS 5.5.1
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Franz /Müller/
1 BIRT
2 DATE 05 january 1880
2 PLAC Wien, Österreich
1 DEAT
2 DATE 03 march 1950
2 PLAC Wien, Österreich
0 TRLR
`;

const COMPARE = `0 HEAD
1 GEDC
2 VERS 5.5.1
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Anna /Müller/
1 BIRT
2 DATE 5 JAN 1885
2 PLAC wien, österreich
0 TRLR
`;

describe("inferMasterProfile", () => {
  it("detects lowercase full-month style and day padding", () => {
    const profile = inferMasterProfile(dataset(MASTER));
    expect(profile.date.monthTokens[1]).toBe("january");
    expect(profile.date.monthTokens[3]).toBe("march");
    expect(profile.date.padDay).toBe(true);
  });

  it("captures canonical place casing/spelling", () => {
    const profile = inferMasterProfile(dataset(MASTER));
    expect(profile.place.partCanonical.get("wien")).toBe("Wien");
    expect(profile.place.partCanonical.get("österreich")).toBe("Österreich");
    expect(profile.place.modalDepth).toBe(2);
  });
});

describe("formatGedDate", () => {
  it("renders qualifiers and ranges in master style", () => {
    const profile = inferMasterProfile(dataset(MASTER));
    expect(formatGedDate(parseDate("12 FEB 1900"), profile.date)).toBe("12 february 1900");
    expect(formatGedDate(parseDate("ABT 1900"), profile.date)).toBe("ABT 1900");
    expect(formatGedDate(parseDate("BET 1900 AND 1905"), profile.date)).toBe(
      "BET 1900 AND 1905",
    );
    expect(formatGedDate(parseDate("FROM 1900 TO 1905"), profile.date)).toBe(
      "FROM 1900 TO 1905",
    );
  });
});

describe("normalizeDataset", () => {
  it("converts compare dates to master conventions but leaves place text as-is", () => {
    const profile = inferMasterProfile(dataset(MASTER));
    const { dataset: out, report } = normalizeDataset(dataset(COMPARE), profile);

    const anna = out.individuals.get("@I1@")!;
    const birth = anna.events.find((e) => e.tag === "BIRT")!;
    expect(birth.date?.raw).toBe("05 january 1885");
    // Place names keep their original casing/spelling — not recased to master.
    expect(birth.place?.raw).toBe("wien, österreich");

    expect(report.datesChanged).toBe(1);
    expect(report.dateExamples[0]).toEqual({ before: "5 JAN 1885", after: "05 january 1885" });
  });

  it("compacts place whitespace silently (not counted or listed)", () => {
    const profile = inferMasterProfile(dataset(MASTER));
    const messy = `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 PLAC zgornje   bitnje  52,  kranj
0 TRLR
`;
    const { dataset: out } = normalizeDataset(dataset(messy), profile);
    const birth = out.individuals.get("@I1@")!.events.find((e) => e.tag === "BIRT")!;
    expect(birth.place?.raw).toBe("zgornje bitnje 52, kranj");
  });

  it("does not mutate the input dataset", () => {
    const profile = inferMasterProfile(dataset(MASTER));
    const input = dataset(COMPARE);
    normalizeDataset(input, profile);
    const anna = input.individuals.get("@I1@")!;
    expect(anna.events.find((e) => e.tag === "BIRT")?.date?.raw).toBe("5 JAN 1885");
  });

  it("converts a Matricula Online link to the master's language on load", () => {
    const master = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 WWW https://data.matricula-online.eu/sl/slovenia/ljubljana/kranj/01/
0 TRLR
`);
    const compare = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 WWW https://data.matricula-online.eu/de/slovenia/ljubljana/preddvor/04120/?pg=56
0 TRLR
`);
    const profile = inferMasterProfile(master);
    const { dataset: out } = normalizeDataset(compare, profile);
    expect(out.individuals.get("@I1@")!.links).toEqual([
      "https://data.matricula-online.eu/sl/slovenia/ljubljana/preddvor/04120/?pg=56",
    ]);
  });

  it("converts a Geneanet cemetery link to the master's language on load", () => {
    const master = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 WWW https://de.geneanet.org/friedhof/view/1111111
0 TRLR
`);
    const compare = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 WWW https://en.geneanet.org/cemetery/view/9833663
0 TRLR
`);
    const profile = inferMasterProfile(master);
    const { dataset: out } = normalizeDataset(compare, profile);
    expect(out.individuals.get("@I1@")!.links).toEqual(["https://de.geneanet.org/friedhof/view/9833663"]);
  });
});

// --- place-layout detection ------------------------------------------------

describe("detectPlaceLayout", () => {
  it("detects Renko-style structured PLAC + separate ADDR", () => {
    const placs = [
      "Kuželj,Kostel,Slovenia",
      "Srednje Bitnje,Kranj,Slovenia",
      "Spodnje Bitnje,Kranj,Slovenia",
      "Stara Sušica,Primorje-Gorski Kotar,Croatia",
    ];
    // ~30% of places carry an ADDR line, as in the Renko file.
    expect(detectPlaceLayout(placs, 2)).toBe("structured-addr");
  });

  it("detects Brother's Keeper packed PLAC (country in parens, parish inline)", () => {
    const placs = [
      "Kranj (Slovenija), Kidričeva 38/a (porodnišnica)",
      "Jesenice (Slovenija), Cesta revolucije 2/b - župnija Jesenice",
      "Jesenice (Slovenija)",
      "Podčetrtek (Slovenija), Podčetrtek 52 - župnija Šmarje pri Jelšah",
    ];
    expect(detectPlaceLayout(placs, 0)).toBe("packed-plac");
  });

  it("detects address-only single-part places", () => {
    expect(detectPlaceLayout(["Zgornje Bitnje 52", "Kuželj 22", "Krasinec 16"], 0)).toBe(
      "address-only",
    );
  });

  it("detects a plain comma hierarchy with no embedded addresses", () => {
    expect(detectPlaceLayout(["Kranj, Slovenia", "Bled, Slovenia"], 0)).toBe(
      "plain-structured",
    );
  });

  it("returns unknown when there are no places", () => {
    expect(detectPlaceLayout([], 0)).toBe("unknown");
  });
});

// --- numeric date formats --------------------------------------------------

describe("inferDateProfile (numeric)", () => {
  it("detects DD.MM.YYYY (European, dotted)", () => {
    const p = inferDateProfile(["20.02.1989", "01.12.1990", "31.07.1888"]);
    expect(p.numeric).toEqual({
      order: "DMY",
      separator: ".",
      padDay: true,
      padMonth: true,
    });
  });

  it("detects MM/DD/YYYY (US, slashed) from a day > 12", () => {
    const p = inferDateProfile(["02/20/1989", "7/4/1776"]);
    expect(p.numeric?.order).toBe("MDY");
    expect(p.numeric?.separator).toBe("/");
  });

  it("defaults ambiguous slashed dates to MDY", () => {
    const p = inferDateProfile(["02/03/1989", "05/06/1990"]);
    expect(p.numeric?.order).toBe("MDY");
  });

  it("detects YYYY-MM-DD (ISO)", () => {
    const p = inferDateProfile(["1989-02-20", "1990-12-01"]);
    expect(p.numeric).toMatchObject({ order: "YMD", separator: "-" });
  });

  it("leaves month-word masters non-numeric", () => {
    const p = inferDateProfile(["20 FEB 1989", "1 JAN 1990"]);
    expect(p.numeric).toBeUndefined();
  });
});

describe("formatGedDate (numeric output)", () => {
  it("renders into a DD.MM.YYYY master style", () => {
    const profile = inferDateProfile(["20.02.1989"]);
    expect(formatGedDate(parseDate("12 FEB 1900"), profile)).toBe("12.02.1900");
    expect(formatGedDate(parseDate("FEB 1900"), profile)).toBe("02.1900");
    expect(formatGedDate(parseDate("1900"), profile)).toBe("1900");
    expect(formatGedDate(parseDate("ABT 5 JAN 1880"), profile)).toBe("ABT 05.01.1880");
  });

  it("renders into a YYYY-MM-DD master style", () => {
    const profile = inferDateProfile(["1989-02-20"]);
    expect(formatGedDate(parseDate("12 FEB 1900"), profile)).toBe("1900-02-12");
  });
});

describe("parseDate (2-digit years)", () => {
  it("expands 2-digit years in numeric dates (window picks the 1900s for 32–99)", () => {
    expect(parseDate("20.02.89", "DMY")).toMatchObject({ day: 20, month: 2, year: 1989 });
    expect(parseDate("3/7/76", "MDY")).toMatchObject({ month: 3, day: 7, year: 1976 });
  });

  it("expands 2-digit years disambiguated by a month word", () => {
    expect(parseDate("5 JAN 89")).toMatchObject({ day: 5, month: 1, year: 1989 });
    expect(parseDate("JAN 50")).toMatchObject({ month: 1, year: 1950 });
  });

  it("re-renders an expanded 2-digit year in the master's full-year style", () => {
    const profile = inferDateProfile(["20 Feb 1989"]);
    expect(formatGedDate(parseDate("03.06.88", "DMY"), profile)).toBe("3 Jun 1988");
  });
});

describe("date qualifiers", () => {
  const profile = inferDateProfile(["20 Feb 1989"]); // D Mmm YYYY, abbr, title

  it("treats ABT / ABOUT / ~ / EST / CCA / CIRCA / CA as the same 'about'", () => {
    for (const raw of ["ABT 1900", "ABOUT 1900", "~1900", "~ 1900", "EST 1900",
      "CCA 1900", "CCA. 1900", "CIRCA 1900", "CA 1900", "Cir 1900"]) {
      expect(parseDate(raw).qualifier).toBe("about");
      // All normalize to a single canonical token in the output.
      expect(formatGedDate(parseDate(raw), profile)).toBe("ABT 1900");
    }
  });

  it("normalizes an about-qualified full date and its inner date style", () => {
    expect(formatGedDate(parseDate("CCA 5 JAN 1880"), profile)).toBe("ABT 5 Jan 1880");
  });

  it("supports FROM…TO ranges, normalizing both endpoints", () => {
    expect(formatGedDate(parseDate("FROM 5 JAN 1900 TO 3 MAR 1905"), profile)).toBe(
      "FROM 5 Jan 1900 TO 3 Mar 1905",
    );
    // Endpoints in a numeric source are reformatted to the master style too.
    expect(formatGedDate(parseDate("FROM 05.01.1900 TO 03.03.1905", "DMY"), profile)).toBe(
      "FROM 5 Jan 1900 TO 3 Mar 1905",
    );
  });

  it("supports BET…AND ranges", () => {
    expect(formatGedDate(parseDate("BET 1900 AND 1905"), profile)).toBe(
      "BET 1900 AND 1905",
    );
  });
});

describe("normalizeDataset (numeric conversion)", () => {
  const numericMaster = (dates: string[]) => `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
${dates.map((d) => `1 EVEN\n2 DATE ${d}`).join("\n")}
0 TRLR
`;

  it("converts month-word compare dates to the master's DD.MM.YYYY", () => {
    const profile = inferMasterProfile(dataset(numericMaster(["20.02.1989", "01.05.1990"])));
    const compare = `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 DATE 5 JAN 1885
0 TRLR
`;
    const { dataset: out } = normalizeDataset(dataset(compare), profile);
    const birth = out.individuals.get("@I1@")!.events.find((e) => e.tag === "BIRT")!;
    expect(birth.date?.raw).toBe("05.01.1885");
  });

  it("converts the master's example (D Mmm YYYY) from a numeric compare file", () => {
    // Master like Renko-Rakar-Jekovec-Pezdirc.ged: "20 Feb 1989".
    const profile = inferMasterProfile(dataset(numericMaster(["20 Feb 1989", "1 May 1990"])));
    const compare = `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 DATE 03.06.1885
0 TRLR
`;
    const { dataset: out } = normalizeDataset(dataset(compare), profile);
    const birth = out.individuals.get("@I1@")!.events.find((e) => e.tag === "BIRT")!;
    expect(birth.date?.raw).toBe("3 Jun 1885");
  });

  it("uses the compare file's own order to disambiguate its numeric dates", () => {
    // Master is month-word; compare is unambiguously MDY (a 02/20 proves it).
    const profile = inferMasterProfile(dataset(numericMaster(["20 Feb 1989"])));
    const compare = `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 DATE 02/20/1885
1 DEAT
2 DATE 05/06/1950
0 TRLR
`;
    const { dataset: out } = normalizeDataset(dataset(compare), profile);
    const events = out.individuals.get("@I1@")!.events;
    expect(events.find((e) => e.tag === "BIRT")?.date?.raw).toBe("20 Feb 1885");
    // 05/06 is read as MDY (May 6), per the file's detected order.
    expect(events.find((e) => e.tag === "DEAT")?.date?.raw).toBe("6 May 1950");
  });
});
