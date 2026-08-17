/**
 * Performance probe: what one Edit-mode commit costs in whole-file scans.
 *
 * Every commit (blur-commit of a field, quick-add event, …) bumps
 * editVersion/tick, which re-runs these derivations synchronously in the same
 * frame as the user's click. This test times each one against the large
 * corpus files to show where the seconds go. Not a regression test — skipped
 * unless PERF_GED points at a .ged file.
 */
import { readFileSync, appendFileSync } from "node:fs";

const OUT = process.env.PERF_OUT;
function report(line: string) {
  console.log(line);
  if (OUT) appendFileSync(OUT, line + "\n");
}
import { describe, it } from "vitest";
import { parseGedcom } from "./gedcom/parser";
import { buildDataset } from "./gedcom/builder";
import { defaultStartId } from "./match/relatives";
import { computeDistances } from "./match/distance";
import { buildSearchRows } from "./ui/globalSearch";
import { buildPlaceSuggestions } from "./ui/edit/placeSuggestions";
import { collectPlaceValues } from "./tools/geocode";
import { detectHomeCountry } from "./geo/homeCountry";
import { inferPlaceExportFormat } from "./normalize/profile";
import { walkPlaceAddr, placeAddrKey } from "./tools/geocode";
import { formatPersonName, DEFAULT_NAME_DISPLAY } from "./gedcom/nameDisplay";
import { lifespanOf } from "./gedcom/lifespan";
import { cloneNode } from "./gedcom/node";
import type { Dataset, GedNode } from "./gedcom/types";

const file = process.env.PERF_GED;

function ms(fn: () => unknown): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

function timed(label: string, fn: () => unknown, rounds = 3) {
  // warm once, then best-of-N — matches what a warmed JIT does mid-session
  fn();
  let best = Infinity;
  for (let i = 0; i < rounds; i++) best = Math.min(best, ms(fn));
  report(`${label.padEnd(46)} ${best.toFixed(1).padStart(8)} ms`);
  return best;
}

describe.skipIf(!file)("edit-commit cost profile", () => {
  it("times the per-commit whole-file derivations", () => {
    const buf = readFileSync(file!);
    const t0 = performance.now();
    const parsed = parseGedcom(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
    const dataset: Dataset = buildDataset(parsed);
    report(`\nfile: ${file}`);
    report(`parse+build: ${(performance.now() - t0).toFixed(0)} ms — ${dataset.individuals.size} INDI, ${dataset.families.size} FAM`);

    const startId = defaultStartId(dataset)!;
    const nameOf = (i: { names: never[] }) => formatPersonName(i.names[0], DEFAULT_NAME_DISPLAY);

    let total = 0;
    report("\n— per-commit costs (run on EVERY edit commit) —");
    total += timed("App: buildSearchRows (scan + localeCompare sort)", () =>
      buildSearchRows(dataset.individuals, nameOf as never));
    total += timed("App: computeDistances (kinship BFS)", () => computeDistances(dataset, startId));
    total += timed("App: StartPersonSelector options sort", () => {
      const opts = [...dataset.individuals.values()].map((i) => ({
        id: i.id,
        text: `${nameOf(i as never)} ${lifespanOf(i) ?? ""}`,
      }));
      opts.sort((a, b) => a.text.localeCompare(b.text));
    });
    total += timed("Derivations: buildPlaceSuggestions", () => buildPlaceSuggestions(dataset));
    total += timed("EditView: pairUses walk (walkPlaceAddr all)", () => {
      const counts = new Map<string, number>();
      const visit = (raw: GedNode) =>
        walkPlaceAddr(raw, (plac, addr) => {
          const key = placeAddrKey(plac.value!.trim(), addr);
          counts.set(key, (counts.get(key) ?? 0) + 1);
        });
      for (const indi of dataset.individuals.values()) visit(indi.raw);
      for (const fam of dataset.families.values()) visit(fam.raw);
    });
    total += timed("PlaceLookup: inferPlaceExportFormat", () => inferPlaceExportFormat(dataset));
    total += timed("Derivations: collectPlaceValues+detectHomeCountry", () =>
      detectHomeCountry(collectPlaceValues(dataset)));
    report(`${"TOTAL scans per commit".padEnd(46)} ${total.toFixed(1).padStart(8)} ms`);
    report("(the place-edit blur + the Burial click are TWO commits → ×2, plus React re-render of the whole app tree on top)");

    report("\n— per-commit per-record costs (sanity check, should be tiny) —");
    const person = dataset.individuals.get(startId)!;
    timed("commit: cloneRaw + JSON.stringify compare", () => {
      const before = cloneNode(person.raw);
      const after = cloneNode(person.raw);
      return JSON.stringify(before) === JSON.stringify(after);
    });
  });
});
