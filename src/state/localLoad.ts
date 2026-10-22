import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import type { Dataset, ParseResult } from "../gedcom/types";
import { normalizeDataset } from "../normalize/normalize";
import { applyNormPatch } from "../normalize/normPatch";
import { collectLayoutValues, primePlaceExportFormat } from "../normalize/profile";
import type { MainProfile } from "../normalize/types";
import { mergeDuplicate } from "../tools/mergeDuplicate";
import type { DatasetRole, WorkerRequest, WorkerResponse } from "../worker/messages";

type Parsed = Extract<WorkerResponse, { type: "parsed" }>;

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
 * Memory: the main holds its dataset (as it always did); the compare holds
 * its normalized dataset plus the file's bytes, parsed afresh whenever a new
 * main means the compare is normalized again. The parse taken at load time is
 * dropped once it has been built.
 */
export class LocalLoads {
  private main: { fileName: string; dataset: Dataset } | undefined;
  private compareBytes: { fileName: string; buffer: ArrayBuffer } | undefined;
  /** A parse of the compare's bytes not yet built (so not yet patched): what
   *  the worker's first announcement of the compare is replayed onto. */
  private compareParsed: { fileName: string; parsed: ParseResult } | undefined;
  private profile: MainProfile | undefined;
  /** The compare dataset last resolved — what a consolidation replays onto.
   *  Kept here, not read from React state: the worker posts the compare and
   *  its consolidation back to back, and both can be handled before a render
   *  stores the first. */
  private lastCompare: { fileName: string; dataset: Dataset } | undefined;

  /**
   * Send a request to the worker, and for a GEDCOM `parse` that will be
   * announced, build the same dataset here first — synchronously, so the
   * worker's `parsed` cannot be handled before the local copy exists. The
   * buffer is copied before it is transferred away.
   */
  feed(post: (msg: WorkerRequest, transfer?: Transferable[]) => void, msg: WorkerRequest, transfer?: Transferable[]): void {
    if (msg.type === "parseCsv" || msg.type === "clearCompare") this.clearCompare();
    if (msg.type !== "parse" || msg.silent) {
      post(msg, transfer);
      return;
    }
    const copy = msg.buffer.slice(0);
    post(msg, transfer);
    this.build(msg.role, msg.fileName, copy);
  }

  /** Build the local dataset for a GEDCOM parse request (see {@link feed}). */
  build(role: DatasetRole, fileName: string, buffer: ArrayBuffer): void {
    if (role === "compare") {
      // Parsed only: the build waits for the worker's word on how the file
      // was normalized, which is applied to this parse first.
      this.compareBytes = { fileName, buffer };
      this.compareParsed = undefined;
      try {
        this.compareParsed = { fileName, parsed: parseGedcom(buffer) };
      } catch {
        // The worker parses the same bytes and reports the failure for the slot.
      }
      return;
    }
    try {
      this.main = { fileName, dataset: buildDataset(parseGedcom(buffer)) };
    } catch {
      this.main = undefined; // as above
    }
  }

  /**
   * The dataset a `parsed` message stands for: the message's own (a table
   * compare), the local main, the local compare with the worker's
   * normalization replayed, or the last resolved compare with the announced
   * consolidation replayed.
   * Undefined when the local copy is missing — a parse the worker accepted but
   * this side did not, which the caller reports as a failed slot.
   */
  resolve(msg: Parsed): Dataset | undefined {
    if (msg.role === "main") return this.resolveMain(msg);
    const dataset = this.resolveCompare(msg);
    this.lastCompare = dataset ? { fileName: msg.fileName, dataset } : undefined;
    return dataset;
  }

  private resolveMain(msg: Parsed): Dataset | undefined {
    this.profile = msg.profile;
    if (msg.dataset) return msg.dataset;
    const main = this.main?.fileName === msg.fileName ? this.main.dataset : undefined;
    // The worker already walked the file for its place format; hand the
    // answer to this side's copy so the first place field need not.
    if (main && msg.placeFmt) primePlaceExportFormat(main, msg.placeFmt);
    return main;
  }

  private resolveCompare(msg: Parsed): Dataset | undefined {
    // A compare normalized by the worker names the profile it used: after a
    // silent main re-feed that is the only word this side gets of it.
    if (msg.profile) this.profile = msg.profile;
    if (msg.consolidated) {
      const currentCompare = this.lastCompare?.fileName === msg.fileName ? this.lastCompare.dataset : undefined;
      if (!currentCompare) return undefined;
      for (const { keepId, mergeIds } of msg.consolidated) {
        for (const id of mergeIds) mergeDuplicate(currentCompare, keepId, id, { status: "confirmed", fields: {} }, rawLabel);
      }
      // A fresh identity, so everything derived from the compare recomputes.
      return { ...currentCompare };
    }
    if (msg.dataset) return msg.dataset;
    let parsed = this.freshCompareParse(msg.fileName);
    if (!parsed) return undefined;
    if (msg.normalized) {
      if (applyNormPatch(parsed.records, msg.normalized)) return buildDataset(parsed);
      // Not the forest the edits were made against — never expected, as both
      // sides parse the same bytes. Normalize here instead, as a fallback.
      parsed = this.freshCompareParse(msg.fileName);
      if (!parsed) return undefined;
    }
    const raw = buildDataset(parsed);
    // No main yet: announced raw, as the worker does.
    if (!msg.report || !this.profile) return raw;
    const { dateValues } = collectLayoutValues(raw);
    return normalizeDataset(raw, this.profile, dateValues).dataset;
  }

  /** A parse of the compare's bytes no build has touched yet — the one taken
   *  at load time, once, and a new one from the kept bytes after that. */
  private freshCompareParse(fileName: string): ParseResult | undefined {
    const kept = this.compareParsed;
    this.compareParsed = undefined;
    if (kept?.fileName === fileName) return kept.parsed;
    if (this.compareBytes?.fileName !== fileName) return undefined;
    try {
      return parseGedcom(this.compareBytes.buffer);
    } catch {
      return undefined;
    }
  }

  /** Forget the compare (the slot was unloaded or replaced by a table). */
  clearCompare(): void {
    this.compareBytes = undefined;
    this.compareParsed = undefined;
    this.lastCompare = undefined;
  }
}

/** The worker merges with a no-op translator (it has no i18n); the replay must
 *  write the very same text. */
const rawLabel = (key: string) => key;
