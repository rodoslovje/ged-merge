import { describe, expect, it } from "vitest";
import { parseGedcom } from "../gedcom/parser";
import { buildDataset } from "../gedcom/builder";
import { buildGazetteerIndex, GURS_REGISTER, type GazEntry } from "../geo/gazetteer";
import type { GeocodeDecision } from "../persist/geoDb";
import type { PlaceTargetFormat } from "../normalize/types";
import { checkPlacesAgainstRegister, registerDecisionKey, REGISTER_DISMISSED } from "./registerCheck";

function buildFromText(text: string) {
  const buf = new TextEncoder().encode(text);
  return buildDataset(parseGedcom(buf.buffer));
}

/** A register settlement — what the GURS import produces. */
function si(name: string, admin: string, lat: number, lon: number, alt: string[] = []): GazEntry {
  return {
    name,
    ascii: "",
    alt,
    lat,
    lon,
    fclass: "P",
    country: "SI",
    admin1: "",
    admin,
    population: 0,
    register: GURS_REGISTER,
  };
}

const REGISTER = buildGazetteerIndex([
  si("Ljubljana", "Ljubljana", 46.05108, 14.50513),
  si("Kranj", "Kranj", 46.23887, 14.35561),
  si("Šentjur", "Šentjur", 46.2167, 15.3969),
  si("Koper", "Koper", 45.5481, 13.7302, ["Capodistria"]),
  si("Vrh", "Šmartno pri Litiji", 46.0, 14.85),
  si("Litija", "Litija", 46.0587, 14.8306),
  // Two settlements of one name, far apart — the ambiguity a coordinate settles.
  si("Soteska", "Kamnik", 46.28, 14.62),
  si("Soteska", "Dolenjske Toplice", 45.78, 15.02),
]);

/** A Croatian register settlement: its općina as `admin`, the code of the
 *  županija above it as `admin1` — the shape the DGU import produces. */
function hr(name: string, admin: string, admin1: string, lat: number, lon: number): GazEntry {
  return {
    name,
    ascii: "",
    alt: [],
    lat,
    lon,
    fclass: "P",
    country: "HR",
    admin1,
    admin,
    population: 0,
    register: "HR-DGU",
  };
}

/** The county name lists the DGU import stores beside its places: the official
 *  name, the bare adjective, then the English forms a file may well write. */
const HR_REGISTER = buildGazetteerIndex(
  [
    hr("Bektež", "Kutjevo", "11", 45.42, 17.88),
    hr("Španovica", "Pakrac", "11", 45.42, 17.2),
    hr("Stipernica", "Pregrada", "02", 46.16, 15.75),
    hr("Sinac", "Otočac", "09", 44.85, 15.25),
  ],
  new Map([
    ["HR:11", ["Požeško-slavonska županija", "Požeško-slavonska", "Požega-Slavonia", "Požega-Slavonia County"]],
    ["HR:02", ["Krapinsko-zagorska županija", "Krapinsko-zagorska", "Krapina-Zagorje", "Krapina-Zagorje County"]],
    ["HR:09", ["Ličko-senjska županija", "Ličko-senjska", "Lika-Senj", "Lika-Senj County"]],
    // A county with no settlement of the fixture in it — the register knows its
    // name all the same, which is the whole point of the `region` verdict.
    ["HR:20", ["Međimurska županija", "Međimurska", "Međimurje", "Međimurje County"]],
  ]),
);

function place(value: string, map?: string) {
  return `1 BIRT\n2 PLAC ${value}${map ? `\n3 MAP\n${map}` : ""}`;
}

function fileWith(...places: string[]) {
  const records = places
    .map((p, i) => `0 @I${i + 1}@ INDI\n1 NAME Test /Oseba/\n${p}`)
    .join("\n");
  return buildFromText(`0 HEAD\n1 GEDC\n2 VERS 5.5.1\n${records}\n0 TRLR\n`);
}

const NO_DECISIONS = new Map<string, GeocodeDecision>();

describe("checkPlacesAgainstRegister", () => {
  it("passes a place the register writes the same way", () => {
    const ds = fileWith(place("Ljubljana, Slovenija"), place("Kranj, Slovenija"));
    const report = checkPlacesAgainstRegister(ds, REGISTER, NO_DECISIONS);
    expect(report.findings).toEqual([]);
    expect(report.checked).toBe(2);
    expect(report.ok).toBe(2);
    expect(report.registers).toEqual([GURS_REGISTER]);
  });

  it("reports a name the register spells differently, with the value to write", () => {
    const ds = fileWith(place("Sentjur, Slovenija"));
    const { findings } = checkPlacesAgainstRegister(ds, REGISTER, NO_DECISIONS);
    expect(findings).toHaveLength(1);
    expect(findings[0].verdict).toBe("spelling");
    expect(findings[0].written).toBe("Sentjur");
    expect(findings[0].entry?.name).toBe("Šentjur");
    expect(findings[0].official).toBe("Šentjur, Slovenija");
  });

  it("accepts an official bilingual name as written", () => {
    const ds = fileWith(place("Capodistria, Slovenija"));
    const report = checkPlacesAgainstRegister(ds, REGISTER, NO_DECISIONS);
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(1);
  });

  it("reports a place the register does not know — but only when the country says where to look", () => {
    const ds = fileWith(place("Neznani Kraj XY, Slovenija"), place("Neznani Kraj ZZ"));
    const { findings, checked, skipped } = checkPlacesAgainstRegister(ds, REGISTER, NO_DECISIONS);
    expect(findings.map((f) => f.key)).toEqual(["Neznani Kraj XY, Slovenija"]);
    expect(findings[0].verdict).toBe("notFound");
    expect(checked).toBe(1);
    // The countryless one is unjudgeable, not compliant and not a finding.
    expect(skipped).toBe(1);
  });

  it("leaves places in countries with no register loaded out of scope", () => {
    const ds = fileWith(place("Wien, Avstrija"), place("Graz, Österreich"));
    const report = checkPlacesAgainstRegister(ds, REGISTER, NO_DECISIONS);
    expect(report.findings).toEqual([]);
    expect(report.checked).toBe(0);
    expect(report.skipped).toBe(2);
  });

  it("judges a place naming no country once the file's home country is known", () => {
    // The same two values the cautious reading leaves unjudged: with a home
    // country they are Slovenian places, and the register can say whether it
    // knows them.
    const ds = fileWith(place("Neznani Kraj ZZ"), place("Vrh"));
    const cautious = checkPlacesAgainstRegister(ds, REGISTER, NO_DECISIONS);
    // Only the one the register happens to match is judged at all; the name it
    // does not know goes unmentioned, since it might be anywhere.
    expect(cautious.checked).toBe(1);
    expect(cautious.skipped).toBe(1);
    const withHome = checkPlacesAgainstRegister(ds, REGISTER, NO_DECISIONS, undefined, "si");
    expect(withHome.checked).toBe(2);
    expect(withHome.skipped).toBe(0);
    expect(withHome.findings.map((f) => f.key)).toEqual(["Neznani Kraj ZZ"]);
    expect(withHome.findings[0].verdict).toBe("notFound");
  });

  it("leaves a place naming no country out where no register covers the home country", () => {
    // Assuming a country we hold nothing for changes nothing: out of scope is
    // out of scope, and a Slovenian register may not answer for Austria.
    const ds = fileWith(place("Neznani Kraj ZZ"));
    const report = checkPlacesAgainstRegister(ds, REGISTER, NO_DECISIONS, undefined, "at");
    expect(report.checked).toBe(0);
    expect(report.skipped).toBe(1);
  });

  it("holds a country to its own registers however the file names it", () => {
    // "Črna gora" is Montenegro to everyone but a table of English names, and a
    // place there was being answered by the Slovenian and Croatian registers —
    // Podgorica proposed as a hamlet under Dobrepolje.
    const ds = fileWith(place("Podgorica, Črna gora"), place("Cetinje, Crna Gora"));
    const report = checkPlacesAgainstRegister(ds, REGISTER, NO_DECISIONS);
    expect(report.findings).toEqual([]);
    expect(report.checked).toBe(0);
    expect(report.skipped).toBe(2);
  });

  it("reports a municipality the register does not file the place under", () => {
    const ds = fileWith(place("Vrh, Litija, Slovenija"));
    const { findings } = checkPlacesAgainstRegister(ds, REGISTER, NO_DECISIONS);
    expect(findings).toHaveLength(1);
    expect(findings[0].verdict).toBe("admin");
    expect(findings[0].writtenAdmin).toBe("Litija");
    expect(findings[0].entry?.admin).toBe("Šmartno pri Litiji");
  });

  it("passes a place whose municipality the register agrees with", () => {
    const ds = fileWith(place("Vrh, Šmartno pri Litiji, Slovenija"));
    expect(checkPlacesAgainstRegister(ds, REGISTER, NO_DECISIONS).findings).toEqual([]);
  });

  it("reports a name that fits several register entries, and stops when a coordinate settles it", () => {
    const undecided = fileWith(place("Soteska, Slovenija"));
    const { findings } = checkPlacesAgainstRegister(undecided, REGISTER, NO_DECISIONS);
    expect(findings).toHaveLength(1);
    expect(findings[0].verdict).toBe("ambiguous");
    expect(findings[0].alternatives?.map((e) => e.admin)).toEqual(["Kamnik", "Dolenjske Toplice"]);

    const placed = fileWith(place("Soteska, Slovenija", "4 LATI N45.78\n4 LONG E15.02"));
    expect(checkPlacesAgainstRegister(placed, REGISTER, NO_DECISIONS).findings).toEqual([]);
  });

  it("offers every country's answer for a name that names no country of its own", () => {
    // "Bela" is a place in Slovenia and one in Croatia; the row's whole point is
    // that both are still open, so both are listed.
    const index = buildGazetteerIndex([
      si("Bela", "Ajdovščina", 45.85, 14.03),
      { ...si("Bela", "Novi Marof", 46.2, 16.25), country: "HR", register: "HR-DGU" },
    ]);
    const { findings } = checkPlacesAgainstRegister(fileWith(place("Bela")), index, NO_DECISIONS);
    expect(findings).toHaveLength(1);
    expect(findings[0].verdict).toBe("ambiguous");
    expect(findings[0].alternatives?.map((e) => e.country).sort()).toEqual(["HR", "SI"]);
  });

  it("reports a coordinate nowhere near the register's position", () => {
    const ds = fileWith(place("Kranj, Slovenija", "4 LATI N45.50\n4 LONG E15.50"));
    const { findings } = checkPlacesAgainstRegister(ds, REGISTER, NO_DECISIONS);
    expect(findings).toHaveLength(1);
    expect(findings[0].verdict).toBe("far");
    expect(Math.round(findings[0].distanceKm!)).toBeGreaterThan(50);
  });

  it("keeps a coordinate within the settlement's reach", () => {
    const ds = fileWith(place("Kranj, Slovenija", "4 LATI N46.25\n4 LONG E14.36"));
    expect(checkPlacesAgainstRegister(ds, REGISTER, NO_DECISIONS).findings).toEqual([]);
  });

  it("marks a dismissed finding instead of dropping it, and reads the geocode no-match mark for a missing place", () => {
    const ds = fileWith(place("Sentjur, Slovenija"), place("Neznani Kraj XY, Slovenija"));
    const decisions = new Map<string, GeocodeDecision>([
      [registerDecisionKey("Sentjur, Slovenija"), { key: registerDecisionKey("Sentjur, Slovenija"), status: REGISTER_DISMISSED, ts: 0 }],
      ["Neznani Kraj XY, Slovenija", { key: "Neznani Kraj XY, Slovenija", status: "nomatch", ts: 0 }],
    ]);
    const { findings } = checkPlacesAgainstRegister(ds, REGISTER, decisions);
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.dismissed)).toBe(true);
  });

  it("counts every occurrence of a value and returns nothing with no directory at all", () => {
    const ds = fileWith(place("Sentjur, Slovenija"), place("Sentjur, Slovenija"));
    expect(checkPlacesAgainstRegister(ds, REGISTER, NO_DECISIONS).findings[0].count).toBe(2);
    expect(checkPlacesAgainstRegister(ds, undefined, NO_DECISIONS).findings).toEqual([]);
  });

  it("answers from any loaded directory, not the official registers alone", () => {
    // An OpenStreetMap download for a country no register covers: it puts that
    // country in scope and answers for it, under its own directory name.
    const osm = buildGazetteerIndex([
      { ...si("Wien", "Wien", 48.2083, 16.3731), country: "AT", register: undefined, source: "AT-OSM" },
    ]);
    const ds = fileWith(place("wien, Avstrija"), place("Nikjer, Avstrija"));
    const report = checkPlacesAgainstRegister(ds, osm, NO_DECISIONS);
    expect(report.registers).toEqual(["AT-OSM"]);
    expect(report.checked).toBe(2);
    expect(report.findings.map((f) => f.verdict)).toEqual(["notFound", "spelling"]);
    expect(report.findings[1].entry?.name).toBe("Wien");
  });

  it("says nothing about a value that names only a country", () => {
    // "Slovenia, Slovenia" is an event known by its country alone; a register of
    // settlements has no answer for it, and matching the country name against
    // settlement names is how it came to be reported as misspelling "Šlovrenc".
    const ds = fileWith(place("Slovenia, Slovenia"), place("Slovenija"));
    const report = checkPlacesAgainstRegister(ds, REGISTER, NO_DECISIONS);
    expect(report.findings).toEqual([]);
    expect(report.checked).toBe(0);
    expect(report.skipped).toBe(2);
  });

  it("never claims a merely similar name is the place misspelt", () => {
    // Šlovrenc is close enough for the geocode list to offer as a coordinate,
    // but the register does not hold this name and must not be said to spell it.
    const ds = fileWith(place("Šlovrenj, Slovenija"));
    const { findings } = checkPlacesAgainstRegister(ds, REGISTER, NO_DECISIONS);
    expect(findings).toHaveLength(1);
    expect(findings[0].verdict).toBe("notFound");
    expect(findings[0].entry).toBeUndefined();
    expect(findings[0].official).toBeUndefined();
  });

  it("proposes the file's own place with the register's municipality in it", () => {
    const ds = fileWith(place("Vrh, Litija, Slovenija"));
    const { findings } = checkPlacesAgainstRegister(ds, REGISTER, NO_DECISIONS);
    expect(findings[0].official).toBe("Vrh, Šmartno pri Litiji, Slovenija");
  });

  it("names a county written as a place for what it is, and offers it a level shorter", () => {
    // "Međimurje, Međimurje, Croatia" is the county twice over: no register of
    // settlements can ever match it, and the second level says nothing.
    const ds = fileWith(place("Međimurje, Međimurje, Croatia"));
    const { findings } = checkPlacesAgainstRegister(ds, HR_REGISTER, NO_DECISIONS);
    expect(findings).toHaveLength(1);
    expect(findings[0].verdict).toBe("region");
    expect(findings[0].official).toBe("Međimurje, Croatia");
  });

  it("reads the county under any of its names, the file's own included", () => {
    const ds = fileWith(place("Krapina-Zagorje, Krapinsko-zagorska županija, Croatia"));
    const { findings } = checkPlacesAgainstRegister(ds, HR_REGISTER, NO_DECISIONS);
    expect(findings[0].verdict).toBe("region");
    // Two spellings of one county, so the second level is still a repetition.
    expect(findings[0].official).toBe("Krapina-Zagorje, Croatia");
  });

  it("offers to drop a level left blank, even where the name is simply unknown", () => {
    // Slavonia is a historical region spanning several counties — no register
    // lists it, so the verdict stands — but the empty level is still a comma
    // to lose.
    const ds = fileWith(place("Slavonia, , Croatia"));
    const { findings } = checkPlacesAgainstRegister(ds, HR_REGISTER, NO_DECISIONS);
    expect(findings[0].verdict).toBe("notFound");
    expect(findings[0].official).toBe("Slavonia, Croatia");
  });

  it("leaves a two-level place alone: there is no level to drop", () => {
    const ds = fileWith(place("Međimurje, Croatia"));
    const { findings } = checkPlacesAgainstRegister(ds, HR_REGISTER, NO_DECISIONS);
    expect(findings[0].verdict).toBe("region");
    expect(findings[0].official).toBeUndefined();
  });

  it("holds a place written at county level against counties, not municipalities", () => {
    // A file that writes "settlement, županija, Croatia" throughout used to get
    // one finding per place: the county was read as a municipality (every
    // Croatian county contains the name of the town it is named after) and then
    // held against the općina the register files the settlement under. The bulk
    // rename would have written the općina over the county in every one.
    const ds = fileWith(place("Bektež, Požega-Slavonia, Croatia"), place("Stipernica, Krapina-Zagorje, Croatia"));
    const report = checkPlacesAgainstRegister(ds, HR_REGISTER, NO_DECISIONS);
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(2);
  });

  it("reports a county the register files the place under a different one of", () => {
    const ds = fileWith(place("Sinac, Krapina-Zagorje, Croatia"));
    const { findings } = checkPlacesAgainstRegister(ds, HR_REGISTER, NO_DECISIONS);
    expect(findings).toHaveLength(1);
    expect(findings[0].verdict).toBe("admin");
    expect(findings[0].writtenAdmin).toBe("Krapina-Zagorje");
    // Corrected to the county, in the wording this file writes counties in —
    // not to the općina, which would be the wrong level for this file.
    expect(findings[0].official).toBe("Sinac, Lika-Senj, Croatia");
  });

  it("still holds a place written at municipality level against municipalities", () => {
    const ds = fileWith(place("Bektež, Pakrac, Croatia"));
    const { findings } = checkPlacesAgainstRegister(ds, HR_REGISTER, NO_DECISIONS);
    expect(findings).toHaveLength(1);
    expect(findings[0].verdict).toBe("admin");
    expect(findings[0].official).toBe("Bektež, Kutjevo, Croatia");
  });

  it("does not read one name as another it merely contains", () => {
    // "Kranj" is not "Kranjska Gora", and "Požega" is not "Požega-Slavonia".
    const ds = fileWith(place("Vrh, Šmartno, Slovenija"));
    const { findings } = checkPlacesAgainstRegister(ds, REGISTER, NO_DECISIONS);
    // "Šmartno" alone is no municipality the register knows, so it says nothing
    // about where the place is filed and the row is passed over — rather than
    // being taken for "Šmartno pri Litiji" on a shared stem.
    expect(findings).toEqual([]);
  });

  it("reads a unit word as the kind of unit, not part of its name", () => {
    const index = buildGazetteerIndex([{ ...si("Vrh", "Zagrebačka", 45.8, 16.0), country: "HR", register: "HR-DGU" }]);
    const ds = fileWith(place("Vrh, Zagrebačka županija, Croatia"));
    expect(checkPlacesAgainstRegister(ds, index, NO_DECISIONS).findings).toEqual([]);
  });

  it("reports what the file's own FORM calls the levels of its places", () => {
    const ds = fileWith(place("Vrh, Litija, Slovenija"));
    const fmt: PlaceTargetFormat = {
      layout: "plain-structured",
      separator: ", ",
      // Keyed by the country's canonical token and the part count, the way
      // inferPlaceExportFormat learns it from the file's own places.
      forms: new Map([["slovenia|3", "Kraj, Občina, Država"]]),
    };
    const report = checkPlacesAgainstRegister(ds, REGISTER, NO_DECISIONS, fmt);
    expect(report.forms).toEqual([{ country: "Slovenija", form: "Kraj, Občina, Država" }]);
    // A file that labels nothing reports nothing — that is a house style too.
    expect(checkPlacesAgainstRegister(ds, REGISTER, NO_DECISIONS).forms).toEqual([]);
  });

  it("counts the people writing a place, both spouses of a family event included", () => {
    const ds = buildFromText(
      `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n` +
        `0 @I1@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 PLAC Sentjur, Slovenija\n` +
        `0 @I2@ INDI\n1 NAME Marija /Novak/\n` +
        `0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n1 MARR\n2 PLAC Sentjur, Slovenija\n0 TRLR\n`,
    );
    const { findings } = checkPlacesAgainstRegister(ds, REGISTER, NO_DECISIONS);
    expect(findings[0].count).toBe(2);
    expect(findings[0].people.sort()).toEqual(["@I1@", "@I2@"]);
  });

  it("reads the register's abbreviated saint as the name the file spells out", () => {
    // GURS registers the village by Škofja Loka as "Sv. Duh"; a researcher
    // writes "Sveti Duh". Without the two meeting, the only answer is the Sveti
    // Duh in another občina — reported as a municipality the register denies.
    const index = buildGazetteerIndex([
      si("Sv. Duh", "Škofja Loka", 46.1667, 14.2833),
      si("Sveti Duh", "Bloke", 45.797, 14.5225),
    ]);
    const ds = fileWith(place("Sveti Duh, Škofja Loka, Slovenija"));
    const { findings } = checkPlacesAgainstRegister(ds, index, NO_DECISIONS);
    expect(findings).toHaveLength(1);
    expect(findings[0].verdict).toBe("spelling");
    expect(findings[0].entry?.admin).toBe("Škofja Loka");
    expect(findings[0].official).toBe("Sv. Duh, Škofja Loka, Slovenija");
  });

  it("recognizes a cemetery standing in a place the directory does know", () => {
    // The register has no "Saint Mary Cemetery"; it has Kranj, which the value
    // names one level down. That is a level to move, not a place to research.
    const ds = fileWith(place("Saint Mary Cemetery, Kranj, Slovenija"));
    const fmt: PlaceTargetFormat = { layout: "structured-addr", separator: ", " };
    const { findings } = checkPlacesAgainstRegister(ds, REGISTER, NO_DECISIONS, fmt);
    expect(findings).toHaveLength(1);
    expect(findings[0].verdict).toBe("site");
    expect(findings[0].written).toBe("Saint Mary Cemetery");
    expect(findings[0].official).toBe("Kranj, Slovenija");
    expect(findings[0].officialAddr).toBe("Saint Mary Cemetery");
    expect(findings[0].entry?.name).toBe("Kranj");
  });

  it("drops the empty segment a split leaves behind, and stays unknown when nothing under it matches", () => {
    const ds = fileWith(place("Adkin District, , Kranj, Slovenija"), place("Nikjer, Nikjer drugje, Slovenija"));
    const { findings } = checkPlacesAgainstRegister(ds, REGISTER, NO_DECISIONS);
    const site = findings.find((f) => f.verdict === "site")!;
    expect(site.official).toBe("Kranj, Slovenija");
    // No ADDR to move to in a file that packs its addresses into the place.
    expect(site.officialAddr).toBeUndefined();
    expect(findings.find((f) => f.key.startsWith("Nikjer"))?.verdict).toBe("notFound");
  });

  it("leaves house numbers to the address rows where the file itself writes them in the place", () => {
    const ds = fileWith(place("Črni Vrh 35, Slovenija"));
    const report = checkPlacesAgainstRegister(ds, REGISTER, NO_DECISIONS);
    expect(report.findings).toEqual([]);
    expect(report.checked).toBe(0);
    expect(report.skipped).toBe(1);
  });

  it("offers to move a house address onto ADDR where that is the file's way", () => {
    const ds = fileWith(place("Kranj, Slovenija"), place("Stražišče 114, Kranj, Slovenija"));
    const fmt: PlaceTargetFormat = { layout: "structured-addr", separator: ", " };
    const { findings } = checkPlacesAgainstRegister(ds, REGISTER, NO_DECISIONS, fmt);
    const split = findings.find((f) => f.verdict === "address")!;
    expect(split.key).toBe("Stražišče 114, Kranj, Slovenija");
    expect(split.officialAddr).toBe("Stražišče 114");
    expect(split.official).not.toContain("114");
    // Without that layout the value is the Addresses tab's business, as before.
    expect(checkPlacesAgainstRegister(ds, REGISTER, NO_DECISIONS).findings.some((f) => f.verdict === "address")).toBe(
      false,
    );
  });

  it("names the settlement the house comes off, where the directory knows one of it", () => {
    // The entry is what lets the row answer with a whole place — municipality
    // and country — rather than the bare name the split left behind.
    const fmt: PlaceTargetFormat = { layout: "structured-addr", separator: ", " };
    const known = fileWith(place("Litija 12, Slovenija"));
    const split = checkPlacesAgainstRegister(known, REGISTER, NO_DECISIONS, fmt).findings.find(
      (f) => f.verdict === "address",
    )!;
    expect(split.officialAddr).toBe("Litija 12");
    expect(split.entry?.admin).toBe("Litija");

    // Two settlements of that name: nothing on an address row chooses between
    // them, so the row names neither.
    const ambiguous = fileWith(place("Soteska 4, Slovenija"));
    const other = checkPlacesAgainstRegister(ambiguous, REGISTER, NO_DECISIONS, fmt).findings.find(
      (f) => f.verdict === "address",
    )!;
    expect(other.officialAddr).toBe("Soteska 4");
    expect(other.entry).toBeUndefined();
  });

  describe("deep verdict", () => {
    /** A GeoNames US settlement: county as `admin`, state code as `admin1` —
     *  and no `register`, the shape a GeoNames file imports as. */
    function us(name: string, admin: string, admin1: string, lat: number, lon: number): GazEntry {
      return { name, ascii: "", alt: [], lat, lon, fclass: "P", country: "US", admin1, admin, population: 0 };
    }

    const US_REGISTER = buildGazetteerIndex(
      [
        us("Chicago", "Cook", "IL", 41.85003, -87.65005),
        us("West Pullman", "Cook", "IL", 41.67505, -87.63782),
        us("Joliet", "Will", "IL", 41.525, -88.0817),
      ],
      new Map([["US:IL", ["Illinois"]]]),
    );

    it("flags a register-held neighbourhood written above its settlement", () => {
      // "West Pullman" is a settlement the directory holds, so no spelling
      // check flags the value — but it stands one level deeper than the file
      // writes the country, and the register accounts for everything from
      // Chicago on. With the structured-addr layout the lead goes to ADDR.
      const ds = fileWith(
        place("Chicago, Cook, Illinois, United States"),
        place("Chicago, Cook, Illinois, United States"),
        place("Joliet, Will, Illinois, United States"),
        place("West Pullman, Chicago, Cook, Illinois, United States"),
      );
      const fmt: PlaceTargetFormat = { layout: "structured-addr", separator: ", " };
      const { findings } = checkPlacesAgainstRegister(ds, US_REGISTER, NO_DECISIONS, fmt);
      expect(findings).toHaveLength(1);
      expect(findings[0].verdict).toBe("deep");
      expect(findings[0].written).toBe("West Pullman");
      expect(findings[0].official).toBe("Chicago, Cook, Illinois, United States");
      expect(findings[0].officialAddr).toBe("West Pullman");
      expect(findings[0].entry?.name).toBe("Chicago");
    });

    it("leaves a register-held place at the file's own depth alone", () => {
      // At the file's own depth West Pullman is simply a settlement in Cook
      // county, which is exactly what the register says it is.
      const ds = fileWith(
        place("Chicago, Cook, Illinois, United States"),
        place("West Pullman, Cook, Illinois, United States"),
      );
      const { findings } = checkPlacesAgainstRegister(ds, US_REGISTER, NO_DECISIONS);
      expect(findings).toEqual([]);
    });

    it("offers to drop the blank level of a value the register otherwise agrees with", () => {
      // The value is fine by every other test — matched, filed right, spelt
      // right — so it used to count as ok and its leftover comma was never
      // offered for dropping anywhere.
      const ds = fileWith(place("Chicago, , Cook, Illinois, United States"));
      const { findings } = checkPlacesAgainstRegister(ds, US_REGISTER, NO_DECISIONS);
      expect(findings).toHaveLength(1);
      expect(findings[0].verdict).toBe("blank");
      expect(findings[0].official).toBe("Chicago, Cook, Illinois, United States");
      expect(findings[0].entry?.name).toBe("Chicago");
    });

    it("a spelling correction sheds the blank level a habit-4 file does not write", () => {
      // The letter-swap alone would keep the export's leftover comma: "Sugar
      // creek, , Clinton, …" corrected to five raw parts in a file whose
      // American places carry four.
      const register = buildGazetteerIndex(
        [
          us("Chicago", "Cook", "IL", 41.85003, -87.65005),
          us("Sugar Creek", "Clinton", "IA", 41.9647, -90.5457),
        ],
        new Map([
          ["US:IL", ["Illinois"]],
          ["US:IA", ["Iowa"]],
        ]),
      );
      const ds = fileWith(
        place("Chicago, Cook, Illinois, United States"),
        place("Chicago, Cook, Illinois, United States"),
        place("Sugar creek, , Clinton, Iowa, United States"),
      );
      const { findings } = checkPlacesAgainstRegister(ds, register, NO_DECISIONS);
      expect(findings).toHaveLength(1);
      expect(findings[0].verdict).toBe("spelling");
      expect(findings[0].official).toBe("Sugar Creek, Clinton, Iowa, United States");

      // A file whose habit *is* the blank slot keeps it through the correction.
      const blanks = fileWith(
        place("Chicago, , Cook, Illinois, United States"),
        place("Chicago, , Cook, Illinois, United States"),
        place("Sugar creek, , Clinton, Iowa, United States"),
      );
      const kept = checkPlacesAgainstRegister(blanks, register, NO_DECISIONS).findings;
      expect(kept[0].official).toBe("Sugar Creek, , Clinton, Iowa, United States");
    });

    it("does not flag when a written parent is one the register cannot account for", () => {
      // "Lakeshore" is neither Chicago's county, its state nor the country —
      // with an unaccounted level in the chain, nothing says which level is
      // the one too many, so the value is not called deep.
      const ds = fileWith(
        place("Chicago, Cook, Illinois, United States"),
        place("Chicago, Cook, Illinois, United States"),
        place("West Pullman, Chicago, Lakeshore, Illinois, United States"),
      );
      const { findings } = checkPlacesAgainstRegister(ds, US_REGISTER, NO_DECISIONS);
      expect(findings.some((f) => f.verdict === "deep")).toBe(false);
    });
  });

  describe("US counties and qualified names", () => {
    function us(name: string, admin: string, admin1: string, lat: number, lon: number): GazEntry {
      return { name, ascii: "", alt: [], lat, lon, fclass: "P", country: "US", admin1, admin, population: 0 };
    }

    const US_REGISTER = buildGazetteerIndex(
      [
        us("Charleroi", "Washington", "PA", 40.1376, -79.898),
        us("Joliet", "Will", "IL", 41.525, -88.0817),
        { ...us("Dawson (historical)", "Colfax", "NM", 36.6642, -104.7747), ascii: "Dawson" },
      ],
      new Map([
        ["US:PA", ["Pennsylvania"]],
        ["US:IL", ["Illinois"]],
        ["US:WA", ["Washington"]],
        ["US:WI", ["Wisconsin"]],
        ["US:NM", ["New Mexico"]],
      ]),
    );

    it("does not read a county sharing a state's name as that state", () => {
      // Charleroi's county *is* Washington — held name-by-name the parent used
      // to be taken for Washington the state and reported as contradicting
      // Pennsylvania, on every county in the file sharing a state's name.
      const ds = fileWith(place("Charleroi, Washington, Pennsylvania, United States"));
      const { findings, ok } = checkPlacesAgainstRegister(ds, US_REGISTER, NO_DECISIONS);
      expect(findings).toEqual([]);
      expect(ok).toBe(1);
    });

    it("does not read a county as a state when the entry knows no county at all", () => {
      // The GeoNames shape: `admin` carries the *state* (attachAdmin1Names —
      // counties are never joined), so nothing marks "Washington" as the
      // county slot except the state beside it agreeing with the entry's own.
      const register = buildGazetteerIndex(
        [us("Canonsburg", "Pennsylvania", "PA", 40.2626, -80.1873)],
        new Map([
          ["US:PA", ["Pennsylvania"]],
          ["US:WA", ["Washington"]],
        ]),
      );
      const ds = fileWith(place("Canonsburg, Washington, Pennsylvania, United States"));
      const { findings, ok } = checkPlacesAgainstRegister(ds, register, NO_DECISIONS);
      expect(findings).toEqual([]);
      expect(ok).toBe(1);
    });

    it("still reports a wrong state beside an agreeing county", () => {
      const ds = fileWith(place("Joliet, Will, Wisconsin, United States"));
      const { findings } = checkPlacesAgainstRegister(ds, US_REGISTER, NO_DECISIONS);
      expect(findings).toHaveLength(1);
      expect(findings[0].verdict).toBe("admin");
      expect(findings[0].writtenAdmin).toBe("Wisconsin");
    });

    it("proposes a register name that carries a bracketed qualifier", () => {
      const ds = fileWith(place("Dawson, New Mexico, United States"));
      const { findings } = checkPlacesAgainstRegister(ds, US_REGISTER, NO_DECISIONS);
      expect(findings).toHaveLength(1);
      expect(findings[0].verdict).toBe("spelling");
      expect(findings[0].official).toBe("Dawson (historical), New Mexico, United States");
    });

    it("accepts a register name whose bracketed qualifier the file writes verbatim", () => {
      // The register's own answer, applied: "(historical)" is an aside to the
      // place decomposition, so the locality alone re-failed the spelling gate
      // forever — a fresh finding proposing the value it already is.
      const ds = fileWith(place("Dawson (historical), New Mexico, United States"));
      const { findings, ok } = checkPlacesAgainstRegister(ds, US_REGISTER, NO_DECISIONS);
      expect(findings).toEqual([]);
      expect(ok).toBe(1);
    });
  });
});
