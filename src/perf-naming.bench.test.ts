import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "vitest";
import { buildDataset } from "./gedcom/builder";
import { parseGedcom } from "./gedcom/parser";
import { attachAdmin1Names, buildGazetteerIndex, mergeDivisions, parseGeoNamesLine } from "./geo/gazetteer";
import { inferPlaceParentLevels } from "./geo/placeLevels";
import type { PlaceTargetFormat } from "./normalize/types";
import { checkPlacesAgainstRegister } from "./tools/registerCheck";
import { scanGeocode } from "./tools/geocode";

// Timing probe for the Naming / Geocoding pipeline against a real
// country-sized register. Runs only where the GeoNames US dump exists
// (developer machine, see the scratchpad); CI skips it.
const DUMP = "/private/tmp/claude-501/-Users-lukarenko-rodoslovje-ged-merge/489aad57-62d1-4b71-9d10-7be1f39c16b0/scratchpad/US.txt";

function time<T>(label: string, fn: () => T): T {
  const t0 = performance.now();
  const out = fn();
  console.log(`${label}: ${Math.round(performance.now() - t0)}ms`);
  return out;
}

describe.skipIf(!existsSync(DUMP))("naming/geocoding performance", () => {
  it("times the pipeline", () => {
    const lines = readFileSync(DUMP, "utf8").split("\n");
    const entries = time("parse dump", () => {
      const out = [];
      for (const line of lines) {
        const e = parseGeoNamesLine(line);
        if (e) out.push(e);
      }
      return out;
    });
    const divisions = time("attachAdmin1Names", () => attachAdmin1Names(entries));
    const index = time("buildGazetteerIndex", () =>
      buildGazetteerIndex(entries, mergeDivisions([{ entries, divisions }])),
    );

    // A file shaped like the real one: ~11k people over ~2.7k distinct places —
    // known US places (some written with a blank level), misspellings, unknown
    // hamlets, and a Slovenian majority no US register covers.
    const settlements = entries.filter((e) => e.fclass === "P" && e.admin);
    const usKnown = [];
    for (let i = 0; i < 500; i++) {
      const e = settlements[(i * 37) % settlements.length];
      usKnown.push(`${e.name}, , Cook, ${e.admin}, United States`);
    }
    const usTypo = [];
    for (let i = 0; i < 100; i++) {
      const e = settlements[(i * 91) % settlements.length];
      usTypo.push(`${e.name}x, , Cook, ${e.admin}, United States`);
    }
    const usUnknown = [];
    for (let i = 0; i < 100; i++) usUnknown.push(`Zzz${i}ville, , Foo, Illinois, United States`);
    const slovenian = [];
    for (let i = 0; i < 2000; i++) slovenian.push(`Vas ${i}, Slovenija`);
    const places = [...usKnown, ...usTypo, ...usUnknown, ...slovenian];

    const people: string[] = [];
    for (let i = 0; i < 11000; i++) {
      const place = places[i % places.length];
      people.push(`0 @I${i}@ INDI\n1 NAME Oseba /Test${i}/\n1 BIRT\n2 DATE 1900\n2 PLAC ${place}`);
    }
    const ds = time("build dataset", () =>
      buildDataset(parseGedcom(new TextEncoder().encode(`0 HEAD\n1 GEDC\n2 VERS 5.5.1\n${people.join("\n")}\n0 TRLR\n`).buffer)),
    );

    const fmt: PlaceTargetFormat = { layout: "structured-addr", separator: ", " };
    time("inferPlaceParentLevels", () => inferPlaceParentLevels(places, index, fmt));
    time("inferPlaceParentLevels (again)", () => inferPlaceParentLevels(places, index, fmt));
    const decisions = new Map();
    time("checkPlacesAgainstRegister cold", () => checkPlacesAgainstRegister(ds, index, decisions, fmt, ""));
    time("checkPlacesAgainstRegister warm", () => checkPlacesAgainstRegister(ds, index, decisions, fmt, ""));
    time("scanGeocode cold", () => scanGeocode(ds, index, new Map(), ""));
    time("scanGeocode warm", () => scanGeocode(ds, index, new Map(), ""));
  }, 240_000);
});
