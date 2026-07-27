import { describe, expect, it } from "vitest";
import type { PlaceTargetFormat } from "../normalize/types";
import type { GazEntry } from "./gazetteer";
import type { RnResult } from "./rn";
import {
  countryNameOf,
  placeDepthOf,
  proposalFromGazEntry,
  proposalFromGov,
  proposalFromNominatim,
  proposalFromRn,
  proposalKey,
  type PlaceStyle,
} from "./placeProposal";

const SLOVENIJA = new Map([["slovenia", "Slovenija"]]);

function style(over: Partial<PlaceStyle> = {}, fmt: Partial<PlaceTargetFormat> = {}): PlaceStyle {
  return {
    fmt: { layout: "structured-addr", separator: ",", countryPreferred: SLOVENIJA, ...fmt },
    depth: 3,
    language: "sl",
    ...over,
  };
}

const ZABUKOVJE: GazEntry = {
  name: "Zabukovje",
  ascii: "",
  alt: [],
  lat: 46.05,
  lon: 15.31,
  fclass: "P",
  country: "SI",
  admin1: "",
  admin: "Sevnica",
  population: 300,
  register: "SI-GURS",
};

describe("countryNameOf", () => {
  it("names a country in the UI language", () => {
    expect(countryNameOf("SI", "sl")).toBe("Slovenija");
    expect(countryNameOf("SI", "en")).toBe("Slovenia");
    expect(countryNameOf("", "en")).toBeUndefined();
  });
});

describe("placeDepthOf", () => {
  it("takes the file's modal number of jurisdiction levels", () => {
    expect(placeDepthOf(["Kranj,Kranj,Slovenija", "Bled,Bled,Slovenija", "Ljubljana,Slovenija"])).toBe(3);
    expect(placeDepthOf(["Kranj,Slovenija", "Bled,Slovenija", "Ljubljana,Ljubljana,Slovenija"])).toBe(2);
    // A file with no places yet: locality + country is the safe assumption.
    expect(placeDepthOf([])).toBe(2);
  });
});

describe("a gazetteer entry as a place", () => {
  it("writes the register's chain in the file's layout and country spelling", () => {
    const p = proposalFromGazEntry(ZABUKOVJE, style())!;
    expect(p.plac).toBe("Zabukovje,Sevnica,Slovenija");
    expect(p.addr).toBeUndefined();
    expect(p.coord).toEqual({ lat: 46.05, lon: 15.31 });
    expect(p.source).toBe("SI-GURS");
    expect(p.official).toBe(true);
  });

  it("drops the municipality when the file writes only locality + country", () => {
    expect(proposalFromGazEntry(ZABUKOVJE, style({ depth: 2 }))!.plac).toBe("Zabukovje,Slovenija");
  });

  it("keeps the file's separator and its English country spelling", () => {
    const p = proposalFromGazEntry(
      ZABUKOVJE,
      style({ language: "en" }, { separator: ", ", countryPreferred: new Map([["slovenia", "Slovenia"]]) }),
    )!;
    expect(p.plac).toBe("Zabukovje, Sevnica, Slovenia");
  });

  it("packs everything into one PLAC for a packed-plac file", () => {
    const p = proposalFromGazEntry(ZABUKOVJE, style({}, { layout: "packed-plac" }))!;
    expect(p.plac).toBe("Zabukovje (Slovenija)");
  });

  it("labels a crowd-sourced entry with its country, not as official", () => {
    const osm: GazEntry = { ...ZABUKOVJE, register: undefined, admin: undefined };
    const p = proposalFromGazEntry(osm, style())!;
    expect(p.plac).toBe("Zabukovje,Slovenija");
    expect(p.source).toBe("SI");
    expect(p.official).toBeFalsy();
  });

  it("keeps a municipality named after its own seat, the way such files write it", () => {
    const p = proposalFromGazEntry({ ...ZABUKOVJE, name: "Sevnica" }, style())!;
    expect(p.plac).toBe("Sevnica,Sevnica,Slovenija");
  });
});

describe("an address-register house as a place", () => {
  const house: RnResult = {
    coord: { lat: 46.24, lon: 14.35 },
    address: "Hafnarjeva pot 21",
    post: "4000 Kranj",
    label: "Hafnarjeva pot 21, Kranj · 4000 Kranj",
    settlement: "Kranj",
    municipality: "Kranj",
    number: 21,
  };

  it("splits the house into ADDR and the settlement into PLAC", () => {
    const p = proposalFromRn(house, style())!;
    expect(p.plac).toBe("Kranj,Kranj,Slovenija");
    expect(p.addr).toBe("Hafnarjeva pot 21");
    expect(p.coord).toEqual(house.coord);
    expect(p.source).toBe("GURS");
    expect(p.detail).toBe(house.label);
  });

  it("folds the house into PLAC for a packed-plac file", () => {
    const p = proposalFromRn(house, style({}, { layout: "packed-plac" }))!;
    expect(p.plac).toBe("Kranj (Slovenija), Hafnarjeva pot 21");
    expect(p.addr).toBeUndefined();
  });
});

describe("GOV and OpenStreetMap as places", () => {
  it("takes GOV's parent and carries its id — GOV names no country, so none is invented", () => {
    const p = proposalFromGov(
      { coord: { lat: 46.23, lon: 14.35 }, name: "Stražišče", label: "Stražišče · Strassdorf", govId: "object_310010", admin: "Kranj" },
      style(),
    )!;
    expect(p.plac).toBe("Stražišče,Kranj");
    expect(p.govId).toBe("object_310010");
    expect(p.source).toBe("GOV");
  });

  it("builds place and address from a Nominatim house, whose own name is the number", () => {
    const p = proposalFromNominatim(
      {
        coord: { lat: 46.2456, lon: 14.3312 },
        name: "21",
        label: "21, Hafnarjeva pot, Stražišče, Kranj, 4000 Kranj, Slovenija",
        admin: "Hafnarjeva pot",
        kind: "house",
        parts: { house: "21", road: "Hafnarjeva pot", locality: "Stražišče", admin: "Kranj", country: "Slovenija" },
      },
      style(),
    )!;
    expect(p.plac).toBe("Stražišče,Kranj,Slovenija");
    expect(p.addr).toBe("Hafnarjeva pot 21");
  });

  it("numbers a house off its village where no street is named", () => {
    const p = proposalFromNominatim(
      {
        coord: { lat: 46.05, lon: 15.31 },
        name: "12",
        label: "12, Zabukovje, Sevnica, Slovenija",
        kind: "house",
        parts: { house: "12", locality: "Zabukovje", admin: "Sevnica", country: "Slovenija" },
      },
      style(),
    )!;
    expect(p.plac).toBe("Zabukovje,Sevnica,Slovenija");
    expect(p.addr).toBe("Zabukovje 12");
  });

  it("prefers the structured parts over the display chain for a settlement too", () => {
    const p = proposalFromNominatim(
      {
        coord: { lat: 46.05, lon: 15.31 },
        name: "Zabukovje",
        label: "Zabukovje, Občina Sevnica, Spodnjeposavska, 8292, Slovenija",
        admin: "Občina Sevnica",
        kind: "village",
        parts: { locality: "Zabukovje", admin: "Sevnica", country: "Slovenija" },
      },
      style(),
    )!;
    expect(p.plac).toBe("Zabukovje,Sevnica,Slovenija");
    expect(p.addr).toBeUndefined();
  });

  it("reads a Nominatim line as feature, parent and country — postcodes dropped", () => {
    const p = proposalFromNominatim(
      {
        coord: { lat: 46.05, lon: 14.5 },
        name: "Šiška",
        label: "Šiška, Ljubljana, 1000, Slovenija",
        admin: "Ljubljana",
        kind: "suburb",
      },
      style(),
    )!;
    expect(p.plac).toBe("Šiška,Ljubljana,Slovenija");
    expect(p.source).toBe("OSM");
  });
});

describe("proposalKey", () => {
  it("treats the same place from two registers as one offer", () => {
    const gurs = proposalFromGazEntry(ZABUKOVJE, style({ depth: 2 }))!;
    const osm = proposalFromGazEntry({ ...ZABUKOVJE, register: undefined, admin: undefined, lat: 46.06 }, style({ depth: 2 }))!;
    expect(proposalKey(gurs)).toBe(proposalKey(osm));
  });

  it("keeps a house apart from its bare settlement", () => {
    const settlement = proposalFromGazEntry(ZABUKOVJE, style())!;
    const house = proposalFromRn(
      {
        coord: { lat: 46.05, lon: 15.31 },
        address: "Zabukovje 12",
        label: "Zabukovje 12",
        settlement: "Zabukovje",
        municipality: "Sevnica",
        number: 12,
      },
      style(),
    )!;
    expect(proposalKey(house)).not.toBe(proposalKey(settlement));
  });
});
