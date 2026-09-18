import { serializeGedcom, type SerializeOptions } from "../gedcom/serialize";
import type { GedNode } from "../gedcom/types";

/**
 * A record's before/after as GEDCOM lines — the save preview's second reading of
 * the same change.
 *
 * The field rows say what a change *means* ("Birth date: 1880 → 1881"); this
 * says what the file will literally receive, in the lines the next program to
 * open it will read. Both are built from the same two trees: the record as it
 * stands in the save's output forest, and the record as it was before this
 * session touched it (a merge clones, and the editor snapshots every record on
 * its first patch — see `buildSavePreview`).
 *
 * The context around a change is its **ancestor lines**, not a count of
 * neighbouring lines: a changed `2 DATE` is shown under the `1 BIRT` that owns
 * it and the `0 @I1@ INDI` that owns that. `diff -U3` can only guess at the
 * structure from the text; here the levels say it outright, so the reader never
 * has to count lines to find out which event a date belongs to.
 *
 * What the preview cannot show is the CHAN/`_UPD` stamps: those are written
 * after this dialog is confirmed (see `handleConfirmSave`), and a bookkeeping
 * line the user didn't ask for would be noise in every single hunk.
 */
export type DiffLineKind = "add" | "del" | "same" | "gap";

export interface DiffLine {
  kind: DiffLineKind;
  /** The GEDCOM line, verbatim. Empty for a `gap`. */
  text: string;
}

export interface RecordDiff {
  lines: DiffLine[];
  added: number;
  removed: number;
  /** The record was too large to align line by line, so its two versions are
   *  shown whole rather than interleaved. */
  coarse?: boolean;
}

/**
 * Cap on the alignment table, in cells. A record's two versions differ by a
 * handful of lines, so the trimmed middle is normally tiny; the cap is there
 * for the pathological case (a person carrying thousands of note lines,
 * rewritten wholesale) where an exact alignment would cost more than it is
 * worth to a reader who is looking at a wall of changed lines either way.
 */
const MAX_CELLS = 250_000;

interface Op {
  kind: "same" | "del" | "add";
  text: string;
  /** Index in the before-lines, for `same`/`del`. */
  ai: number;
  /** Index in the after-lines, for `same`/`add`. */
  bi: number;
}

/** Split a record into the physical lines the download would write for it. */
function recordLines(node: GedNode, opts: SerializeOptions): string[] {
  const eol = opts.eol ?? "\n";
  // A record is serialized on its own, so no BOM and no trailing blank line:
  // both belong to the file, not to this record.
  const text = serializeGedcom([node], { ...opts, bom: false, finalNewline: false });
  return text.length === 0 ? [] : text.split(eol);
}

/** A GEDCOM line's level, from the digits it opens with (-1 if it has none —
 *  which serialized output never produces, but a guard costs nothing). */
function levelOf(line: string): number {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
  return i === 0 ? -1 : Number(line.slice(0, i));
}

/**
 * For each line, the index of the line that owns it: the nearest line above it
 * at a lower level. `-1` for a level-0 line (a record's own head).
 */
function ownerIndex(lines: string[]): Int32Array {
  const owner = new Int32Array(lines.length);
  // The last line seen at each level: serialized output steps one level at a
  // time, so a line's owner is simply the last one a level above it. Kept as a
  // table rather than a scan back up the record — a note of a thousand CONT
  // lines would make that scan quadratic.
  const lastAtLevel: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const level = levelOf(lines[i]);
    let parent = -1;
    for (let l = level - 1; l >= 0; l--) {
      if (lastAtLevel[l] !== undefined) { parent = lastAtLevel[l]; break; }
    }
    owner[i] = parent;
    if (level >= 0) lastAtLevel[level] = i;
  }
  return owner;
}

/** Longest-common-subsequence alignment of two line arrays, with the common
 *  head and tail trimmed first so the table only covers what actually moved. */
function alignLines(a: string[], b: string[]): { ops: Op[]; coarse: boolean } {
  const ops: Op[] = [];
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) {
    ops.push({ kind: "same", text: a[head], ai: head, bi: head });
    head++;
  }
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

  const aMid = a.slice(head, a.length - tail);
  const bMid = b.slice(head, b.length - tail);
  const coarse = aMid.length * bMid.length > MAX_CELLS;

  if (coarse) {
    aMid.forEach((text, i) => ops.push({ kind: "del", text, ai: head + i, bi: -1 }));
    bMid.forEach((text, i) => ops.push({ kind: "add", text, ai: -1, bi: head + i }));
  } else {
    const n = aMid.length;
    const m = bMid.length;
    // lcs[i * (m + 1) + j] = length of the longest common subsequence of
    // aMid[i…] and bMid[j…], filled from the end so the walk below can go
    // forward and emit in file order.
    const lcs = new Int32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * (m + 1) + j] = aMid[i] === bMid[j]
          ? lcs[(i + 1) * (m + 1) + j + 1] + 1
          : Math.max(lcs[(i + 1) * (m + 1) + j], lcs[i * (m + 1) + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (aMid[i] === bMid[j]) {
        ops.push({ kind: "same", text: aMid[i], ai: head + i, bi: head + j });
        i++; j++;
      } else if (lcs[(i + 1) * (m + 1) + j] >= lcs[i * (m + 1) + j + 1]) {
        // A removal ahead of an addition, so a rewritten line reads as the old
        // value struck out and the new one under it.
        ops.push({ kind: "del", text: aMid[i], ai: head + i, bi: -1 });
        i++;
      } else {
        ops.push({ kind: "add", text: bMid[j], ai: -1, bi: head + j });
        j++;
      }
    }
    while (i < n) { ops.push({ kind: "del", text: aMid[i], ai: head + i, bi: -1 }); i++; }
    while (j < m) { ops.push({ kind: "add", text: bMid[j], ai: -1, bi: head + j }); j++; }
  }

  for (let k = 0; k < tail; k++) {
    ops.push({ kind: "same", text: a[a.length - tail + k], ai: a.length - tail + k, bi: b.length - tail + k });
  }
  return { ops, coarse };
}

/**
 * The lines one record contributes to the save, as a diff.
 *
 * `before` missing means the record is new (every line is an addition);
 * `after` missing means the save drops it (every line is a removal). Both
 * present and equal gives an empty diff — the caller can take that as "this
 * record leaves exactly as it came".
 */
export function diffRecord(
  before: GedNode | undefined,
  after: GedNode | undefined,
  opts: SerializeOptions = {},
): RecordDiff {
  const a = before ? recordLines(before, opts) : [];
  const b = after ? recordLines(after, opts) : [];

  if (!before || !after) {
    const kind: DiffLineKind = before ? "del" : "add";
    const lines = (before ? a : b).map((text) => ({ kind, text }));
    return { lines, added: before ? 0 : lines.length, removed: before ? lines.length : 0 };
  }

  const { ops, coarse } = alignLines(a, b);
  const changed = ops.some((o) => o.kind !== "same");
  if (!changed) return { lines: [], added: 0, removed: 0 };

  // Which unchanged lines earn their place: the ancestors of every changed
  // line, on the side that line lives on.
  const aOwner = ownerIndex(a);
  const bOwner = ownerIndex(b);
  const opAtA = new Map<number, number>();
  const opAtB = new Map<number, number>();
  ops.forEach((op, k) => {
    if (op.ai >= 0) opAtA.set(op.ai, k);
    if (op.bi >= 0) opAtB.set(op.bi, k);
  });

  const keep = new Set<number>();
  const markAncestors = (index: number, owner: Int32Array, opAt: Map<number, number>) => {
    for (let i = owner[index]; i >= 0; i = owner[i]) {
      const k = opAt.get(i);
      if (k === undefined) break;
      // Already kept: so are the lines above it, walked when it was marked.
      if (keep.has(k)) break;
      keep.add(k);
    }
  };
  ops.forEach((op, k) => {
    if (op.kind === "same") return;
    keep.add(k);
    if (op.kind === "del") markAncestors(op.ai, aOwner, opAtA);
    else markAncestors(op.bi, bOwner, opAtB);
  });

  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let skipped = false;
  let lastLevel = -1;
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    if (!keep.has(k)) { skipped = true; continue; }
    const level = levelOf(op.text);
    // A gap says the reader has been moved to another part of the record. Going
    // *deeper* than the last line shown is not that move: it is the walk down
    // the owning tags to the change itself (INDI → BIRT → DATE), and the lines
    // stepped over on the way are the person's other tags, which the hunk is
    // not about. Coming back out to the same level or shallower is a jump, and
    // there the gap is the whole point. Never before the first line shown.
    if (skipped && lines.length > 0 && level <= lastLevel) lines.push({ kind: "gap", text: "" });
    skipped = false;
    lastLevel = level;
    lines.push({ kind: op.kind, text: op.text });
    if (op.kind === "add") added++;
    else if (op.kind === "del") removed++;
  }
  return { lines, added, removed, ...(coarse ? { coarse: true } : {}) };
}

/** Index a record forest by xref — the save's output side, looked up per card. */
export function recordsByXref(records: GedNode[]): Map<string, GedNode> {
  const map = new Map<string, GedNode>();
  for (const r of records) if (r.xref) map.set(r.xref, r);
  return map;
}
