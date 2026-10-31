import { buildDatasetSteps } from "../gedcom/builder";
import { decodeGedcom, type DecodeResult } from "../gedcom/decode";
import { parseGedcomSteps } from "../gedcom/parser";
import type { Steps } from "../gedcom/steps";
import type { Dataset, ParseResult } from "../gedcom/types";
import { normalizeDataset } from "../normalize/normalize";
import { applyNormPatch } from "../normalize/normPatch";
import { collectLayoutValues, primePlaceExportFormat } from "../normalize/profile";
import type { MainProfile } from "../normalize/types";
import { consolidateDuplicates } from "../tools/mergeDuplicate";
import type { WorkerRequest, WorkerResponse } from "../worker/messages";

type Parsed = Extract<WorkerResponse, { type: "parsed" }>;

/** What {@link LocalLoads.resolve} answers for an announcement a later load
 *  of the same slot has overtaken while this side was still building it —
 *  not a failure: the newer load's own announcement is on its way. */
export const SUPERSEDED = "superseded";

/** How long one slice of a main-thread build may run before the page gets a
 *  turn to paint and take input. */
const SLICE_MS = 40;

/**
 * The main thread's own copies of the GEDCOM datasets, built from the same
 * bytes the worker parses, so no dataset ever crosses the worker boundary
 * (see `ParseSuccess.dataset` for the measurement behind this).
 *
 * The worker stays the authority on *when* a slot is announced and with which
 * detections; this class mirrors *what* it holds. Every step the worker takes
 * on a GEDCOM dataset is replayed here from the bytes and what the worker
 * posts — parse and build of the bytes, the edits normalizing made (posted as
 * `normalized`, applied to this side's own parse before it is built), the
 * confirmed-default `mergeDuplicate` of consolidated incoming duplicates
 * (posted as `consolidated`) — so the two copies agree record for record.
 *
 * The bytes are decoded here before they are handed to the worker, so the
 * buffer is transferred, not copied; and the parse and build run in slices
 * of {@link SLICE_MS} (a 500k-person file is ~6 s of work), so the page keeps
 * painting while they run. An announcement is answered once its build is done.
 *
 * Memory: the main holds its dataset (as it always did); the compare holds
 * its normalized dataset plus the file's decoded text, parsed afresh whenever
 * a new main means the compare is normalized again.
 */
export class LocalLoads {
  /** The main being built or built, per load. */
  private main: { fileName: string; gen: number; dataset: Promise<Dataset | undefined> } | undefined;
  private mainGen = 0;
  private compareText: { fileName: string; gen: number; decoded: DecodeResult } | undefined;
  /** A parse of the compare's text not yet built (so not yet patched): what
   *  the worker's first announcement of the compare is replayed onto. */
  private compareParsed: { fileName: string; parsed: Promise<ParseResult | undefined> } | undefined;
  private compareGen = 0;
  private profile: MainProfile | undefined;
  /** The compare dataset last resolved — what a consolidation replays onto.
   *  Kept here, not read from React state: the worker posts the compare and
   *  its consolidation back to back, and both can be handled before a render
   *  stores the first. */
  private lastCompare: { fileName: string; dataset: Dataset } | undefined;

  /**
   * Send a request to the worker, and for a GEDCOM `parse` that will be
   * announced, decode its bytes first and start building the same dataset
   * here. Announcements must be resolved in the order they arrive (each
   * awaited before the next), as the app's worker queue does.
   */
  feed(post: (msg: WorkerRequest, transfer?: Transferable[]) => void, msg: WorkerRequest, transfer?: Transferable[]): void {
    if (msg.type === "parseCsv" || msg.type === "clearCompare") this.clearCompare();
    if (msg.type !== "parse" || msg.silent) {
      post(msg, transfer);
      return;
    }
    // Decoded before the bytes are transferred away: the text is what both
    // the parse below and any later re-parse of the compare read.
    let decoded: DecodeResult | undefined;
    try {
      decoded = decodeGedcom(msg.buffer);
    } catch {
      // The worker decodes the same bytes and reports the failure for the slot.
    }
    post(msg, transfer);
    if (msg.role === "main") {
      const gen = ++this.mainGen;
      const alive = () => this.mainGen === gen;
      this.main = {
        fileName: msg.fileName,
        gen,
        dataset: decoded ? buildSliced(decoded, alive) : Promise.resolve(undefined),
      };
      return;
    }
    const gen = ++this.compareGen;
    this.compareText = decoded && { fileName: msg.fileName, gen, decoded };
    // Parsed only: the build waits for the worker's word on how the file was
    // normalized, which is applied to this parse first.
    this.compareParsed = decoded && { fileName: msg.fileName, parsed: this.parseCompare(decoded, gen) };
  }

  /**
   * The dataset a `parsed` message stands for: the message's own (a table
   * compare), the local main, the local compare with the worker's
   * normalization replayed, or the last resolved compare with the announced
   * consolidation replayed.
   * Undefined when the local copy is missing — a parse the worker accepted but
   * this side did not, which the caller reports as a failed slot; and
   * {@link SUPERSEDED} when a newer load of the slot overtook the build.
   */
  async resolve(msg: Parsed): Promise<Dataset | undefined | typeof SUPERSEDED> {
    if (msg.role === "main") return this.resolveMain(msg);
    const gen = this.compareGen;
    const dataset = await this.resolveCompare(msg).catch(() => undefined);
    if (gen !== this.compareGen) return SUPERSEDED;
    this.lastCompare = dataset ? { fileName: msg.fileName, dataset } : undefined;
    return dataset;
  }

  private async resolveMain(msg: Parsed): Promise<Dataset | undefined | typeof SUPERSEDED> {
    this.profile = msg.profile;
    if (msg.dataset) return msg.dataset;
    const local = this.main?.fileName === msg.fileName ? this.main : undefined;
    if (!local) return undefined;
    const main = await local.dataset;
    if (local.gen !== this.mainGen) return SUPERSEDED;
    // The worker already walked the file for its place format; hand the
    // answer to this side's copy so the first place field need not.
    if (main && msg.placeFmt) primePlaceExportFormat(main, msg.placeFmt);
    return main;
  }

  private async resolveCompare(msg: Parsed): Promise<Dataset | undefined> {
    // A compare normalized by the worker names the profile it used: after a
    // silent main re-feed that is the only word this side gets of it.
    if (msg.profile) this.profile = msg.profile;
    if (msg.consolidated) {
      const currentCompare = this.lastCompare?.fileName === msg.fileName ? this.lastCompare.dataset : undefined;
      if (!currentCompare) return undefined;
      consolidateDuplicates(currentCompare, msg.consolidated);
      // A fresh identity, so everything derived from the compare recomputes.
      return { ...currentCompare };
    }
    if (msg.dataset) return msg.dataset;
    const gen = this.compareGen;
    const alive = () => this.compareGen === gen;
    let parsed = await this.freshCompareParse(msg.fileName);
    if (!parsed) return undefined;
    if (msg.normalized) {
      if (applyNormPatch(parsed.records, msg.normalized)) return runSliced(buildDatasetSteps(parsed), alive);
      // Not the forest the edits were made against — never expected, as both
      // sides parse the same bytes. Normalize here instead, as a fallback.
      parsed = await this.freshCompareParse(msg.fileName);
      if (!parsed) return undefined;
    }
    const raw = await runSliced(buildDatasetSteps(parsed), alive);
    // No main yet: announced raw, as the worker does.
    if (!raw || !msg.report || !this.profile) return raw;
    const { dateValues } = collectLayoutValues(raw);
    return normalizeDataset(raw, this.profile, dateValues).dataset;
  }

  private parseCompare(decoded: DecodeResult, gen: number): Promise<ParseResult | undefined> {
    return runSliced(parseGedcomSteps(decoded), () => this.compareGen === gen).catch(() => undefined);
  }

  /** A parse of the compare's text no build has touched yet — the one taken
   *  at load time, once, and a new one from the kept text after that. */
  private freshCompareParse(fileName: string): Promise<ParseResult | undefined> {
    const kept = this.compareParsed;
    this.compareParsed = undefined;
    if (kept?.fileName === fileName) return kept.parsed;
    const text = this.compareText;
    if (text?.fileName !== fileName) return Promise.resolve(undefined);
    return this.parseCompare(text.decoded, text.gen);
  }

  /** Forget the compare (the slot was unloaded or replaced by a table). */
  clearCompare(): void {
    this.compareGen++;
    this.compareText = undefined;
    this.compareParsed = undefined;
    this.lastCompare = undefined;
  }
}

/** Parse and build decoded text in slices; undefined when it fails or a
 *  newer load overtakes it (`alive` turns false). */
function buildSliced(decoded: DecodeResult, alive: () => boolean): Promise<Dataset | undefined> {
  return (async () => {
    const parsed = await runSliced(parseGedcomSteps(decoded), alive);
    return parsed && runSliced(buildDatasetSteps(parsed), alive);
  })().catch(() => undefined);
}

/**
 * Run a stepped pass (see `gedcom/steps.ts`) in slices of {@link SLICE_MS},
 * giving the page a turn between them. Undefined once `alive` turns false.
 * The first slice runs at once, in the caller's task.
 */
async function runSliced<T>(steps: Steps<T>, alive: () => boolean): Promise<T | undefined> {
  let deadline = performance.now() + SLICE_MS;
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
    if (performance.now() < deadline) continue;
    await nextTask();
    if (!alive()) return undefined;
    deadline = performance.now() + SLICE_MS;
  }
}

/** Resolve in a later task, so rendering and input get their turn. A message
 *  to ourselves rather than a timer: nested timers are clamped to 4 ms, which
 *  over a few hundred slices adds up. */
function nextTask(): Promise<void> {
  if (typeof MessageChannel === "undefined" || typeof document === "undefined") {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => {
      port1.close();
      resolve();
    };
    port2.postMessage(undefined);
  });
}

