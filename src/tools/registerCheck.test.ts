import { describe, expect, it } from "vitest";
import { parseGedcom } from "../gedcom/parser";
import { buildDataset } from "../gedcom/builder";
import { buildGazetteerIndex, GURS_REGISTER, type GazEntry } from "../geo/gazetteer";
import type { GeocodeDecision } from "../persist/geoDb";
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

  it("counts every occurrence of a value and returns nothing without a register", () => {
    const ds = fileWith(place("Sentjur, Slovenija"), place("Sentjur, Slovenija"));
    expect(checkPlacesAgainstRegister(ds, REGISTER, NO_DECISIONS).findings[0].count).toBe(2);
    expect(checkPlacesAgainstRegister(ds, undefined, NO_DECISIONS).findings).toEqual([]);
    // An OpenStreetMap import is not a register: it can neither answer for a
    // country nor put one in scope.
    const osm = buildGazetteerIndex([{ ...si("Sentjur", "", 46.2, 15.4), register: undefined }]);
    expect(checkPlacesAgainstRegister(ds, osm, NO_DECISIONS).checked).toBe(0);
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

  it("labels each finding with the country it is in — the filter chips' key", () => {
    const ds = fileWith(place("Sentjur, Slovenija"), place("Neznani Kraj XY, Slovenija"));
    const { findings } = checkPlacesAgainstRegister(ds, REGISTER, NO_DECISIONS);
    // Matched or not, a finding always names a covered country: the matched
    // entry's, else the one the place itself writes.
    expect(findings.map((f) => f.country)).toEqual(["SI", "SI"]);
  });

  it("leaves house numbers to the address rows", () => {
    const ds = fileWith(place("Črni Vrh 35, Slovenija"));
    const report = checkPlacesAgainstRegister(ds, REGISTER, NO_DECISIONS);
    expect(report.findings).toEqual([]);
    expect(report.checked).toBe(0);
  });
});
