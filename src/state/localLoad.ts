import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import type { Dataset } from "../gedcom/types";
import { normalizeDataset } from "../normalize/normalize";
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
 * on a GEDCOM dataset is a pure function of inputs the main thread has too —
 * parse and build of the bytes, `normalizeDataset` against the main profile
 * (posted with the main's `parsed`), the confirmed-default `mergeDuplicate`
 * of consolidated incoming duplicates (posted as `consolidated`) — so the two
 * copies agree record for record.
 *
 * Memory: the main holds its dataset (as it always did); the compare holds
 * its normalized dataset plus the file's bytes, from which a raw dataset is
 * rebuilt whenever a new main means the compare must normalize again. The
 * raw compare built at load time is dropped once normalized.
 */
export class LocalLoads {
  private main: { fileName: string; dataset: Dataset } | undefined;
  private compareBytes: { fileName: string; buffer: ArrayBuffer } | undefined;
  private compareRaw: { fileName: string; dataset: Dataset } | undefined;
  private profile: MainProfile | undefined;

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
      this.compareBytes = { fileName, buffer };
      this.compareRaw = undefined;
    }
    let dataset: Dataset;
    try {
      dataset = buildDataset(parseGedcom(buffer));
    } catch {
      // The worker parses the same bytes and reports the failure for the slot.
      if (role === "main") this.main = undefined;
      return;
    }
    if (role === "main") this.main = { fileName, dataset };
    else this.compareRaw = { fileName, dataset };
  }

  /**
   * The dataset a `parsed` message stands for: the message's own (a table
   * compare), the local main, the local compare normalized to the profile, or
   * the current compare with the announced consolidation replayed. Undefined
   * when the local copy is missing — a parse the worker accepted but this side
   * did not, which the caller reports as a failed slot.
   */
  resolve(msg: Parsed, currentCompare: Dataset | undefined): Dataset | undefined {
    if (msg.role === "main") {
      this.profile = msg.profile;
      if (msg.dataset) return msg.dataset;
      const main = this.main?.fileName === msg.fileName ? this.main.dataset : undefined;
      // The worker already walked the file for its place format; hand the
      // answer to this side's copy so the first place field need not.
      if (main && msg.placeFmt) primePlaceExportFormat(main, msg.placeFmt);
      return main;
    }
    if (msg.consolidated) {
      if (!currentCompare) return undefined;
      for (const { keepId, mergeIds } of msg.consolidated) {
        for (const id of mergeIds) mergeDuplicate(currentCompare, keepId, id, { status: "confirmed", fields: {} }, rawLabel);
      }
      // A fresh identity, so everything derived from the compare recomputes.
      return { ...currentCompare };
    }
    if (msg.dataset) return msg.dataset;
    const raw = this.rawCompare(msg.fileName);
    if (!raw) return undefined;
    if (!this.profile) return raw; // no main yet: announced raw, as the worker does
    const { dateValues } = collectLayoutValues(raw);
    const { dataset } = normalizeDataset(raw, this.profile, dateValues);
    this.compareRaw = undefined; // rebuilt from the bytes if a later main needs it
    return dataset;
  }

  private rawCompare(fileName: string): Dataset | undefined {
    if (this.compareRaw?.fileName === fileName) return this.compareRaw.dataset;
    if (this.compareBytes?.fileName !== fileName) return undefined;
    try {
      const dataset = buildDataset(parseGedcom(this.compareBytes.buffer));
      this.compareRaw = { fileName, dataset };
      return dataset;
    } catch {
      return undefined;
    }
  }

  /** Forget the compare (the slot was unloaded or replaced by a table). */
  clearCompare(): void {
    this.compareBytes = undefined;
    this.compareRaw = undefined;
  }
}

/** The worker merges with a no-op translator (it has no i18n); the replay must
 *  write the very same text. */
const rawLabel = (key: string) => key;
