import { downloadOptions, serializeGedcom } from "../gedcom/serialize";
import type { Dataset, GedNode } from "../gedcom/types";
import type { ChangeJournal, SyncMark } from "../state/mainSync";

/** Records per chunk: small enough that re-serializing one is a few
 *  milliseconds, large enough that a big file is a few hundred chunks. */
const CHUNK = 2000;

const BOM = String.fromCharCode(0xfeff);

interface Chunk {
  /** The records serialized, by identity — a chunk is reused only while the
   *  same record objects still stand at its place. */
  refs: GedNode[];
  /** Their lines joined by the file's line ending, with none at the end. */
  blob: Blob;
}

/**
 * The main file's download serialization as a Blob, kept between persistence
 * ticks in chunks of records so a tick re-serializes only the chunks holding
 * records changed since the last one.
 *
 * Serializing the whole main on the main thread after every edit pause cost
 * ~1.5 s on a 500k-person file. Serialization is record-local (each record's
 * lines depend on that record alone), so the file is the chunks' text joined
 * by the line ending — byte for byte what `serializeGedcom` writes for the
 * whole forest, the optional byte-order mark ahead and final line ending
 * behind.
 *
 * Which records changed comes from the change journal (an edited record keeps
 * its object, so identity alone cannot tell); records added, removed or moved
 * show by identity. A different dataset, other options, or a change the
 * journal cannot name serializes everything again.
 */
export class SerializedMain {
  private dataset: Dataset | undefined;
  private optsKey = "";
  private mark: SyncMark | undefined;
  private chunks: Chunk[] = [];

  /** The serialization of `ds` as it is now, which is at edit `version`. */
  blob(ds: Dataset, journal: ChangeJournal, version: number): Blob {
    const opts = downloadOptions(ds);
    const optsKey = `${opts.eol}|${opts.maxLineLength}`;
    const dirty = ds === this.dataset && optsKey === this.optsKey ? journal.since(this.mark) : null;
    const reusable = dirty ? this.chunks : [];
    const byFirst = new Map<GedNode, Chunk>();
    for (const c of reusable) byFirst.set(c.refs[0], c);

    const records = ds.records;
    const chunks: Chunk[] = [];
    const chunkOpts = { ...opts, bom: false, finalNewline: false };
    let i = 0;
    while (i < records.length) {
      const old = byFirst.get(records[i]);
      if (old && dirty && fits(old.refs, records, i, dirty)) {
        chunks.push(old);
        i += old.refs.length;
        continue;
      }
      // A new chunk, up to the next record that starts an old one.
      const refs = [records[i]];
      for (let k = i + 1; k < records.length && refs.length < CHUNK && !byFirst.has(records[k]); k++) refs.push(records[k]);
      chunks.push({ refs, blob: new Blob([serializeGedcom(refs, chunkOpts)]) });
      i += refs.length;
    }

    this.dataset = ds;
    this.optsKey = optsKey;
    this.mark = journal.mark(version);
    this.chunks = chunks;

    const eol = opts.eol ?? "\n";
    const parts: (Blob | string)[] = opts.bom ? [BOM] : [];
    chunks.forEach((c, n) => {
      if (n) parts.push(eol);
      parts.push(c.blob);
    });
    if (opts.finalNewline !== false) parts.push(eol);
    return new Blob(parts);
  }
}

/** Whether `refs` still stand at `records[at…]`, none of them changed. */
function fits(refs: GedNode[], records: GedNode[], at: number, dirty: ReadonlySet<string>): boolean {
  if (at + refs.length > records.length) return false;
  for (let j = 0; j < refs.length; j++) {
    const r = refs[j];
    if (records[at + j] !== r || (r.xref && dirty.has(r.xref))) return false;
  }
  return true;
}
