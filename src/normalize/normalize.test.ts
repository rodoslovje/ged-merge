import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { detectPlaceLayout, inferDateProfile, inferMasterProfile, inferNameLayout } from "./profile";
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
  const marnmMaster = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Marija /Kovač/
2 _MARNM Maček
0 TRLR
`);
  const recordMaster = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Marija /Težak/
1 NAME /Simonič/
2 TYPE married
0 TRLR
`);

  it("converts a separate TYPE married record into inline _MARNM when the master uses _MARNM", () => {
    const compare = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ana /Novak/
1 NAME /Kovač/
2 TYPE married
0 TRLR
`);
    const { dataset: out, report } = normalizeDataset(compare, inferMasterProfile(marnmMaster));
    const name = out.individuals.get("@I1@")!.names;
    expect(name).toHaveLength(1);
    expect(name[0].married).toBe("Kovač");
    expect(report.nameVariantsReshaped).toBe(1);
    expect(report.nameVariantExamples).toHaveLength(1);
  });

  it("converts inline _MARNM into a separate TYPE married record when the master uses records", () => {
    const compare = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ana /Novak/
2 _MARNM Kovač
0 TRLR
`);
    const { dataset: out, report } = normalizeDataset(compare, inferMasterProfile(recordMaster));
    const names = out.individuals.get("@I1@")!.names;
    expect(names).toHaveLength(2);
    expect(names[0].married).toBeUndefined();
    expect(names[1].type).toBe("married");
    expect(names[1].surname).toBe("Kovač");
    expect(report.nameVariantsReshaped).toBe(1);
  });

  it("leaves married names untouched when the master records none", () => {
    const noneMaster = dataset(`0 HEAD
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
    const { dataset: out, report } = normalizeDataset(compare, inferMasterProfile(noneMaster));
    expect(out.individuals.get("@I1@")!.names[0].married).toBe("Kovač");
    expect(report.nameVariantsReshaped).toBe(0);
  });
});

describe("normalizeDataset (name-variant reshaping)", () => {
  // Master uses separate, lowercase TYPE records for every variant.
  const recordMaster = dataset(`0 HEAD
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
  // Master uses inline custom tags.
  const tagMaster = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Marija /Kovač/
2 _MARNM Maček
2 _BIRN Zelzer
2 _AKA Mojca
0 TRLR
`);

  it("folds inline _BIRN into a TYPE birth record when the master uses records", () => {
    const compare = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Franc /Celcer/
2 _BIRN Zelzer
0 TRLR
`);
    const { dataset: out } = normalizeDataset(compare, inferMasterProfile(recordMaster));
    const names = out.individuals.get("@I1@")!.names;
    expect(names).toHaveLength(2);
    expect(names[1].type).toBe("birth");
    expect(names[1].surname).toBe("Zelzer");
  });

  it("folds a TYPE birth record into inline _BIRN when the master uses tags", () => {
    const compare = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Franc /Celcer/
1 NAME Franc /Zelzer/
2 TYPE birth
0 TRLR
`);
    const { dataset: out } = normalizeDataset(compare, inferMasterProfile(tagMaster));
    const indi = out.individuals.get("@I1@")!;
    expect(indi.names).toHaveLength(1);
    expect(indi.raw.children.find((c) => c.tag === "NAME")!.children.some((c) => c.tag === "_BIRN" && c.value === "Zelzer")).toBe(true);
  });

  it("renames a sibling AKA tag (_AKAN) to the master's preferred tag (_AKA)", () => {
    const compare = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Davor /Gregorc/
2 _AKAN Cic
0 TRLR
`);
    const { dataset: out, report } = normalizeDataset(compare, inferMasterProfile(tagMaster));
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
    const { dataset: out } = normalizeDataset(compare, inferMasterProfile(tagMaster));
    const names = out.individuals.get("@I1@")!.names;
    expect(names).toHaveLength(2);
    expect(names[1].type).toBe("aka");
  });

  it("recases and unifies TYPE tokens to the master's spelling (MARRIED→married, maiden→birth)", () => {
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
    const { dataset: out, report } = normalizeDataset(compare, inferMasterProfile(recordMaster));
    const names = out.individuals.get("@I1@")!.names;
    expect(names[1].type).toBe("married");
    expect(names[2].type).toBe("birth");
    expect(report.nameVariantsReshaped).toBe(2);
  });

  it("converts a NICK sub-tag into a TYPE nick record when the master uses records", () => {
    const compare = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Marija /Kovač/
2 NICK Mimi
0 TRLR
`);
    const { dataset: out } = normalizeDataset(compare, inferMasterProfile(recordMaster));
    const names = out.individuals.get("@I1@")!.names;
    expect(names[0].nickname).toBeUndefined();
    expect(names.some((n) => n.type === "nick" && n.given === "Mimi")).toBe(true);
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
  // elsewhere, plus a street tying Stražišče to "Hafnarjeva pot" — so an
  // incoming place naming only "Kranj" can be completed and, where the street
  // says more, sharpened. (A parish is not a sharpening hint — it spans villages.)
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

  it("does not relocate an already-specific locality whose ADDR just echoes it before a house number", () => {
    // Master ties the *street* "Zgornje Bitnje" to the hamlet "Stražišče" (people
    // on that road were filed under Stražišče). An incoming record already named
    // "Zgornje Bitnje" with ADDR "Zgornje Bitnje 165" must stay put — the ADDR is
    // "locality + house number", not a disambiguating street.
    let g = `0 HEAD\n1 CHAR UTF-8\n`;
    for (let i = 1; i <= 8; i++)
      g += `0 @S${i}@ INDI\n1 BIRT\n2 PLAC Stražišče,Kranj,Slovenia\n2 ADDR Zgornje Bitnje ${i}\n`;
    g += `0 TRLR\n`;
    const master = dataset(g);
    const compare = dataset(
      `0 HEAD\n1 CHAR UTF-8\n0 @P1@ INDI\n1 BIRT\n` +
      `2 PLAC Zgornje Bitnje,Kranj,Slovenia\n2 ADDR Zgornje Bitnje 165\n0 TRLR\n`,
    );
    const { dataset: out } = normalizeDataset(compare, inferMasterProfile(master));
    const birt = out.individuals.get("@P1@")!.events.find((e) => e.tag === "BIRT")!;
    expect(birt.place?.raw).toBe("Zgornje Bitnje,Kranj,Slovenia");
    expect(birt.address?.raw).toBe("Zgornje Bitnje 165");
  });

  it("keeps a 'po domače' house name once when a dangling dash precedes it in the ADDR", () => {
    const master = dataset(
      `0 HEAD\n1 CHAR UTF-8\n` +
      `0 @I1@ INDI\n1 BIRT\n2 PLAC Zgornje Bitnje,Kranj,Slovenia\n2 ADDR Zgornje Bitnje 7\n0 TRLR\n`,
    );
    const compare = dataset(
      `0 HEAD\n1 CHAR UTF-8\n0 @P1@ INDI\n1 BIRT\n` +
      `2 PLAC Zgornje Bitnje,Kranj,Slovenia\n2 ADDR Zgornje Bitnje 42 - (pd V dolini)\n0 TRLR\n`,
    );
    const { dataset: out } = normalizeDataset(compare, inferMasterProfile(master));
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

  it("preserves loose dash/slash year ranges as written", () => {
    expect(formatGedDate(parseDate("1830-1850"), profile)).toBe("1830-1850");
    expect(formatGedDate(parseDate("1785 - 1810"), profile)).toBe("1785 - 1810");
    expect(formatGedDate(parseDate("1770/1785"), profile)).toBe("1770/1785");
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

describe("normalizeDataset (unknown-name placeholders)", () => {
  // A master that leaves unknown name parts blank (Marija has no surname slot).
  const blankMaster = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Marija //
0 @I2@ INDI
1 NAME Janez /Novak/
0 TRLR
`);

  // A master that marks unknown surnames with the literal token "NN".
  const nnMaster = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Marija /NN/
0 @I2@ INDI
1 NAME Ana /NN/
0 @I3@ INDI
1 NAME Janez /Novak/
0 TRLR
`);

  it("strips placeholder surnames when the master leaves unknown parts blank", () => {
    const compare = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Jožef /____/
2 GIVN Jožef
2 SURN ____
0 TRLR
`);
    const { dataset: out, report } = normalizeDataset(compare, inferMasterProfile(blankMaster));
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

  it("rewrites placeholders to the master's token when it uses one", () => {
    const compare = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Jožef /????/
0 TRLR
`);
    const { dataset: out, report } = normalizeDataset(compare, inferMasterProfile(nnMaster));
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
    const { dataset: out } = normalizeDataset(compare, inferMasterProfile(blankMaster));
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
    const { dataset: out, report } = normalizeDataset(compare, inferMasterProfile(blankMaster));
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
    const { dataset: out, report } = normalizeDataset(compare, inferMasterProfile(blankMaster));
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
    const { dataset: out, report } = normalizeDataset(compare, inferMasterProfile(blankMaster));
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
    const { dataset: out, report } = normalizeDataset(compare, inferMasterProfile(blankMaster));
    const nameNode = out.individuals.get("@I1@")!.raw.children.find((c) => c.tag === "NAME")!;
    expect(nameNode.value).toBe("Jožef //");
    expect(nameNode.children.some((c) => c.tag === "SURN")).toBe(false);
    expect(report.unknownNamesReshaped).toBe(1);
  });

  it("rewrites a placeholder SURN sub-tag to the master's token", () => {
    const compare = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Jožef /____/
2 SURN ____
0 TRLR
`);
    const { dataset: out } = normalizeDataset(compare, inferMasterProfile(nnMaster));
    const nameNode = out.individuals.get("@I1@")!.raw.children.find((c) => c.tag === "NAME")!;
    expect(nameNode.value).toBe("Jožef /NN/");
    expect(nameNode.children.find((c) => c.tag === "SURN")!.value).toBe("NN");
  });

  it("detects the master's NN token convention", () => {
    expect(inferMasterProfile(nnMaster).unknownName).toEqual({ form: "token", token: "NN" });
    expect(inferMasterProfile(blankMaster).unknownName).toEqual({ form: "blank" });
  });
});
