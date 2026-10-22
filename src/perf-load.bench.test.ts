/**
 * Performance probe: what loading an incoming file costs the main thread,
 * normalizing it there (as it once did) against replaying the worker's
 * normalization edits. Not a regression test — skipped unless PERF_MAIN and
 * PERF_COMPARE point at .ged files (e.g. the large corpus files); run with a
 * large heap (NODE_OPTIONS=--max-old-space-size=16000) and --silent=false.
 */
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import { buildDataset } from "./gedcom/builder";
import { parseGedcom } from "./gedcom/parser";
import { downloadOptions, serializeGedcom } from "./gedcom/serialize";
import { applyFormatOverrides } from "./normalize/formatOverrides";
import { forestDiff } from "./normalize/forestDiff.testutil";
import { normalizeDataset } from "./normalize/normalize";
import { applyNormPatch, diffNormalized } from "./normalize/normPatch";
import { collectLayoutValues, inferMainProfile } from "./normalize/profile";
import { rebuildIndividual } from "./gedcom/edit/cache";
import type { GedNode } from "./gedcom/types";
import { SerializedMain } from "./persist/serializedMain";
import { LocalLoads } from "./state/localLoad";
import { buildFieldSuggestions, FieldSuggestionIndex } from "./ui/edit/fieldSuggestions";
import { applyRecordsPatch, ChangeJournal, datasetFromSnapshot, mainSnapshot, recordsPatch } from "./state/mainSync";

const mainFile = process.env.PERF_MAIN;
const compareFile = process.env.PERF_COMPARE;

function time<T>(label: string, fn: () => T): T {
  const t0 = performance.now();
  const out = fn();
  console.log(`${label.padEnd(52)} ${(performance.now() - t0).toFixed(0).padStart(7)} ms`);
  return out;
}

const bytes = (path: string): ArrayBuffer => {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
};

describe.skipIf(!mainFile)("main load blocking", () => {
  it("times the longest stretch the main thread is blocked loading the main", async () => {
    const buf = bytes(mainFile!);
    console.log(`main ${mainFile}`);
    const local = new LocalLoads();
    const gaps: number[] = [];
    let last = performance.now();
    let done = false;
    const tick = () => setTimeout(() => {
      const now = performance.now();
      gaps.push(now - last);
      last = now;
      if (!done) tick();
    }, 0);
    let t0 = performance.now();
    tick();
    local.feed(() => {}, { type: "parse", role: "main", fileName: "m.ged", buffer: buf.slice(0) });
    const ds = await local.resolve({ type: "parsed", role: "main", fileName: "m.ged" });
    done = true;
    const worst = gaps.map((g, i) => `${g.toFixed(0)}@${i}`).sort((a, b) => parseFloat(b) - parseFloat(a)).slice(0, 5).join(", ");
    console.log(`after: built ${typeof ds === "object" ? ds.individuals.size : ds} people in ${(performance.now() - t0).toFixed(0)} ms over ${gaps.length} tasks; longest blocks ${worst} ms`);
    t0 = performance.now();
    buildDataset(parseGedcom(buf.slice(0)));
    console.log(`before: copy + parse + build in one task: ${(performance.now() - t0).toFixed(0)} ms`);
  }, 600_000);
});

describe.skipIf(!mainFile)("main sync cost profile", () => {
  it("times handing the main to a worker", () => {
    const main = buildDataset(parseGedcom(bytes(mainFile!)));
    console.log(`main ${mainFile}: ${main.records.length} records`);
    time("structuredClone(dataset)", () => structuredClone(main));
    time("structuredClone(records)", () => structuredClone(main.records));
    time("serializeGedcom (download options)", () => serializeGedcom(main.records, downloadOptions(main)));
    const order = time("record order (xrefs)", () => main.records.map((r) => r.xref ?? ""));
    time("structuredClone(order)", () => structuredClone(order));

    // An edit session touching 20 people, handed to a worker that has the file.
    const changed = new Set([...main.individuals.keys()].slice(0, 20));
    const copy = buildDataset(parseGedcom(bytes(mainFile!)));
    let t0 = performance.now();
    const text = time("before (main thread): serialize for re-feed", () => serializeGedcom(main.records, { eol: main.eol }));
    console.log(`${"BEFORE main thread total".padEnd(52)} ${(performance.now() - t0).toFixed(0).padStart(7)} ms`);
    time("before (worker): parse + build + profile", () =>
      inferMainProfile(buildDataset(parseGedcom(new TextEncoder().encode(text).buffer as ArrayBuffer))));
    t0 = performance.now();
    const patch = time("after (main thread): recordsPatch", () => recordsPatch(main, changed)!);
    const posted = time("after (main thread): structuredClone(patch)", () => structuredClone(patch));
    console.log(`${"AFTER main thread total".padEnd(52)} ${(performance.now() - t0).toFixed(0).padStart(7)} ms`);
    time("after (worker): applyRecordsPatch + profile", () => inferMainProfile(applyRecordsPatch(copy, posted)!));
    t0 = performance.now();
    const snap = time("snapshot (main thread): mainSnapshot", () => mainSnapshot(main));
    time("snapshot (main thread): structuredClone", () => structuredClone(snap));
    console.log(`${"SNAPSHOT main thread total".padEnd(52)} ${(performance.now() - t0).toFixed(0).padStart(7)} ms`);
    time("snapshot (worker): datasetFromSnapshot", () => datasetFromSnapshot(snap));

    // Field suggestions after one person's place edit.
    time("suggestions before: buildFieldSuggestions", () => buildFieldSuggestions(main));
    const sugJournal = new ChangeJournal();
    const sugIndex = new FieldSuggestionIndex();
    time("suggestions after: first build", () => sugIndex.get(main, sugJournal, 0));
    const eventWith = (tag: string) => (raw: GedNode) => raw.children.find((ev) => ev.children.some((c) => c.tag === tag));
    const someone = [...main.individuals.values()].find((i) => eventWith("PLAC")(i.raw))!;
    eventWith("PLAC")(someone.raw)!.children.find((c) => c.tag === "PLAC")!.value = "Novo Mesto, Dolenjska";
    rebuildIndividual(main, someone);
    sugJournal.record(1, [someone.id]);
    time("suggestions after: a place edited", () => sugIndex.get(main, sugJournal, 1));
    const date = eventWith("DATE")(someone.raw)?.children.find((c) => c.tag === "DATE");
    if (date) date.value = "1 JAN 1900";
    rebuildIndividual(main, main.individuals.get(someone.id)!);
    sugJournal.record(2, [someone.id]);
    time("suggestions after: a date edited", () => sugIndex.get(main, sugJournal, 2));

    // A persistence tick after those edits.
    time("persist before: serialize + Blob", () => new Blob([serializeGedcom(main.records, downloadOptions(main))]));
    const journal = new ChangeJournal();
    const cache = new SerializedMain();
    time("persist after: first tick (whole file, chunked)", () => cache.blob(main, journal, 0));
    for (const id of changed) main.individuals.get(id)!.raw.children.push({ level: 1, tag: "NOTE", value: "x", children: [] });
    journal.record(1, changed);
    time("persist after: tick after 20 edited people", () => cache.blob(main, journal, 1));
  }, 600_000);
});

describe.skipIf(!mainFile || !compareFile)("load cost profile", () => {
  it("times the incoming file's main-thread copy", () => {
    const compareBuf = bytes(compareFile!);
    console.log(`main ${mainFile} · incoming ${compareFile}`);
    const profile = applyFormatOverrides(inferMainProfile(buildDataset(parseGedcom(bytes(mainFile!)))), undefined);

    // The worker's side, which both ways share.
    const raw = buildDataset(parseGedcom(compareBuf));
    const normalized = normalizeDataset(raw, profile, collectLayoutValues(raw).dateValues).dataset;
    const patch = time("worker: diffNormalized", () => diffNormalized(raw.records, normalized.records))!;
    console.log(`patch: ${patch.ops.length} op words, ${patch.lens.length} strings, ${patch.objs.length} objects, ${patch.count} records`);

    let t0 = performance.now();
    const before = time("before: parse + build", () => buildDataset(parseGedcom(compareBuf)));
    time("before: normalizeDataset", () => normalizeDataset(before, profile, collectLayoutValues(before).dateValues));
    console.log(`${"BEFORE main thread total".padEnd(52)} ${(performance.now() - t0).toFixed(0).padStart(7)} ms`);

    t0 = performance.now();
    const posted = time("after: receive the patch (structuredClone)", () => structuredClone(patch));
    const parsed = time("after: parse", () => parseGedcom(compareBuf));
    time("after: applyNormPatch", () => {
      if (!applyNormPatch(parsed.records, posted)) throw new Error("patch refused");
    });
    const rebuilt = time("after: build", () => buildDataset(parsed));
    console.log(`${"AFTER main thread total".padEnd(52)} ${(performance.now() - t0).toFixed(0).padStart(7)} ms`);
    console.log(`replayed copy identical: ${forestDiff(normalized.records, rebuilt.records) ?? "yes"}`);
  }, 600_000);
});
