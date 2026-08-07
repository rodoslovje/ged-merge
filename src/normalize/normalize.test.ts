import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import {
  detectPlaceLayout,
  inferDateProfile,
  inferMainProfile,
  inferNameLayout,
  inferPlaceExportFormat,
  placeFormFor,
} from "./profile";
import { normalizeDataset } from "./normalize";
import { formatGedDate } from "./date";
import { parseDate } from "../gedcom/date";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

// Main uses lowercase full month names, zero-padded days, and the spelling
// "Wien" / "Österreich". Compare uses standard uppercase abbreviations and
// lowercase place names. (Cross-language month translation is out of scope:
// detection covers month case, abbreviated-vs-full, and day padding.)
const MAIN = `0 HEAD
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

describe("inferMainProfile", () => {
  it("detects lowercase full-month style and day padding", () => {
    const profile = inferMainProfile(dataset(MAIN));
    expect(profile.date.monthTokens[1]).toBe("january");
    expect(profile.date.monthTokens[3]).toBe("march");
    expect(profile.date.padDay).toBe(true);
  });

  it("captures canonical place casing/spelling", () => {
    const profile = inferMainProfile(dataset(MAIN));
    expect(profile.place.partCanonical.get("wien")).toBe("Wien");
    expect(profile.place.partCanonical.get("österreich")).toBe("Österreich");
    expect(profile.place.modalDepth).toBe(2);
  });
});

describe("formatGedDate", () => {
  it("renders qualifiers and ranges in main style", () => {
    const profile = inferMainProfile(dataset(MAIN));
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
  it("converts compare dates to main conventions but leaves place text as-is", () => {
    const profile = inferMainProfile(dataset(MAIN));
    const { dataset: out, report } = normalizeDataset(dataset(COMPARE), profile);

    const anna = out.individuals.get("@I1@")!;
    const birth = anna.events.find((e) => e.tag === "BIRT")!;
    expect(birth.date?.raw).toBe("05 january 1885");
    // Place names keep their original casing/spelling — not recased to main.
    expect(birth.place?.raw).toBe("wien, österreich");

    expect(report.datesChanged).toBe(1);
    expect(report.dateExamples[0]).toEqual({ before: "5 JAN 1885", after: "05 january 1885" });
  });

  it("compacts place whitespace silently (not counted or listed)", () => {
    const profile = inferMainProfile(dataset(MAIN));
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

  it("renames vendor-tag synonyms (_MILI → _MILT) and reports them", () => {
    const profile = inferMainProfile(dataset(MAIN));
    const compare = `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Janez /Novak/
1 _MILI vojak JA
2 DATE 5 JAN 1945
0 TRLR
`;
    const { dataset: out, report } = normalizeDataset(dataset(compare), profile);
    const milt = out.individuals.get("@I1@")!.events.find((e) => e.tag === "_MILT");
    expect(milt?.value).toBe("vojak JA");
    expect(milt?.date?.raw).toBeTruthy();
    expect(out.individuals.get("@I1@")!.events.some((e) => e.tag === "_MILI")).toBe(false);
    expect(report.vendorTagsRenamed).toBe(1);
    expect(report.vendorTagExamples[0]).toEqual({ before: "_MILI", after: "_MILT" });
  });

  it("leaves vendor-tag synonyms alone when the pass is deselected", () => {
    const profile = inferMainProfile(dataset(MAIN));
    const compare = `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Janez /Novak/
1 _MILI vojak JA
0 TRLR
`;
    const { dataset: out, report } = normalizeDataset(dataset(compare), profile, undefined, {
      dates: true, places: true, links: true, names: true, vendorTags: false,
    });
    expect(out.individuals.get("@I1@")!.events.some((e) => e.tag === "_MILI")).toBe(true);
    expect(report.vendorTagsRenamed).toBe(0);
  });

  it("converts a _UPD stamp into a standard CHAN when the record has none", () => {
    const profile = inferMainProfile(dataset(MAIN));
    const compare = `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Janez /Novak/
1 _UPD 23 JUL 2011 14:39:50 GMT+1
0 @I2@ INDI
1 NAME Ana /Kos/
1 _UPD 9 MAY 2022 04:35:16 GMT -0500
1 CHAN
2 DATE 1 JAN 2023
0 TRLR
`;
    const { dataset: out, report } = normalizeDataset(dataset(compare), profile);
    const i1 = out.individuals.get("@I1@")!.raw;
    const chan = i1.children.find((c) => c.tag === "CHAN")!;
    expect(i1.children.some((c) => c.tag === "_UPD")).toBe(false);
    // The new CHAN date then goes through the date pass like any other DATE,
    // so it comes out in the main's house style (lowercase full months here).
    expect(chan.children[0]).toMatchObject({ tag: "DATE", value: "23 july 2011" });
    expect(chan.children[0].children[0]).toMatchObject({ tag: "TIME", value: "14:39:50" });
    // A record that already has CHAN keeps its _UPD untouched.
    const i2 = out.individuals.get("@I2@")!.raw;
    expect(i2.children.some((c) => c.tag === "_UPD")).toBe(true);
    expect(report.vendorTagExamples.some((e) => e.after.startsWith("CHAN"))).toBe(true);
  });

  it("strips software-internal tags only when the opt-in pass is selected", () => {
    const profile = inferMainProfile(dataset(MAIN));
    const compare = `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Janez /Novak/
1 _COLOR 3
1 _FLGS
2 __FLAG_2 Y
1 _UID AAAABBBBCCCCDDDD
1 BIRT
2 DATE 1900
2 _EVN 2
0 TRLR
`;
    // Default (load-time): nothing stripped.
    const loaded = normalizeDataset(dataset(compare), profile);
    expect(loaded.report.internalStripped).toBe(0);
    expect(loaded.dataset.individuals.get("@I1@")!.raw.children.some((c) => c.tag === "_COLOR")).toBe(true);
    // Opt-in: internal tags go, identity/media tags stay.
    const stripped = normalizeDataset(dataset(compare), profile, undefined, {
      dates: true, places: true, links: true, names: true, vendorTags: true, stripInternal: true,
    });
    const raw = stripped.dataset.individuals.get("@I1@")!.raw;
    expect(raw.children.some((c) => c.tag === "_COLOR" || c.tag === "_FLGS")).toBe(false);
    expect(raw.children.find((c) => c.tag === "BIRT")!.children.some((c) => c.tag === "_EVN")).toBe(false);
    expect(raw.children.some((c) => c.tag === "_UID")).toBe(true);
    expect(stripped.report.internalStripped).toBe(3);
  });

  it("renames MacFamilyTree's bare MISE fact to the _MILT military event", () => {
    const profile = inferMainProfile(dataset(MAIN));
    const compare = `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Janez /Novak/
1 MISE Gefreiter, k.k. Landsturm
2 DATE 1915
0 TRLR
`;
    const { dataset: out } = normalizeDataset(dataset(compare), profile);
    const milt = out.individuals.get("@I1@")!.events.find((e) => e.tag === "_MILT");
    expect(milt?.value).toBe("Gefreiter, k.k. Landsturm");
  });

  it("renames _SEPR to the standard SEPA family event", () => {
    const profile = inferMainProfile(dataset(MAIN));
    const compare = `0 HEAD
1 CHAR UTF-8
0 @F1@ FAM
1 _SEPR
2 DATE 5 JAN 1930
0 TRLR
`;
    const { dataset: out } = normalizeDataset(dataset(compare), profile);
    const fam = out.families.get("@F1@")!;
    expect(fam.events.some((e) => e.tag === "SEPA")).toBe(true);
    expect(fam.raw.children.some((c) => c.tag === "_SEPR")).toBe(false);
  });

  it("consolidates partnership-status encodings into _MSTAT", () => {
    const profile = inferMainProfile(dataset(MAIN));
    const compare = `0 HEAD
1 CHAR UTF-8
0 @F1@ FAM
1 EVEN
2 TYPE MYHERITAGE:REL_PARTNERS
0 @F2@ FAM
1 _NMR
1 _MSTAT Partners
1 _MARRIED N
0 @F3@ FAM
1 _NMR
0 @F4@ FAM
1 _STAT Divorced
0 TRLR
`;
    const { dataset: out, report } = normalizeDataset(dataset(compare), profile);
    const tags = (id: string) => out.families.get(id)!.raw.children.map((c) => `${c.tag}${c.value ? " " + c.value : ""}`);
    // MyHeritage relationship event becomes the canonical status tag.
    expect(tags("@F1@")).toEqual(["_MSTAT Partners"]);
    // The BK trio collapses to its value-bearing member.
    expect(tags("@F2@")).toEqual(["_MSTAT Partners"]);
    // A lone never-married flag carries the assertion itself.
    expect(tags("@F3@")).toEqual(["_MSTAT Partners"]);
    // FTM's _STAT is the same fact under another name.
    expect(tags("@F4@")).toEqual(["_MSTAT Divorced"]);
    expect(report.vendorTagsRenamed).toBe(5); // F1 + F2 (2 drops) + F3 + F4
    // The typed model lifts _MSTAT as a family event with its value.
    expect(out.families.get("@F1@")!.events.find((e) => e.tag === "_MSTAT")?.value).toBe("Partners");
  });

  it("converts agreeing _FREL/_MREL into FAMC PEDI and drops the birth-pair noise", () => {
    const profile = inferMainProfile(dataset(MAIN));
    const compare = `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Adopted /Child/
1 FAMC @F1@
0 @I2@ INDI
1 NAME Natural /Child/
1 FAMC @F1@
0 @I3@ INDI
1 NAME Mixed /Child/
1 FAMC @F1@
0 @F1@ FAM
1 CHIL @I1@
2 _FREL Adopted
2 _MREL Adopted
1 CHIL @I2@
2 _FREL Natural
2 _MREL Natural
1 CHIL @I3@
2 _FREL Natural
2 _MREL Adopted
0 TRLR
`;
    const { dataset: out } = normalizeDataset(dataset(compare), profile);
    const famc = (id: string) => out.individuals.get(id)!.raw.children.find((c) => c.tag === "FAMC")!;
    const chil = (id: string) => out.families.get("@F1@")!.raw.children.find((c) => c.tag === "CHIL" && c.value === id)!;
    // Agreeing adopted pair → standard PEDI on the child's FAMC, vendor tags gone.
    expect(famc("@I1@").children.find((c) => c.tag === "PEDI")?.value).toBe("adopted");
    expect(chil("@I1@").children).toHaveLength(0);
    // Default natural pair is dropped without a PEDI.
    expect(famc("@I2@").children.some((c) => c.tag === "PEDI")).toBe(false);
    expect(chil("@I2@").children).toHaveLength(0);
    // Per-parent mismatch is preserved verbatim — PEDI cannot express it.
    expect(chil("@I3@").children.map((c) => c.tag)).toEqual(["_FREL", "_MREL"]);
  });

  it("does not mutate the input dataset", () => {
    const profile = inferMainProfile(dataset(MAIN));
    const input = dataset(COMPARE);
    normalizeDataset(input, profile);
    const anna = input.individuals.get("@I1@")!;
    expect(anna.events.find((e) => e.tag === "BIRT")?.date?.raw).toBe("5 JAN 1885");
  });

  it("converts a Matricula Online link to the main's language on load", () => {
    const main = dataset(`0 HEAD
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
    const profile = inferMainProfile(main);
    const { dataset: out, report } = normalizeDataset(compare, profile);
    expect(out.individuals.get("@I1@")!.links).toEqual([
      "https://data.matricula-online.eu/sl/slovenia/ljubljana/preddvor/04120/?pg=56",
    ]);
    expect(report.linksConverted).toBe(1);
    expect(report.linkExamples).toHaveLength(1);
  });

  it("converts a Geneanet cemetery link to the main's language on load", () => {
    const main = dataset(`0 HEAD
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
    const profile = inferMainProfile(main);
    const { dataset: out, report } = normalizeDataset(compare, profile);
    expect(out.individuals.get("@I1@")!.links).toEqual(["https://de.geneanet.org/friedhof/view/9833663"]);
    expect(report.linksConverted).toBe(1);
  });
});

describe("inferNameLayout", () => {
  it("detects the inline-tag storage style", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Marija /Kovač/
2 _MARNM Maček
0 @I2@ INDI
1 NAME Ana /Novak/
2 _MARNM Kovač
0 TRLR
`);
    expect(inferNameLayout(ds)).toBe("tags");
  });

  it("detects the typed-record storage style", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Marija /Težak/
1 NAME /Simonič/
2 TYPE married
0 TRLR
`);
    expect(inferNameLayout(ds)).toBe("records");
  });

  it("returns none when no alternate names are recorded", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Marija /Kovač/
0 TRLR
`);
    expect(inferNameLayout(ds)).toBe("none");
  });
});

describe("normalizeDataset (married-name reshaping)", () => {
  const marnmMain = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Marija /Kovač/
2 _MARNM Maček
0 TRLR
`);
  const recordMain = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Marija /Težak/
1 NAME /Simonič/
2 TYPE married
0 TRLR
`);

  it("converts a separate TYPE married record into inline _MARNM when the main uses _MARNM", () => {
    const compare = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ana /Novak/
1 NAME /Kovač/
2 TYPE married
0 TRLR
`);
    const { dataset: out, report } = normalizeDataset(compare, inferMainProfile(marnmMain));
    const name = out.individuals.get("@I1@")!.names;
    expect(name).toHaveLength(1);
    expect(name[0].married).toBe("Kovač");
    expect(report.nameVariantsReshaped).toBe(1);
    expect(report.nameVariantExamples).toHaveLength(1);
  });

  it("converts inline _MARNM into a separate TYPE married record when the main uses records", () => {
    const compare = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ana /Novak/
2 _MARNM Kovač
0 TRLR
`);
    const { dataset: out, report } = normalizeDataset(compare, inferMainProfile(recordMain));
    const names = out.individuals.get("@I1@")!.names;
    expect(names).toHaveLength(2);
    expect(names[0].married).toBeUndefined();
    expect(names[1].type).toBe("married");
    expect(names[1].surname).toBe("Kovač");
    expect(report.nameVariantsReshaped).toBe(1);
  });

  it("leaves married names untouched when the main records none", () => {
    const noneMain = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Marija /Kovač/
0 TRLR
`);
    const compare = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ana /Novak/
2 _MARNM Kovač
0 TRLR
`);
    const { dataset: out, report } = normalizeDataset(compare, inferMainProfile(noneMain));
    expect(out.individuals.get("@I1@")!.names[0].married).toBe("Kovač");
    expect(report.nameVariantsReshaped).toBe(0);
  });
});

describe("normalizeDataset (name-variant reshaping)", () => {
  // Main uses separate, lowercase TYPE records for every variant.
  const recordMain = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Marija /Težak/
1 NAME /Simonič/
2 TYPE married
1 NAME Marija /Kovač/
2 TYPE birth
1 NAME Betty //
2 TYPE aka
1 NAME Bea //
2 TYPE nick
0 TRLR
`);
  // Main uses inline custom tags.
  const tagMain = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Marija /Kovač/
2 _MARNM Maček
2 _BIRN Zelzer
2 _AKA Mojca
0 TRLR
`);

  it("folds inline _BIRN into a TYPE birth record when the main uses records", () => {
    const compare = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Franc /Celcer/
2 _BIRN Zelzer
0 TRLR
`);
    const { dataset: out } = normalizeDataset(compare, inferMainProfile(recordMain));
    const names = out.individuals.get("@I1@")!.names;
    expect(names).toHaveLength(2);
    expect(names[1].type).toBe("birth");
    expect(names[1].surname).toBe("Zelzer");
  });

  it("folds a TYPE birth record into inline _BIRN when the main uses tags", () => {
    const compare = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Franc /Celcer/
1 NAME Franc /Zelzer/
2 TYPE birth
0 TRLR
`);
    const { dataset: out } = normalizeDataset(compare, inferMainProfile(tagMain));
    const indi = out.individuals.get("@I1@")!;
    expect(indi.names).toHaveLength(1);
    expect(indi.raw.children.find((c) => c.tag === "NAME")!.children.some((c) => c.tag === "_BIRN" && c.value === "Zelzer")).toBe(true);
  });

  it("renames a sibling AKA tag (_AKAN) to the main's preferred tag (_AKA)", () => {
    const compare = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Davor /Gregorc/
2 _AKAN Cic
0 TRLR
`);
    const { dataset: out, report } = normalizeDataset(compare, inferMainProfile(tagMain));
    const nameNode = out.individuals.get("@I1@")!.raw.children.find((c) => c.tag === "NAME")!;
    expect(nameNode.children.some((c) => c.tag === "_AKA" && c.value === "Cic")).toBe(true);
    expect(nameNode.children.some((c) => c.tag === "_AKAN")).toBe(false);
    expect(report.nameVariantsReshaped).toBe(1);
  });

  it("keeps an AKA record that has a surname as a record (no lossy fold to a tag)", () => {
    const compare = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Alphonse /Mivez/
1 NAME Betty /Blevins/
2 TYPE aka
0 TRLR
`);
    const { dataset: out } = normalizeDataset(compare, inferMainProfile(tagMain));
    const names = out.individuals.get("@I1@")!.names;
    expect(names).toHaveLength(2);
    expect(names[1].type).toBe("aka");
  });

  it("recases and unifies TYPE tokens to the main's spelling (MARRIED→married, maiden→birth)", () => {
    const compare = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ana /Novak/
1 NAME /Kovač/
2 TYPE MARRIED
1 NAME Ana /Pirc/
2 TYPE maiden
0 TRLR
`);
    const { dataset: out, report } = normalizeDataset(compare, inferMainProfile(recordMain));
    const names = out.individuals.get("@I1@")!.names;
    expect(names[1].type).toBe("married");
    expect(names[2].type).toBe("birth");
    expect(report.nameVariantsReshaped).toBe(2);
  });

  it("converts a NICK sub-tag into a TYPE nick record when the main uses records", () => {
    const compare = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Marija /Kovač/
2 NICK Mimi
0 TRLR
`);
    const { dataset: out } = normalizeDataset(compare, inferMainProfile(recordMain));
    const names = out.individuals.get("@I1@")!.names;
    expect(names[0].nickname).toBeUndefined();
    expect(names.some((n) => n.type === "nick" && n.given === "Mimi")).toBe(true);
  });
});

describe("normalizeDataset (place reshaping)", () => {
  it("splits a packed incoming place into the main's structured PLAC + ADDR on load", () => {
    const main = dataset(`0 HEAD
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
    const { dataset: out, report } = normalizeDataset(compare, inferMainProfile(main));
    const birth = out.individuals.get("@P1@")!.events.find((e) => e.tag === "BIRT")!;
    expect(birth.place?.raw).toBe("Kranj,Slovenia");
    expect(birth.address?.raw).toBe("Kidričeva 38/a (porodnišnica)");
    expect(report.placesReshaped).toBe(1);
    expect(report.placeExamples).toHaveLength(1);
  });

  it("folds a structured incoming PLAC + ADDR into the main's packed PLAC on load", () => {
    const main = dataset(`0 HEAD
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
    const { dataset: out } = normalizeDataset(compare, inferMainProfile(main));
    const birth = out.individuals.get("@P1@")!.events.find((e) => e.tag === "BIRT")!;
    expect(birth.place?.raw).toBe("Kranj (Slovenija), Kranj 15");
    expect(birth.address?.raw).toBeUndefined();
  });

  it("leaves a PLAC with an explicit FORM untouched, keeping all its parts", () => {
    const main = dataset(`0 HEAD
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
    const { dataset: out, report } = normalizeDataset(compare, inferMainProfile(main));
    const resi = out.individuals.get("@P1@")!.raw.children.find((c) => c.tag === "RESI")!;
    const placNode = resi.children.find((c) => c.tag === "PLAC")!;
    // FORM declares 5 parts; the empty Municipality slot must be kept so the
    // comma parts stay aligned with the FORM labels.
    expect(placNode.value).toBe("Hickory,,Caldwell,North Carolina,United States");
    expect(report.placesReshaped).toBe(0);
  });

  it("preserves a reshaped PLAC's MAP children and its position", () => {
    const main = dataset(`0 HEAD
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
    const { dataset: out } = normalizeDataset(compare, inferMainProfile(main));
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
    const main = dataset(`0 HEAD
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
    const { dataset: out } = normalizeDataset(compare, inferMainProfile(main));
    const birth = out.individuals.get("@P1@")!.events.find((e) => e.tag === "BIRT")!;
    expect(birth.agency).toBe("Maribor hospital; župnija Kranj");
  });

  it("keeps a facility-only ADDR unchanged instead of duplicating it in parentheses", () => {
    const main = dataset(`0 HEAD
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
    const { dataset: out, report } = normalizeDataset(compare, inferMainProfile(main));
    const buri = out.individuals.get("@P1@")!.events.find((e) => e.tag === "BURI")!;
    // The cemetery name is a facility; it must not be echoed as "X (X)".
    expect(buri.address?.raw).toBe("Pokopališče Zgornje Bitnje");
    expect(report.placesReshaped).toBe(0);
  });

  it("does not reshape (or count) places when the main's layout doesn't call for it", () => {
    const main = dataset(`0 HEAD
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
    const { dataset: out, report } = normalizeDataset(compare, inferMainProfile(main));
    const birth = out.individuals.get("@P1@")!.events.find((e) => e.tag === "BIRT")!;
    expect(birth.place?.raw).toBe("Kranj (Slovenija), Kidričeva 38/a");
    expect(report.placesReshaped).toBe(0);
  });
});

describe("normalizeDataset (main-learned place hierarchy)", () => {
  // The main attests "Kranj,Kranj,Slovenia" and "Stražišče,Kranj,Slovenia"
  // elsewhere, plus a street tying Stražišče to "Hafnarjeva pot" — so an
  // incoming place naming only "Kranj" can be completed and, where the street
  // says more, sharpened. (A parish is not a sharpening hint — it spans villages.)
  const main = dataset(`0 HEAD
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

  it("inserts the municipality level the main always writes for a known locality", () => {
    const compare = dataset(`0 HEAD
1 CHAR UTF-8
0 @P1@ INDI
1 BIRT
2 PLAC Kranj,Slovenia
0 TRLR
`);
    const { dataset: out } = normalizeDataset(compare, inferMainProfile(main));
    const birth = out.individuals.get("@P1@")!.events.find((e) => e.tag === "BIRT")!;
    expect(birth.place?.raw).toBe("Kranj,Kranj,Slovenia");
  });

  it("sharpens a generic locality using the street, keeping the existing AGNC", () => {
    const compare = dataset(`0 HEAD
1 CHAR UTF-8
0 @P1@ INDI
1 RESI
2 PLAC Kranj,Slovenia
2 ADDR Hafnarjeva pot 21/a
2 AGNC župnija Šmartin
0 TRLR
`);
    const { dataset: out } = normalizeDataset(compare, inferMainProfile(main));
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
    const { dataset: out } = normalizeDataset(compare, inferMainProfile(main));
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
    const noisyMain = dataset(`0 HEAD
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
    const { dataset: out } = normalizeDataset(compare, inferMainProfile(noisyMain));
    const resi = out.individuals.get("@P1@")!.events.find((e) => e.tag === "RESI")!;
    expect(resi.place?.raw).toBe("Stražišče,Kranj,Slovenia");
  });

  it("sharpens a generic locality from a main address using the old/new dual house-number form", () => {
    // Main's own ADDR for @I2@ uses "21a / 53" (a historical house number
    // alongside the later official one) — decomposePlace must strip the whole
    // tail to learn "Hafnarjeva pot" cleanly, not a garbled locality.
    const mainDual = dataset(`0 HEAD
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
    const { dataset: out } = normalizeDataset(compare, inferMainProfile(mainDual));
    const resi = out.individuals.get("@P1@")!.events.find((e) => e.tag === "RESI")!;
    expect(resi.place?.raw).toBe("Stražišče,Kranj,Slovenia");
    expect(resi.address?.raw).toBe("Hafnarjeva pot 21/a");
  });

  it("does not relocate an already-specific locality whose ADDR just echoes it before a house number", () => {
    // Main ties the *street* "Zgornje Bitnje" to the hamlet "Stražišče" (people
    // on that road were filed under Stražišče). An incoming record already named
    // "Zgornje Bitnje" with ADDR "Zgornje Bitnje 165" must stay put — the ADDR is
    // "locality + house number", not a disambiguating street.
    let g = `0 HEAD\n1 CHAR UTF-8\n`;
    for (let i = 1; i <= 8; i++)
      g += `0 @S${i}@ INDI\n1 BIRT\n2 PLAC Stražišče,Kranj,Slovenia\n2 ADDR Zgornje Bitnje ${i}\n`;
    g += `0 TRLR\n`;
    const main = dataset(g);
    const compare = dataset(
      `0 HEAD\n1 CHAR UTF-8\n0 @P1@ INDI\n1 BIRT\n` +
      `2 PLAC Zgornje Bitnje,Kranj,Slovenia\n2 ADDR Zgornje Bitnje 165\n0 TRLR\n`,
    );
    const { dataset: out } = normalizeDataset(compare, inferMainProfile(main));
    const birt = out.individuals.get("@P1@")!.events.find((e) => e.tag === "BIRT")!;
    expect(birt.place?.raw).toBe("Zgornje Bitnje,Kranj,Slovenia");
    expect(birt.address?.raw).toBe("Zgornje Bitnje 165");
  });

  it("does not relocate a village-numbered address that shortens the locality's name", () => {
    // Village numbering often writes the settlement short: houses in "Breg ob
    // Savi" are addressed "Breg N". That name is not a street and identifies no
    // village of its own, so a record already filed in *another* Breg —
    // "Breg ob Kokri", a different municipality entirely — must stay where it
    // is. It used to be moved to Breg ob Savi while keeping Preddvor as its
    // municipality, inventing a place that exists nowhere.
    let g = `0 HEAD\n1 CHAR UTF-8\n`;
    for (let i = 1; i <= 8; i++)
      g += `0 @S${i}@ INDI\n1 BIRT\n2 PLAC Breg ob Savi,Kranj,Slovenia\n2 ADDR Breg ${i}\n`;
    g += `0 TRLR\n`;
    const main = dataset(g);
    const compare = dataset(
      `0 HEAD\n1 CHAR UTF-8\n0 @P1@ INDI\n1 BIRT\n` +
      `2 PLAC Breg ob Kokri,Preddvor,Slovenia\n2 ADDR Breg 12 (pd Boštek)\n0 TRLR\n`,
    );
    const { dataset: out, report } = normalizeDataset(compare, inferMainProfile(main));
    const birt = out.individuals.get("@P1@")!.events.find((e) => e.tag === "BIRT")!;
    expect(birt.place?.raw).toBe("Breg ob Kokri,Preddvor,Slovenia");
    expect(birt.address?.raw).toBe("Breg 12 (pd Boštek)");
    expect(report.placesReshaped).toBe(0);
  });

  it("does not append a country to itself as its own parent level", () => {
    // One record written "Italy, Italy" (an import repeating the country as a
    // municipality) used to teach that the parent of Italy is Italy, so every
    // plain "Italy" in the file was doubled. Nothing stands above a country.
    const main = dataset(
      `0 HEAD\n1 CHAR UTF-8\n` +
      `0 @I1@ INDI\n1 BIRT\n2 PLAC Italy, Italy\n` +
      `0 @I2@ INDI\n1 BIRT\n2 PLAC Kranj, Kranj, Slovenia\n2 ADDR Kidričeva 38\n0 TRLR\n`,
    );
    const compare = dataset(
      `0 HEAD\n1 CHAR UTF-8\n0 @P1@ INDI\n1 BIRT\n2 PLAC Italy\n0 TRLR\n`,
    );
    const { dataset: out } = normalizeDataset(compare, inferMainProfile(main));
    const birt = out.individuals.get("@P1@")!.events.find((e) => e.tag === "BIRT")!;
    expect(birt.place?.raw).toBe("Italy");
  });

  it("keeps a 'po domače' house name once when a dangling dash precedes it in the ADDR", () => {
    const main = dataset(
      `0 HEAD\n1 CHAR UTF-8\n` +
      `0 @I1@ INDI\n1 BIRT\n2 PLAC Zgornje Bitnje,Kranj,Slovenia\n2 ADDR Zgornje Bitnje 7\n0 TRLR\n`,
    );
    const compare = dataset(
      `0 HEAD\n1 CHAR UTF-8\n0 @P1@ INDI\n1 BIRT\n` +
      `2 PLAC Zgornje Bitnje,Kranj,Slovenia\n2 ADDR Zgornje Bitnje 42 - (pd V dolini)\n0 TRLR\n`,
    );
    const { dataset: out } = normalizeDataset(compare, inferMainProfile(main));
    const birt = out.individuals.get("@P1@")!.events.find((e) => e.tag === "BIRT")!;
    expect(birt.address?.raw).toBe("Zgornje Bitnje 42 (pd V dolini)");
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
    const { dataset: out } = normalizeDataset(compare, inferMainProfile(main));
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

  it("leaves month-word mains non-numeric", () => {
    const p = inferDateProfile(["20 FEB 1989", "1 JAN 1990"]);
    expect(p.numeric).toBeUndefined();
  });
});

describe("formatGedDate (numeric output)", () => {
  it("renders into a DD.MM.YYYY main style", () => {
    const profile = inferDateProfile(["20.02.1989"]);
    expect(formatGedDate(parseDate("12 FEB 1900"), profile)).toBe("12.02.1900");
    expect(formatGedDate(parseDate("FEB 1900"), profile)).toBe("02.1900");
    expect(formatGedDate(parseDate("1900"), profile)).toBe("1900");
    expect(formatGedDate(parseDate("ABT 5 JAN 1880"), profile)).toBe("ABT 05.01.1880");
  });

  it("renders into a YYYY-MM-DD main style", () => {
    const profile = inferDateProfile(["1989-02-20"]);
    expect(formatGedDate(parseDate("12 FEB 1900"), profile)).toBe("1900-02-12");
  });
});

describe("unknown-date placeholders", () => {
  // A main that pads unknown components ("__.05.1900", ".__.____").
  const profile = inferDateProfile(["20.02.1989", "__.05.1888", ".__.____"]);

  it("detects the main's placeholder character", () => {
    expect(profile.numeric).toMatchObject({ order: "DMY", separator: ".", placeholder: "_" });
  });

  it("fills a missing day beneath a known month", () => {
    expect(formatGedDate(parseDate("FEB 1900"), profile)).toBe("__.02.1900");
    expect(formatGedDate(parseDate("_.9.1911"), profile)).toBe("__.09.1911");
  });

  it("re-renders a fully-unknown date in the main's placeholder layout", () => {
    expect(formatGedDate(parseDate(".__.____"), profile)).toBe("__.__.____");
    expect(formatGedDate(parseDate("__.__.____"), profile)).toBe("__.__.____");
  });

  it("keeps year-only and full dates unchanged", () => {
    expect(formatGedDate(parseDate("1900"), profile)).toBe("1900");
    expect(formatGedDate(parseDate(".__.1945"), profile)).toBe("1945");
    expect(formatGedDate(parseDate("12 FEB 1900"), profile)).toBe("12.02.1900");
  });

  it("without a placeholder convention, drops unknown parts and keeps raw", () => {
    const plain = inferDateProfile(["20.02.1989"]);
    expect(formatGedDate(parseDate("FEB 1900"), plain)).toBe("02.1900");
    expect(formatGedDate(parseDate(".__.____"), plain)).toBe(".__.____");
  });
});

describe("normalizeDataset (placeholder-date dropping)", () => {
  const COMPARE_PH = `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Jožef /Porenta/
1 BIRT
2 DATE ABT 1745
1 DEAT
2 DATE .__.____
2 PLAC Spodnje Bitnje
0 TRLR
`;

  it("strips an all-placeholder DATE when the main has no placeholder convention", () => {
    // Main writes real numeric dates only — no "__.__.____" house style.
    const main = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 DATE 20.02.1989
0 TRLR
`);
    const { dataset: out, report } = normalizeDataset(dataset(COMPARE_PH), inferMainProfile(main));
    const death = out.individuals.get("@I1@")!.events.find((e) => e.tag === "DEAT")!;
    expect(death.date).toBeUndefined();
    expect(death.place?.raw).toBe("Spodnje Bitnje"); // the rest of the event is untouched
    expect(report.dateExamples).toContainEqual({ before: ".__.____", after: "(blank)" });
  });

  it("keeps and reshapes a placeholder DATE when the main uses one", () => {
    // Main pads unknown components ("__.__.____") — two such values establish
    // it as a house convention, so the incoming placeholder is kept, not dropped.
    const main = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 DATE __.05.1888
1 DEAT
2 DATE .__.____
0 @I2@ INDI
1 BIRT
2 DATE 20.02.1989
0 TRLR
`);
    const { dataset: out } = normalizeDataset(dataset(COMPARE_PH), inferMainProfile(main));
    const death = out.individuals.get("@I1@")!.events.find((e) => e.tag === "DEAT")!;
    expect(death.date?.raw).toBe("__.__.____");
  });
});

describe("normalizeDataset (placeholder-place dropping)", () => {
  const MAIN_PLAIN = `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 PLAC Jama, Kranj, Slovenia
0 TRLR
`;

  function normalizeCompare(compare: string) {
    const { dataset: out, report } = normalizeDataset(dataset(compare), inferMainProfile(dataset(MAIN_PLAIN)));
    return { indi: out.individuals.get("@I1@")!, report };
  }

  it("drops an all-placeholder PLAC so it stops showing as a difference", () => {
    const { indi, report } = normalizeCompare(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 DATE ABT 1670
2 PLAC ----
1 DEAT
2 PLAC unknown
0 TRLR
`);
    expect(indi.events.find((e) => e.tag === "BIRT")!.place).toBeUndefined();
    expect(indi.events.find((e) => e.tag === "BIRT")!.date?.raw).toBe("ABT 1670"); // rest of the event untouched
    expect(indi.events.find((e) => e.tag === "DEAT")!.place).toBeUndefined();
    expect(report.placeExamples).toContainEqual({ before: "----", after: "(blank)" });
  });

  it("drops a placeholder written out part by part, and a placeholder ADDR", () => {
    const { indi } = normalizeCompare(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 RESI
2 PLAC ????, ????
2 ADDR N.N.
0 TRLR
`);
    const resi = indi.events.find((e) => e.tag === "RESI")!;
    expect(resi.place).toBeUndefined();
    expect(resi.address).toBeUndefined();
  });

  // The incoming file is being reshaped to the house style anyway, so its
  // stray spaces are tidied before they reach the merged file. (One's own file
  // is left alone — see the bulk-normalize test.)
  it("still tidies whitespace in an incoming place value", () => {
    const { indi } = normalizeCompare(
      ["0 HEAD", "1 CHAR UTF-8", "0 @I1@ INDI", "1 BIRT", "2 PLAC Jama,  Kranj, Slovenia ", "0 TRLR"].join("\n"),
    );
    const plac = indi.raw.children.find((c) => c.tag === "BIRT")!.children.find((c) => c.tag === "PLAC")!;
    expect(plac.value).toBe("Jama, Kranj, Slovenia");
  });

  it("keeps a place where any part is real", () => {
    const { indi } = normalizeCompare(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 PLAC ----, Kranj, Slovenia
0 TRLR
`);
    expect(indi.events.find((e) => e.tag === "BIRT")!.place?.raw).toBe("----, Kranj, Slovenia");
  });

  it("keeps a placeholder PLAC that carries a subtree, so nothing else is lost", () => {
    const { indi } = normalizeCompare(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 PLAC ----
3 NOTE the parish register gives no place
0 TRLR
`);
    expect(indi.events.find((e) => e.tag === "BIRT")!.place?.raw).toBe("----");
  });

  it("leaves placeholder places alone when place normalization is switched off", () => {
    const { dataset: out } = normalizeDataset(
      dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 PLAC ----
0 TRLR
`),
      inferMainProfile(dataset(MAIN_PLAIN)),
      undefined,
      { dates: true, places: false, links: true, names: true, vendorTags: true },
    );
    expect(out.individuals.get("@I1@")!.events[0].place?.raw).toBe("----");
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

  it("re-renders an expanded 2-digit year in the main's full-year style", () => {
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
    // Endpoints in a numeric source are reformatted to the main style too.
    expect(formatGedDate(parseDate("FROM 05.01.1900 TO 03.03.1905", "DMY"), profile)).toBe(
      "FROM 5 Jan 1900 TO 3 Mar 1905",
    );
  });

  it("supports BET…AND ranges", () => {
    expect(formatGedDate(parseDate("BET 1900 AND 1905"), profile)).toBe(
      "BET 1900 AND 1905",
    );
  });

  it("preserves loose dash/slash year ranges as written", () => {
    expect(formatGedDate(parseDate("1830-1850"), profile)).toBe("1830-1850");
    expect(formatGedDate(parseDate("1785 - 1810"), profile)).toBe("1785 - 1810");
    expect(formatGedDate(parseDate("1770/1785"), profile)).toBe("1770/1785");
  });
});

describe("normalizeDataset (numeric conversion)", () => {
  const numericMain = (dates: string[]) => `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
${dates.map((d) => `1 EVEN\n2 DATE ${d}`).join("\n")}
0 TRLR
`;

  it("converts month-word compare dates to the main's DD.MM.YYYY", () => {
    const profile = inferMainProfile(dataset(numericMain(["20.02.1989", "01.05.1990"])));
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

  it("converts the main's example (D Mmm YYYY) from a numeric compare file", () => {
    // Main like Renko-Rakar-Jekovec-Pezdirc.ged: "20 Feb 1989".
    const profile = inferMainProfile(dataset(numericMain(["20 Feb 1989", "1 May 1990"])));
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
    // Main is month-word; compare is unambiguously MDY (a 02/20 proves it).
    const profile = inferMainProfile(dataset(numericMain(["20 Feb 1989"])));
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

describe("normalizeDataset (unknown-name placeholders)", () => {
  // A main that leaves unknown name parts blank (Marija has no surname slot).
  const blankMain = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Marija //
0 @I2@ INDI
1 NAME Janez /Novak/
0 TRLR
`);

  // A main that marks unknown surnames with the literal token "NN".
  const nnMain = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Marija /NN/
0 @I2@ INDI
1 NAME Ana /NN/
0 @I3@ INDI
1 NAME Janez /Novak/
0 TRLR
`);

  it("strips placeholder surnames when the main leaves unknown parts blank", () => {
    const compare = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Jožef /____/
2 GIVN Jožef
2 SURN ____
0 TRLR
`);
    const { dataset: out, report } = normalizeDataset(compare, inferMainProfile(blankMain));
    const indi = out.individuals.get("@I1@")!;
    const nameNode = indi.raw.children.find((c) => c.tag === "NAME")!;
    expect(indi.names[0].surname).toBeUndefined();
    expect(indi.names[0].given).toBe("Jožef");
    // The empty surname slot is preserved, but the placeholder text is gone.
    expect(nameNode.value).toBe("Jožef //");
    expect(nameNode.children.some((c) => c.tag === "SURN")).toBe(false);
    expect(report.unknownNamesReshaped).toBe(1);
    expect(report.unknownNameExamples[0]).toEqual({ before: "____", after: "(blank)" });
  });

  it("rewrites placeholders to the main's token when it uses one", () => {
    const compare = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Jožef /????/
0 TRLR
`);
    const { dataset: out, report } = normalizeDataset(compare, inferMainProfile(nnMain));
    expect(out.individuals.get("@I1@")!.names[0].surname).toBe("NN");
    expect(report.unknownNamesReshaped).toBe(1);
  });

  it("cleans an unknown given name too", () => {
    const compare = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME ??? /Novak/
0 TRLR
`);
    const { dataset: out } = normalizeDataset(compare, inferMainProfile(blankMain));
    const indi = out.individuals.get("@I1@")!;
    const name = indi.names[0];
    expect(name.given).toBeUndefined();
    expect(name.surname).toBe("Novak");
    expect(indi.raw.children.find((c) => c.tag === "NAME")!.value).toBe("/Novak/");
  });

  it("leaves a real one-letter initial untouched", () => {
    const compare = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME N /Novak/
0 TRLR
`);
    const { dataset: out, report } = normalizeDataset(compare, inferMainProfile(blankMain));
    expect(out.individuals.get("@I1@")!.names[0].given).toBe("N");
    expect(report.unknownNamesReshaped).toBe(0);
  });

  it("strips a placeholder SURN sub-tag shadowed by a real slash surname", () => {
    // The displayed surname is real, but a stale placeholder lingers in SURN.
    const compare = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Jožef /Novak/
2 SURN ____
0 TRLR
`);
    const { dataset: out, report } = normalizeDataset(compare, inferMainProfile(blankMain));
    const nameNode = out.individuals.get("@I1@")!.raw.children.find((c) => c.tag === "NAME")!;
    expect(nameNode.value).toBe("Jožef /Novak/");
    expect(nameNode.children.some((c) => c.tag === "SURN")).toBe(false);
    expect(report.unknownNamesReshaped).toBe(1);
  });

  it("cleans a placeholder surname carried only in a SURN sub-tag (no slash)", () => {
    const compare = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Jožef
2 GIVN Jožef
2 SURN NN
0 TRLR
`);
    const { dataset: out, report } = normalizeDataset(compare, inferMainProfile(blankMain));
    const indi = out.individuals.get("@I1@")!;
    expect(indi.names[0].given).toBe("Jožef");
    expect(indi.names[0].surname).toBeUndefined();
    expect(indi.raw.children.find((c) => c.tag === "NAME")!.children.some((c) => c.tag === "SURN")).toBe(false);
    expect(report.unknownNamesReshaped).toBe(1);
  });

  it("counts a redundant value+SURN placeholder pair once", () => {
    const compare = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Jožef /NN/
2 SURN NN
0 TRLR
`);
    const { dataset: out, report } = normalizeDataset(compare, inferMainProfile(blankMain));
    const nameNode = out.individuals.get("@I1@")!.raw.children.find((c) => c.tag === "NAME")!;
    expect(nameNode.value).toBe("Jožef //");
    expect(nameNode.children.some((c) => c.tag === "SURN")).toBe(false);
    expect(report.unknownNamesReshaped).toBe(1);
  });

  it("rewrites a placeholder SURN sub-tag to the main's token", () => {
    const compare = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Jožef /____/
2 SURN ____
0 TRLR
`);
    const { dataset: out } = normalizeDataset(compare, inferMainProfile(nnMain));
    const nameNode = out.individuals.get("@I1@")!.raw.children.find((c) => c.tag === "NAME")!;
    expect(nameNode.value).toBe("Jožef /NN/");
    expect(nameNode.children.find((c) => c.tag === "SURN")!.value).toBe("NN");
  });

  it("detects the main's NN token convention", () => {
    expect(inferMainProfile(nnMain).unknownName).toEqual({ form: "token", token: "NN" });
    expect(inferMainProfile(blankMain).unknownName).toEqual({ form: "blank" });
  });

  it("keeps the NN convention despite many half-known names", () => {
    // Ordinary incomplete data (known surname, blank given) is not blank-convention
    // evidence: it must not drown out the explicit NN token.
    const halfKnown = Array.from({ length: 20 }, (_, i) =>
      `0 @H${i}@ INDI\n1 NAME /Novak${i}/`,
    ).join("\n");
    const main = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Marija /NN/
0 @I2@ INDI
1 NAME Ana /NN/
${halfKnown}
0 TRLR
`);
    expect(inferMainProfile(main).unknownName).toEqual({ form: "token", token: "NN" });
  });

  it("uses the blank convention when fully-blank names outnumber tokens", () => {
    const main = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME //
0 @I2@ INDI
1 NAME //
0 @I3@ INDI
1 NAME Janez /NN/
0 TRLR
`);
    expect(inferMainProfile(main).unknownName).toEqual({ form: "blank" });
  });
});

describe("place FORM vocabulary", () => {
  // Three shapes the file labels itself: a Slovenian three-part place, a
  // German one (same depth, different word for the middle level) and a
  // two-part place. The wording is per country, so it can only be reused for
  // the country it was learned from.
  const labelled = `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 PLAC Zabukovje,Sevnica,Slovenija
3 FORM Place,Upravna Enota,Country
1 DEAT
2 PLAC Mainz,Rheinland-Pfalz,Nemčija
3 FORM Place,Bundesland,Country
0 @I2@ INDI
1 BIRT
2 PLAC Zagreb,Hrvaška
3 FORM Place,Country
0 TRLR`;

  it("learns each country's own wording, per depth", () => {
    const fmt = inferPlaceExportFormat(dataset(labelled));
    expect(placeFormFor(fmt, "Bled,Radovljica,Slovenija", "Slovenija")).toBe("Place,Upravna Enota,Country");
    expect(placeFormFor(fmt, "Trier,Rheinland-Pfalz,Nemčija", "Nemčija")).toBe("Place,Bundesland,Country");
    expect(placeFormFor(fmt, "Split,Hrvaška", "Hrvaška")).toBe("Place,Country");
  });

  it("does not carry one country's wording over to another", () => {
    const fmt = inferPlaceExportFormat(dataset(labelled));
    // Three-part places exist in two countries and are worded differently, so
    // there is nothing to say about a third country's three-part place.
    expect(placeFormFor(fmt, "Trst,Furlanija,Italija", "Italija")).toBeUndefined();
  });

  it("reuses a wording the file applies to every country alike", () => {
    const uniform = `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 PLAC Zabukovje,Sevnica,Slovenija
3 FORM Place,Municipality,Country
1 DEAT
2 PLAC Mainz,Rheinland-Pfalz,Nemčija
3 FORM Place,Municipality,Country
0 TRLR`;
    const fmt = inferPlaceExportFormat(dataset(uniform));
    expect(placeFormFor(fmt, "Trst,Furlanija,Italija", "Italija")).toBe("Place,Municipality,Country");
  });

  it("ignores a FORM that doesn't label the place it sits on", () => {
    const mismatched = `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 PLAC Slovenija,Slovenija
3 FORM Place,Upravna Enota,Country
0 TRLR`;
    const fmt = inferPlaceExportFormat(dataset(mismatched));
    expect(fmt.forms).toBeUndefined();
  });

  it("says nothing about a file that writes no FORM", () => {
    const plain = `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 PLAC Zabukovje,Sevnica,Slovenija
0 TRLR`;
    const fmt = inferPlaceExportFormat(dataset(plain));
    expect(fmt.forms).toBeUndefined();
    expect(placeFormFor(fmt, "Bled,Radovljica,Slovenija", "Slovenija")).toBeUndefined();
  });
});
