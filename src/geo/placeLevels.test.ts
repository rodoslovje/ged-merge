import { describe, expect, it } from "vitest";
import { buildGazetteerIndex, DGU_REGISTER, GURS_REGISTER, type GazEntry } from "./gazetteer";
import { inferPlaceParentLevels } from "./placeLevels";
import type { PlaceTargetFormat } from "../normalize/types";

/** A Croatian register settlement: its općina as `admin`, its županija's code
 *  as `admin1` — the shape the DGU import produces. */
function hr(name: string, admin: string, admin1: string): GazEntry {
  return {
    name,
    ascii: "",
    alt: [],
    lat: 45.4,
    lon: 17.2,
    fclass: "P",
    country: "HR",
    admin1,
    admin,
    population: 0,
    register: DGU_REGISTER,
  };
}

function si(name: string, admin: string): GazEntry {
  return {
    name,
    ascii: "",
    alt: [],
    lat: 46.05,
    lon: 14.5,
    fclass: "P",
    country: "SI",
    admin1: "",
    admin,
    population: 0,
    register: GURS_REGISTER,
  };
}

/** The county name lists the DGU import stores: official, bare adjective, then
 *  the English forms a file is as likely to write. */
const DIVISIONS = new Map<string, string[]>([
  ["HR:11", ["Požeško-slavonska županija", "Požeško-slavonska", "Požega-Slavonia", "Požega-Slavonia County"]],
  ["HR:02", ["Krapinsko-zagorska županija", "Krapinsko-zagorska", "Krapina-Zagorje", "Krapina-Zagorje County"]],
  ["HR:09", ["Ličko-senjska županija", "Ličko-senjska", "Lika-Senj", "Lika-Senj County"]],
]);

const INDEX = buildGazetteerIndex(
  [
    hr("Bektež", "Kutjevo", "11"),
    hr("Španovica", "Pakrac", "11"),
    hr("Stipernica", "Pregrada", "02"),
    hr("Sinac", "Otočac", "09"),
    si("Vrh", "Šmartno pri Litiji"),
  ],
  DIVISIONS,
);

describe("inferPlaceParentLevels", () => {
  it("reads a county-level file off the names it writes", () => {
    const levels = inferPlaceParentLevels(
      ["Bektež, Požega-Slavonia, Croatia", "Stipernica, Krapina-Zagorje, Croatia"],
      INDEX,
    );
    expect(levels.levelOf("HR")).toBe("division");
    // And names an entry under the county, in the wording the file uses.
    expect(levels.parentOf(hr("Sinac", "Otočac", "09"))).toBe("Lika-Senj");
  });

  it("keeps the municipality for a file that writes municipalities", () => {
    const levels = inferPlaceParentLevels(
      ["Bektež, Kutjevo, Croatia", "Španovica, Pakrac, Croatia"],
      INDEX,
    );
    expect(levels.levelOf("HR")).toBe("admin");
    expect(levels.parentOf(hr("Sinac", "Otočac", "09"))).toBe("Otočac");
  });

  it("writes a county the file has never named the way it writes the others", () => {
    const levels = inferPlaceParentLevels(["Bektež, Požeško-slavonska županija, Croatia"], INDEX);
    // The file reaches for the official form, so an unwritten county gets that
    // form too rather than the English one.
    expect(levels.parentOf(hr("Sinac", "Otočac", "09"))).toBe("Ličko-senjska županija");
  });

  it("judges each country on its own places", () => {
    const levels = inferPlaceParentLevels(
      ["Bektež, Požega-Slavonia, Croatia", "Vrh, Šmartno pri Litiji, Slovenija"],
      INDEX,
    );
    expect(levels.levelOf("HR")).toBe("division");
    expect(levels.levelOf("SI")).toBe("admin");
  });

  it("lets a FORM settle a file whose parents name both levels at once", () => {
    // Croatia files a Karlovac county and a Karlovac city under the same word,
    // so the name alone is no evidence either way.
    const index = buildGazetteerIndex(
      [hr("Zaluka", "Karlovac", "04")],
      new Map([["HR:04", ["Karlovačka županija", "Karlovačka", "Karlovac", "Karlovac County"]]]),
    );
    const places = ["Zaluka, Karlovac, Croatia"];
    expect(inferPlaceParentLevels(places, index).levelOf("HR")).toBe("admin");

    const fmt: PlaceTargetFormat = {
      layout: "plain-structured",
      separator: ", ",
      forms: new Map([["croatia|3", "Mjesto, Županija, Država"]]),
    };
    expect(inferPlaceParentLevels(places, index, fmt).levelOf("HR")).toBe("division");
  });

  it("keeps a name rank learned in one country out of another's lists", () => {
    // The lists are ordered per register, so the rank means nothing across
    // countries: index 2 of a Croatian county's list is its English name,
    // index 2 of an American state's is the "Fla." abbreviation.
    const us = (name: string, admin: string, admin1: string): GazEntry => ({
      name, ascii: "", alt: [], lat: 28.1, lon: -81.6, fclass: "P", country: "US", admin1, admin, population: 0,
    });
    const index = buildGazetteerIndex(
      [hr("Bektež", "Kutjevo", "11"), hr("Stipernica", "Pregrada", "02"), us("Lakeville", "Lake", "FL")],
      new Map([...DIVISIONS, ["US:FL", ["Florida", "Fla.", "La Florida"]]]),
    );
    const levels = inferPlaceParentLevels(["Bektež, Požega-Slavonia, Croatia"], index);
    // The file writes Croatian counties in English, so an unwritten Croatian
    // county follows suit — but an American state it never wrote keeps the
    // register's own primary name rather than the same rank in a foreign list.
    expect(levels.divisionNameOf(hr("Stipernica", "Pregrada", "02"))).toBe("Krapina-Zagorje");
    expect(levels.divisionNameOf(us("Lakeville", "Lake", "FL"))).toBe("Florida");
  });

  it("leaves the municipality where nothing says otherwise", () => {
    const levels = inferPlaceParentLevels([], INDEX);
    expect(levels.levelOf("HR")).toBe("admin");
    expect(levels.parentOf(hr("Sinac", "Otočac", "09"))).toBe("Otočac");
  });
});
