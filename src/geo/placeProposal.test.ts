import { describe, expect, it } from "vitest";
import type { PlaceTargetFormat } from "../normalize/types";
import { buildGazetteerIndex, type GazEntry } from "./gazetteer";
import { inferPlaceParentLevels } from "./placeLevels";
import type { RnResult } from "./rn";
import {
  countryNameOf,
  placeDepthOf,
  placeDepthsOf,
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

describe("placeDepthsOf", () => {
  it("counts each country's own habit apart from the file-wide mode", () => {
    const depths = placeDepthsOf([
      "Kranj,Kranj,Slovenija",
      "Bled,Bled,Slovenija",
      "Ljubljana,Slovenija",
      "Chicago, Cook, Illinois, United States",
      "Highland, San Bernardino, California, United States",
    ]);
    expect(depths.depth).toBe(3);
    expect(depths.byCountry.get("slovenia")).toBe(3);
    expect(depths.byCountry.get("unitedstates")).toBe(4);
  });

  it("keys a country by its canonical token, whatever the file's spelling", () => {
    const depths = placeDepthsOf(["Cleveland, Ohio, ZDA", "Chicago, Cook, Illinois, USA"]);
    // Two spellings, one country: the mode is taken over both, ties to fewer.
    expect(depths.byCountry.get("unitedstates")).toBe(3);
  });

  it("leaves a place naming no country to the file-wide mode alone", () => {
    const depths = placeDepthsOf(["Zabukovje", "Zabukovje", "Kranj,Kranj,Slovenija"]);
    expect(depths.depth).toBe(1);
    expect(depths.byCountry.get("slovenia")).toBe(3);
    expect(depths.byCountry.size).toBe(1);
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

  it("keeps a locality named with a facility word ('Bela Cerkev') in its own proposal", () => {
    // The reformatter's heuristics read a leading "… cerkev/grad/…" segment as
    // a church or castle detail — right for "Mestno pokopališče Kranj", wrong
    // for the real villages Bela Cerkev, Nova Cerkev or Grad. The register
    // knows the segment is a locality, so the proposal must never lose it:
    // this entry used to surface (and would have been written!) as its
    // municipality, "Šmarješke Toplice, Slovenija".
    const belaCerkev: GazEntry = { ...ZABUKOVJE, name: "Bela Cerkev", admin: "Šmarješke Toplice" };
    const p = proposalFromGazEntry(belaCerkev, style())!;
    expect(p.plac).toBe("Bela Cerkev,Šmarješke Toplice,Slovenija");
  });

  // The chain is composed here, so what each part is is known rather than
  // guessed — worth declaring, in the wording this file already uses.
  const forms = new Map([
    ["slovenia|3", "Place,Upravna Enota,Country"],
    ["slovenia|2", "Place,Country"],
    ["|3", "Place,Region,Country"],
  ]);

  it("declares the levels with the file's own FORM wording", () => {
    expect(proposalFromGazEntry(ZABUKOVJE, style({}, { forms }))!.form).toBe("Place,Upravna Enota,Country");
  });

  it("matches the FORM to the depth actually written", () => {
    expect(proposalFromGazEntry(ZABUKOVJE, style({ depth: 2 }, { forms }))!.form).toBe("Place,Country");
  });

  it("writes no FORM for a file that writes none", () => {
    expect(proposalFromGazEntry(ZABUKOVJE, style())!.form).toBeUndefined();
  });

  it("writes no FORM where the file has never labelled this shape", () => {
    const onlyFour = new Map([["slovenia|4", "Place,A,B,Country"]]);
    expect(proposalFromGazEntry(ZABUKOVJE, style({}, { forms: onlyFour }))!.form).toBeUndefined();
  });

  it("never labels a packed PLAC, whose parts are not all jurisdictions", () => {
    const p = proposalFromGazEntry(ZABUKOVJE, style({}, { layout: "packed-plac", forms }))!;
    expect(p.form).toBeUndefined();
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

  it("names the level this file writes above a settlement", () => {
    // A file writing counties gets the county; the municipality would be the
    // right place at the wrong level, and would not look like its neighbours.
    const sinac: GazEntry = { ...ZABUKOVJE, name: "Sinac", country: "HR", admin: "Otočac", admin1: "09" };
    const levels = inferPlaceParentLevels(
      ["Stipernica, Krapina-Zagorje, Hrvaška"],
      buildGazetteerIndex(
        [sinac, { ...sinac, name: "Stipernica", admin: "Pregrada", admin1: "02" }],
        new Map([
          ["HR:02", ["Krapinsko-zagorska županija", "Krapinsko-zagorska", "Krapina-Zagorje"]],
          ["HR:09", ["Ličko-senjska županija", "Ličko-senjska", "Lika-Senj"]],
        ]),
      ),
    );
    expect(proposalFromGazEntry(sinac, style({ parentLevels: levels }))!.plac).toBe("Sinac,Lika-Senj,Hrvaška");
    expect(proposalFromGazEntry(sinac, style())!.plac).toBe("Sinac,Otočac,Hrvaška");
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

  // The Nominatim hit the multi-level chain exists for: county *and* state.
  const HIGHLAND = {
    coord: { lat: 34.1283, lon: -117.2086 },
    name: "Highland",
    label: "Highland, San Bernardino County, California, United States",
    admin: "San Bernardino County",
    kind: "city",
    parts: {
      locality: "Highland",
      admin: "San Bernardino County",
      admins: ["San Bernardino County", "California"],
      country: "United States",
    },
  };
  const US = new Map([["united states", "United States"]]);

  it("writes county and state for a file whose places carry four levels", () => {
    const p = proposalFromNominatim(HIGHLAND, style({ depth: 4 }, { separator: ", ", countryPreferred: US }))!;
    expect(p.plac).toBe("Highland, San Bernardino County, California, United States");
  });

  it("keeps the level nearest the country for a three-level file", () => {
    // A depth-3 American file writes "place, state, country" — the state is
    // what such files keep, not the county or the township.
    const p = proposalFromNominatim(HIGHLAND, style({ depth: 3 }, { separator: ", ", countryPreferred: US }))!;
    expect(p.plac).toBe("Highland, California, United States");
  });

  it("writes each country at the file's own depth for that country", () => {
    // The file is mostly three-level Slovenian places, but writes its American
    // ones in four — a proposal follows the habit of the country it is in.
    const depthByCountry = new Map([["unitedstates", 4]]);
    const p = proposalFromNominatim(
      {
        coord: { lat: 41.806, lon: -88.3273 },
        name: "North Aurora",
        label: "North Aurora, Aurora Township, Kane County, Illinois, 60542, United States",
        admin: "Aurora Township",
        kind: "village",
        parts: {
          locality: "North Aurora",
          admin: "Aurora Township",
          admins: ["Aurora Township", "Kane County", "Illinois"],
          country: "United States",
        },
      },
      style(
        { depth: 3, depthByCountry },
        {
          separator: ", ",
          countryPreferred: US,
          // The file's own FORM wording for four-level American places: the
          // label is keyed by country and written depth, so it follows along.
          forms: new Map([["unitedstates|4", "Place,County,State,Country"]]),
        },
      ),
    )!;
    // Four levels despite the file-wide mode of three — and the township, the
    // level American files omit, is the one the trim drops.
    expect(p.plac).toBe("North Aurora, Kane County, Illinois, United States");
    expect(p.form).toBe("Place,County,State,Country");
  });

  it("writes the levels it has when the file's places go deeper still", () => {
    const p = proposalFromNominatim(HIGHLAND, style({ depth: 5 }, { separator: ", ", countryPreferred: US }))!;
    expect(p.plac).toBe("Highland, San Bernardino County, California, United States");
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
