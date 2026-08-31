import { describe, it } from "vitest";
import { parseGedcom } from "../gedcom/parser";
import { buildDataset } from "../gedcom/builder";
import { buildPlaceTree } from "./places";
import { collectFileCoords, countGeocodePending } from "./geocode";
import { applyPlaceRename } from "./placeEdit";
import { scanAddresses } from "./addresses";
import { buildPlaceSuggestions } from "../ui/edit/placeSuggestions";
import { rnQueriesFrom } from "../geo/rn";
import { decomposePlace } from "../gedcom/place";
import { collectNodeUseIds } from "./places";

// A stopwatch, not an assertion: what one rename in the places tree costs, pass
// by pass, on a file the size of a real one. Run with
//   npx vitest run src/tools/placesPerf.bench.test.ts
// and read the numbers off the console; nothing here fails, so it never gates a
// merge.

/** A file of `n` people spread over a few hundred places, half of them with an
 *  address and a coordinate — the shape these passes are read on. */
function bigFile(n: number): string {
  const lines = ["0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8"];
  for (let i = 0; i < n; i++) {
    const village = `Vas ${i % 300}`;
    const place = i % 7 === 0 ? `${village}` : `${village}, Kranj, Slovenija`;
    lines.push(`0 @I${i}@ INDI`, `1 NAME Ana${i} /Kos/`, "1 BIRT", `2 PLAC ${place}`);
    if (i % 2 === 0) {
      lines.push(`2 ADDR ${village} ${i % 90}`, "3 MAP", `4 LATI N46.${200000 + i}`, `4 LONG E14.${300000 + i}`);
    }
    lines.push("1 DEAT", `2 PLAC ${village}, Kranj, Slovenija`);
  }
  lines.push("0 TRLR", "");
  return lines.join("\n");
}

describe("places tree: what a rename costs", () => {
  it("times every whole-file pass a rename sets off", () => {
    const text = bigFile(4000);
    const ds = buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
    const time = (label: string, fn: () => unknown) => {
      const t0 = performance.now();
      fn();
      console.log(`${label.padEnd(24)} ${(performance.now() - t0).toFixed(1)} ms`);
    };
    time("buildPlaceTree", () => buildPlaceTree(ds));
    time("buildPlaceSuggestions", () => buildPlaceSuggestions(ds));
    time("collectFileCoords", () => collectFileCoords(ds));
    time("countGeocodePending", () => countGeocodePending(ds));
    time("scanAddresses", () => scanAddresses(ds));
    time("applyPlaceRename (all)", () => applyPlaceRename(ds, "Vas 7", "Vas 7 nova"));

    // What every *row* on screen used to pay on each rebuild, at 300 open rows:
    // the coordinate panel's two memos on mount, and the per-row work now kept
    // for the row actually being renamed.
    const tree = buildPlaceTree(ds);
    const rows = tree.roots.flatMap((r) => r.children.flatMap((c) => c.children));
    const suggestions = buildPlaceSuggestions(ds).placeSuggestions;
    time("row: coord panel memos", () => {
      for (const row of rows) {
        rnQueriesFrom(row.name, undefined);
        decomposePlace(row.name);
      }
    });
    time("row: subtree ids", () => {
      for (const row of rows) collectNodeUseIds(row);
    });
    time("row: completion list", () => {
      for (const row of rows) {
        const seen = new Set([row.name.toLowerCase()]);
        void suggestions.filter((v) => !seen.has(v.toLowerCase()));
      }
    });
  });
});
