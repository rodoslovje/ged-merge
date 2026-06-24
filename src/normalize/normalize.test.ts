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
    const { dataset: out, report } = normalizeDataset(compare, profile);
    expect(out.individuals.get("@I1@")!.links).toEqual([
      "https://data.matricula-online.eu/sl/slovenia/ljubljana/preddvor/04120/?pg=56",
    ]);
    expect(report.linksConverted).toBe(1);
    expect(report.linkExamples).toHaveLength(1);
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
    const { dataset: out, report } = normalizeDataset(compare, profile);
    expect(out.individuals.get("@I1@")!.links).toEqual(["https://de.geneanet.org/friedhof/view/9833663"]);
    expect(report.linksConverted).toBe(1);
  });
});

describe("normalizeDataset (place reshaping)", () => {
  it("splits a packed incoming place into the master's structured PLAC + ADDR on load", () => {
    const master = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 PLAC Kuželj,Kostel,Slovenia
2 ADDR Kuželj 22
0 TRLR
`);
    const compare = dataset(`0 HEAD
1 CHAR UTF-8
0 @P1@ INDI
1 BIRT
2 PLAC Kranj (Slovenija), Kidričeva 38/a (porodnišnica)
0 TRLR
`);
    const { dataset: out, report } = normalizeDataset(compare, inferMasterProfile(master));
    const birth = out.individuals.get("@P1@")!.events.find((e) => e.tag === "BIRT")!;
    expect(birth.place?.raw).toBe("Kranj,Slovenia");
    expect(birth.address?.raw).toBe("Kidričeva 38/a (porodnišnica)");
    expect(report.placesReshaped).toBe(1);
    expect(report.placeExamples).toHaveLength(1);
  });

  it("folds a structured incoming PLAC + ADDR into the master's packed PLAC on load", () => {
    const master = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 PLAC Kranj (Slovenija)
0 TRLR
`);
    const compare = dataset(`0 HEAD
1 CHAR UTF-8
0 @P1@ INDI
1 BIRT
2 PLAC Kranj,Slovenija
2 ADDR Kranj 15
0 TRLR
`);
    const { dataset: out } = normalizeDataset(compare, inferMasterProfile(master));
    const birth = out.individuals.get("@P1@")!.events.find((e) => e.tag === "BIRT")!;
    expect(birth.place?.raw).toBe("Kranj (Slovenija), Kranj 15");
    expect(birth.address?.raw).toBeUndefined();
  });

  it("leaves a PLAC with an explicit FORM untouched, keeping all its parts", () => {
    const master = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 PLAC Kuželj,Kostel,Slovenia
2 ADDR Kuželj 22
0 TRLR
`);
    const compare = dataset(`0 HEAD
1 CHAR UTF-8
0 @P1@ INDI
1 RESI
2 PLAC Hickory,,Caldwell,North Carolina,United States
3 FORM Place,Municipality,County,State,Country
3 MAP
4 LONG W81.328300055555559
4 LATI N35.737800122222225
0 TRLR
`);
    const { dataset: out, report } = normalizeDataset(compare, inferMasterProfile(master));
    const resi = out.individuals.get("@P1@")!.raw.children.find((c) => c.tag === "RESI")!;
    const placNode = resi.children.find((c) => c.tag === "PLAC")!;
    // FORM declares 5 parts; the empty Municipality slot must be kept so the
    // comma parts stay aligned with the FORM labels.
    expect(placNode.value).toBe("Hickory,,Caldwell,North Carolina,United States");
    expect(report.placesReshaped).toBe(0);
  });

  it("preserves a reshaped PLAC's MAP children and its position", () => {
    const master = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 PLAC Kuželj,Kostel,Slovenia
2 ADDR Kuželj 22
0 TRLR
`);
    const compare = dataset(`0 HEAD
1 CHAR UTF-8
0 @P1@ INDI
1 RESI
2 DATE 21 FEB 2011
2 PLAC Kranj (Slovenija)
3 MAP
4 LONG E14.0
4 LATI N46.0
2 NOTE later
0 TRLR
`);
    const { dataset: out } = normalizeDataset(compare, inferMasterProfile(master));
    const resi = out.individuals.get("@P1@")!.raw.children.find((c) => c.tag === "RESI")!;
    const placNode = resi.children.find((c) => c.tag === "PLAC")!;
    // The reshape changed the value but kept the MAP sub-node...
    expect(placNode.value).toBe("Kranj,Slovenia");
    const map = placNode.children.find((c) => c.tag === "MAP")!;
    expect(map.children.find((c) => c.tag === "LONG")?.value).toBe("E14.0");
    expect(map.children.find((c) => c.tag === "LATI")?.value).toBe("N46.0");
    // ...and left PLAC where it was, between DATE and NOTE rather than appended.
    expect(resi.children.map((c) => c.tag)).toEqual(["DATE", "PLAC", "NOTE"]);
  });

  it("appends a leftover parish detail to an existing AGNC rather than duplicating it", () => {
    const master = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 PLAC Kuželj,Kostel,Slovenia
2 ADDR Kuželj 22
0 TRLR
`);
    const compare = dataset(`0 HEAD
1 CHAR UTF-8
0 @P1@ INDI
1 BIRT
2 PLAC Kranj (Slovenija), Tatjane Odrove 4 - župnija Kranj
2 AGNC Maribor hospital
0 TRLR
`);
    const { dataset: out } = normalizeDataset(compare, inferMasterProfile(master));
    const birth = out.individuals.get("@P1@")!.events.find((e) => e.tag === "BIRT")!;
    expect(birth.agency).toBe("Maribor hospital; župnija Kranj");
  });

  it("keeps a facility-only ADDR unchanged instead of duplicating it in parentheses", () => {
    const master = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 PLAC Kuželj,Kostel,Slovenia
2 ADDR Kuželj 22
0 TRLR
`);
    const compare = dataset(`0 HEAD
1 CHAR UTF-8
0 @P1@ INDI
1 BURI
2 ADDR Pokopališče Zgornje Bitnje
0 TRLR
`);
    const { dataset: out, report } = normalizeDataset(compare, inferMasterProfile(master));
    const buri = out.individuals.get("@P1@")!.events.find((e) => e.tag === "BURI")!;
    // The cemetery name is a facility; it must not be echoed as "X (X)".
    expect(buri.address?.raw).toBe("Pokopališče Zgornje Bitnje");
    expect(report.placesReshaped).toBe(0);
  });

  it("does not reshape (or count) places when the master's layout doesn't call for it", () => {
    const master = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 PLAC Kranj, Slovenia
0 TRLR
`);
    const compare = dataset(`0 HEAD
1 CHAR UTF-8
0 @P1@ INDI
1 BIRT
2 PLAC Kranj (Slovenija), Kidričeva 38/a
0 TRLR
`);
    const { dataset: out, report } = normalizeDataset(compare, inferMasterProfile(master));
    const birth = out.individuals.get("@P1@")!.events.find((e) => e.tag === "BIRT")!;
    expect(birth.place?.raw).toBe("Kranj (Slovenija), Kidričeva 38/a");
    expect(report.placesReshaped).toBe(0);
  });
});

describe("normalizeDataset (master-learned place hierarchy)", () => {
  // The master attests "Kranj,Kranj,Slovenia" and "Stražišče,Kranj,Slovenia"
  // elsewhere, plus a parish/street tying Stražišče to "župnija Šmartin" /
  // "Hafnarjeva pot" — so an incoming place naming only "Kranj" can be
  // completed and, where the parish/street says more, sharpened.
  const master = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 PLAC Kranj,Kranj,Slovenia
0 @I2@ INDI
1 BIRT
2 PLAC Stražišče,Kranj,Slovenia
2 ADDR Hafnarjeva pot 5
2 AGNC župnija Šmartin
0 TRLR
`);

  it("inserts the municipality level the master always writes for a known locality", () => {
    const compare = dataset(`0 HEAD
1 CHAR UTF-8
0 @P1@ INDI
1 BIRT
2 PLAC Kranj,Slovenia
0 TRLR
`);
    const { dataset: out } = normalizeDataset(compare, inferMasterProfile(master));
    const birth = out.individuals.get("@P1@")!.events.find((e) => e.tag === "BIRT")!;
    expect(birth.place?.raw).toBe("Kranj,Kranj,Slovenia");
  });

  it("sharpens a generic locality using the AGNC parish, keeping the existing ADDR", () => {
    const compare = dataset(`0 HEAD
1 CHAR UTF-8
0 @P1@ INDI
1 RESI
2 PLAC Kranj,Slovenia
2 ADDR Hafnarjeva pot 21/a
2 AGNC župnija Šmartin
0 TRLR
`);
    const { dataset: out } = normalizeDataset(compare, inferMasterProfile(master));
    const resi = out.individuals.get("@P1@")!.events.find((e) => e.tag === "RESI")!;
    expect(resi.place?.raw).toBe("Stražišče,Kranj,Slovenia");
    expect(resi.address?.raw).toBe("Hafnarjeva pot 21/a");
    // The AGNC was already in its own field — left as-is, not duplicated.
    expect(resi.agency).toBe("župnija Šmartin");
  });

  it("sharpens a generic locality when the incoming place is a single packed PLAC (no separate ADDR/AGNC)", () => {
    // The real-world case: a Brother's Keeper-style source packs locality,
    // street+number, and parish into one PLAC value — decomposePlace's
    // `.street` keeps the house number attached ("Hafnarjeva pot 21/a"), so
    // the street hint must be stripped before it's compared to the learned
    // (number-free) key.
    const compare = dataset(`0 HEAD
1 CHAR UTF-8
0 @P1@ INDI
1 RESI
2 PLAC Kranj (Slovenija), Hafnarjeva pot 21/a - župnija Šmartin
0 TRLR
`);
    const { dataset: out } = normalizeDataset(compare, inferMasterProfile(master));
    const resi = out.individuals.get("@P1@")!.events.find((e) => e.tag === "RESI")!;
    expect(resi.place?.raw).toBe("Stražišče,Kranj,Slovenia");
    expect(resi.address?.raw).toBe("Hafnarjeva pot 21/a");
  });

  it("prefers a rare, correctly-narrowed locality over many generic ones on the same street", () => {
    // Realistic noisy data: most family members on "Hafnarjeva pot" were
    // entered loosely as "Kranj,Kranj,Slovenia"; only one record was ever
    // corrected to the actual hamlet "Stražišče". A naive majority vote would
    // pick "Kranj" (it's outnumbered 4 to 1) — the generic ones must be
    // excluded from the tally instead of just outweighed.
    const noisyMaster = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 RESI
2 PLAC Kranj,Kranj,Slovenia
2 ADDR Hafnarjeva pot 3
0 @I2@ INDI
1 RESI
2 PLAC Kranj,Kranj,Slovenia
2 ADDR Hafnarjeva pot 9
0 @I3@ INDI
1 RESI
2 PLAC Kranj,Kranj,Slovenia
2 ADDR Hafnarjeva pot 12
0 @I4@ INDI
1 RESI
2 PLAC Kranj,Kranj,Slovenia
2 ADDR Hafnarjeva pot 15
0 @I5@ INDI
1 RESI
2 PLAC Stražišče,Kranj,Slovenia
2 ADDR Hafnarjeva pot 21a / 53
0 TRLR
`);
    const compare = dataset(`0 HEAD
1 CHAR UTF-8
0 @P1@ INDI
1 RESI
2 PLAC Kranj,Slovenia
2 ADDR Hafnarjeva pot 21/a
0 TRLR
`);
    const { dataset: out } = normalizeDataset(compare, inferMasterProfile(noisyMaster));
    const resi = out.individuals.get("@P1@")!.events.find((e) => e.tag === "RESI")!;
    expect(resi.place?.raw).toBe("Stražišče,Kranj,Slovenia");
  });

  it("sharpens a generic locality from a master address using the old/new dual house-number form", () => {
    // Master's own ADDR for @I2@ uses "21a / 53" (a historical house number
    // alongside the later official one) — decomposePlace must strip the whole
    // tail to learn "Hafnarjeva pot" cleanly, not a garbled locality.
    const masterDual = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 PLAC Kranj,Kranj,Slovenia
0 @I2@ INDI
1 BIRT
2 PLAC Stražišče,Kranj,Slovenia
2 ADDR Hafnarjeva pot 21a / 53
0 TRLR
`);
    const compare = dataset(`0 HEAD
1 CHAR UTF-8
0 @P1@ INDI
1 RESI
2 PLAC Kranj,Slovenia
2 ADDR Hafnarjeva pot 21/a
0 TRLR
`);
    const { dataset: out } = normalizeDataset(compare, inferMasterProfile(masterDual));
    const resi = out.individuals.get("@P1@")!.events.find((e) => e.tag === "RESI")!;
    expect(resi.place?.raw).toBe("Stražišče,Kranj,Slovenia");
    expect(resi.address?.raw).toBe("Hafnarjeva pot 21/a");
  });

  it("sharpens a generic locality from the street alone when there's no AGNC", () => {
    const compare = dataset(`0 HEAD
1 CHAR UTF-8
0 @P1@ INDI
1 BIRT
2 PLAC Kranj,Slovenia
2 ADDR Hafnarjeva pot 7
0 TRLR
`);
    const { dataset: out } = normalizeDataset(compare, inferMasterProfile(master));
    const birth = out.individuals.get("@P1@")!.events.find((e) => e.tag === "BIRT")!;
    expect(birth.place?.raw).toBe("Stražišče,Kranj,Slovenia");
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
