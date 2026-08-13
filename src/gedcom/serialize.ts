import { nowGedcomTime, todayGedcom } from "./chanCrea";
import { firstChild } from "./node";
import { isPointer } from "./uri";
import type { Dataset, GedNode } from "./types";

export interface SerializeOptions {
  /** Line-ending to join with. Defaults to "\n". */
  eol?: string;
  /** Emit a trailing newline after the last line. Defaults to true. */
  finalNewline?: boolean;
  /**
   * Wrap physical lines longer than this many **bytes** by splitting the value
   * across `CONC` continuation lines. GEDCOM 5.5.1 caps a line at 255
   * including the terminator, so downloads pass {@link LINE_LIMIT_551}; leave
   * unset for GEDCOM 7 (no CONC, no limit) and for internal round-trips, which
   * must stay byte-faithful.
   *
   * Bytes, not characters: a line of Slovenian or Greek text carries two bytes
   * per accented letter, and counting characters let a "253-character" line
   * reach 280 bytes — past what strict 5.5.1 readers accept.
   */
  maxLineLength?: number;
}

/**
 * GEDCOM 5.5.1's physical line limit, as content bytes: the spec allows 255
 * including the terminator, and CRLF is the widest terminator we emit.
 */
export const LINE_LIMIT_551 = 253;

/**
 * Render a GEDCOM line tree back to text.
 *
 * The serializer walks the lossless `GedNode` forest and reproduces each line
 * from its `level/xref/tag/value`, so a record that wasn't touched comes out
 * exactly as it went in. That's the foundation of the minimal-diff merge: only
 * the nodes the merge actually changed (or appended) differ in the output, which
 * keeps a before/after diff readable.
 *
 * Depth is taken from the tree position rather than `node.level`, so nodes the
 * merge inserts don't need their `level` field set.
 *
 * GEDCOM `CONC` (continue without a line break) is folded into the value at
 * parse time, but the parser notes where each break fell (`GedNode.conc`), so
 * an untouched value re-emits on exactly the lines it arrived on. Edit it and
 * those positions no longer describe it: the value is then wrapped afresh at
 * `maxLineLength`. Either way a diff of the saved file shows the records you
 * changed and nothing else. Without `maxLineLength` a folded value re-emits as
 * a single line (what the internal parse↔serialize round-trips rely on).
 * `CONT` (line break) round-trips exactly. Tag case is normalized to
 * upper-case.
 */
export function serializeGedcom(records: GedNode[], opts: SerializeOptions = {}): string {
  const eol = opts.eol ?? "\n";
  const lines: string[] = [];
  for (const record of records) emitNode(record, 0, lines, opts.maxLineLength);
  const text = lines.join(eol);
  return opts.finalNewline === false ? text : text + eol;
}

/** Serialize a whole dataset, preserving its source line-ending conventions. */
export function serializeDataset(ds: Dataset): string {
  return serializeGedcom(ds.records, { eol: ds.eol, finalNewline: ds.finalNewline });
}

/**
 * Serialize options for a file leaving the app as a download: the source's
 * line-ending conventions plus, for 5.5.1-family files, CONC re-wrapping at
 * the spec's line limit. GEDCOM 7 output is never wrapped — 7.0 abolished
 * CONC and has no line-length limit. (An "unknown" version is treated as
 * legacy 5.5.x, which is what undeclared exports in practice are.)
 */
export function downloadOptions(
  ds: Pick<Dataset, "eol" | "finalNewline" | "version">,
): SerializeOptions {
  return {
    eol: ds.eol,
    finalNewline: ds.finalNewline,
    maxLineLength: ds.version === "7.0" ? undefined : LINE_LIMIT_551,
  };
}

/**
 * Make the HEAD.CHAR declaration match the bytes a download actually produces.
 *
 * Serialized text always leaves the app UTF-8 encoded (a `Blob` of a JS string
 * is UTF-8), so a file loaded from ANSEL/ANSI/Windows-125x/UTF-16 must not
 * keep its original declaration — other software would trust the header and
 * misdecode every non-ASCII character. Mutates the HEAD record in place;
 * call it on the records about to be downloaded, never as part of plain
 * serialization (round-tripping an unsaved file must stay byte-faithful).
 *
 * A missing CHAR line is only added when the source charset wasn't UTF-8
 * (otherwise the output already reads correctly) and never for GEDCOM 7,
 * which is UTF-8 by definition and defines no CHAR structure.
 */
export function ensureUtf8Charset(
  records: GedNode[],
  ds: Pick<Dataset, "version" | "charset">,
): void {
  const head = records.find((r) => r.tag === "HEAD");
  if (!head) return;
  const char = firstChild(head, "CHAR");
  if (char) {
    if (char.value?.trim().toUpperCase() !== "UTF-8") char.value = "UTF-8";
    return;
  }
  if (ds.version === "7.0" || ds.charset === "UTF-8") return;
  const node: GedNode = { level: 1, tag: "CHAR", value: "UTF-8", children: [] };
  // 5.5.1's header structure places CHAR right after the GEDC block.
  const gedcIdx = head.children.findIndex((c) => c.tag === "GEDC");
  if (gedcIdx >= 0) head.children.splice(gedcIdx + 1, 0, node);
  else head.children.push(node);
}

/**
 * Stamp the header with GED Merge as the producing system: HEAD.SOUR names
 * the software that wrote *this* file (both 5.5.1 and 7.0 define it so), and
 * HEAD.DATE is when it was written. Any previous vendor's SOUR block is
 * replaced whole — its NAME/VERS/CORP describe a program that did not produce
 * these bytes — which is the standard behaviour of every GEDCOM writer.
 *
 * Mutates the HEAD record in place; like {@link ensureUtf8Charset}, call it
 * only on records about to be downloaded, never on plain round-trips.
 */
export function stampHeadSource(
  records: GedNode[],
  ds: Pick<Dataset, "version">,
  date: Date = new Date(),
): void {
  const head = records.find((r) => r.tag === "HEAD");
  if (!head) return;

  const sour: GedNode = {
    level: 1,
    tag: "SOUR",
    value: "GEDMERGE",
    children: [
      { level: 2, tag: "NAME", value: "GED Merge", children: [] },
      { level: 2, tag: "VERS", value: __APP_VERSION__, children: [] },
    ],
  };
  const sourIdx = head.children.findIndex((c) => c.tag === "SOUR");
  if (sourIdx >= 0) {
    head.children[sourIdx] = sour;
  } else if (ds.version === "7.0") {
    // 7.0's header structure requires GEDC first; SOUR follows it.
    const gedcIdx = head.children.findIndex((c) => c.tag === "GEDC");
    head.children.splice(gedcIdx + 1, 0, sour);
  } else {
    // 5.5.1 places SOUR first in HEAD.
    head.children.unshift(sour);
  }

  const dateNode = firstChild(head, "DATE");
  if (dateNode) {
    dateNode.value = todayGedcom(date);
    // Refresh a TIME stamp only when the header already carries one.
    const time = firstChild(dateNode, "TIME");
    if (time) time.value = nowGedcomTime(date);
  } else {
    // Both specs put DATE after SOUR (and DEST, when present).
    const idx = head.children.findIndex((c) => c.tag === "SOUR");
    const destIdx = head.children.findIndex((c) => c.tag === "DEST");
    head.children.splice(Math.max(idx, destIdx) + 1, 0, {
      level: 1,
      tag: "DATE",
      value: todayGedcom(date),
      children: [],
    });
  }
}

function emitNode(node: GedNode, depth: number, lines: string[], maxLen?: number): void {
  // A line the parser couldn't interpret re-emits exactly as it came in —
  // never reformatted, never CONC-wrapped (its structure is unknown).
  if (node.verbatim !== undefined) {
    lines.push(node.verbatim);
    return;
  }

  const head = node.xref
    ? `${depth} ${node.xref} ${node.tag}`
    : `${depth} ${node.tag}`;

  if (node.value === undefined) {
    lines.push(head);
  } else {
    // A folded multi-line value re-splits into CONT continuation lines. An empty
    // first segment means the tag line itself carried no inline value and the
    // text begins on a CONT line (e.g. "0 @N@ NOTE" then "1 CONT ..."), so the
    // head line gets no trailing space.
    const segments = node.value.split("\n");
    // The file's own CONC positions, while they still describe this value.
    const breaks = node.conc?.of === node.value ? node.conc.at : undefined;
    let pos = 0;
    for (let i = 0; i < segments.length; i++) {
      const prefix = i === 0 ? head : `${depth + 1} CONT`;
      const escaped = escapeLeadingAt(segments[i]);
      // Escaping a leading "@" shifts every offset inside this segment by one.
      const shift = escaped.length - segments[i].length;
      pushSegment(lines, prefix, escaped, depth, maxLen, segmentBreaks(breaks, pos, segments[i].length, shift));
      pos += segments[i].length + 1; // + the "\n" the CONT line stands for
    }
  }

  for (const child of node.children) emitNode(child, depth + 1, lines, maxLen);
}

/**
 * Double a leading at-sign (`@` → `@@`) so a text value can't re-read as a
 * pointer in a strict importer — the GEDCOM at-sign escape, applied per
 * physical line (the tag line and each CONT continuation). The parser folds
 * `@@` back to `@`, so escaping is round-trip symmetric. Values that *are*
 * at-sign constructs keep their single `@`: pointers (`@I1@`) and 5.5.1
 * calendar/escape sequences (`@#DJULIAN@ …`).
 */
function escapeLeadingAt(text: string): string {
  if (!text.startsWith("@") || text.startsWith("@#") || isPointer(text)) return text;
  return "@" + text;
}

/**
 * Emit one logical line (`prefix` + segment text), splitting overlong text
 * across `CONC` continuation lines when `maxLen` is set. Applies to the tag
 * line and to each CONT line alike — a single CONT segment can itself exceed
 * the limit.
 */
function pushSegment(
  lines: string[],
  prefix: string,
  text: string,
  depth: number,
  maxLen: number | undefined,
  /** The source's own CONC offsets inside `text`, when they still apply. */
  breaks?: number[],
): void {
  const concPrefix = `${depth + 1} CONC`;
  if (maxLen !== undefined && breaks && breaks.length > 0) {
    const chunks = chunkAt(text, breaks);
    // A record that moved to another depth (or a source line that was already
    // over the limit) must not be reproduced into an invalid line — check
    // before trusting the source's positions, and re-wrap if they don't fit.
    if (chunks && chunks.every((c, i) => fitsLine(i === 0 ? prefix : concPrefix, c, maxLen))) {
      lines.push(chunks[0].length === 0 ? prefix : `${prefix} ${chunks[0]}`);
      for (let i = 1; i < chunks.length; i++) lines.push(`${concPrefix} ${chunks[i]}`);
      return;
    }
  }
  if (text.length === 0) {
    lines.push(prefix);
    return;
  }
  if (maxLen === undefined || fitsLine(prefix, text, maxLen)) {
    lines.push(`${prefix} ${text}`);
    return;
  }
  const chunks = splitForConc(
    text,
    maxLen - utf8Len(prefix) - 1,
    maxLen - utf8Len(concPrefix) - 1,
  );
  lines.push(`${prefix} ${chunks[0]}`);
  for (let i = 1; i < chunks.length; i++) lines.push(`${concPrefix} ${chunks[i]}`);
}

/** The `at` offsets that fall inside one CONT segment, rebased onto it (and
 *  shifted by an at-sign escape the segment picked up). Undefined when the
 *  segment carries no break, so the caller takes the ordinary path. */
function segmentBreaks(
  all: number[] | undefined,
  start: number,
  length: number,
  shift: number,
): number[] | undefined {
  if (!all) return undefined;
  const out: number[] = [];
  for (const at of all) {
    if (at < start || at >= start + length) continue;
    out.push(at === start ? 0 : at - start + shift);
  }
  return out.length > 0 ? out : undefined;
}

/** Cut `text` at the given offsets. Undefined if they don't describe it (out of
 *  range or out of order) — a stale note is never worth a mangled value. */
function chunkAt(text: string, breaks: number[]): string[] | undefined {
  const chunks: string[] = [];
  let start = 0;
  for (const at of breaks) {
    if (at < start || at > text.length) return undefined;
    chunks.push(text.slice(start, at));
    start = at;
  }
  chunks.push(text.slice(start));
  return chunks;
}

/** Whether `prefix` + a space + `text` stays inside the byte limit. */
function fitsLine(prefix: string, text: string, maxLen: number): boolean {
  return utf8Len(prefix) + 1 + utf8Len(text) <= maxLen;
}

/** UTF-8 byte length of a string — what a GEDCOM line limit actually counts. */
function utf8Len(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4; // surrogate pair — counted once, on its lead
      i++;
    } else n += 3;
  }
  return n;
}

/**
 * Split a value into CONC-sized chunks: the first at most `firstAvail`
 * **bytes**, the rest at most `restAvail`. Cut points prefer the middle of a
 * word — readers are permitted to trim spaces around CONC pieces, so neither
 * side of a cut may touch a space — and never land inside a character.
 */
function splitForConc(text: string, firstAvail: number, restAvail: number): string[] {
  // Floor keeps pathological inputs (a prefix near the limit) progressing.
  const first = Math.max(firstAvail, 16);
  const rest = Math.max(restAvail, 16);
  const chunks: string[] = [];
  let start = 0;
  let avail = first;
  while (utf8Len(text.slice(start)) > avail) {
    let cut = cutAtBytes(text, start, avail);
    // Back the cut up to a space-free boundary when one exists in this chunk.
    let c = cut;
    while (c - start > 1 && (text[c] === " " || text[c - 1] === " ")) c--;
    if (text[c] !== " " && text[c - 1] !== " ") cut = c;
    // Never split a surrogate pair (e.g. an emoji) across two lines.
    const u = text.charCodeAt(cut - 1);
    if (u >= 0xd800 && u <= 0xdbff) cut--;
    if (cut <= start) cut = start + 1;
    chunks.push(text.slice(start, cut));
    start = cut;
    avail = rest;
  }
  chunks.push(text.slice(start));
  return chunks;
}

/** The offset just past the last whole character of `text` from `start` that
 *  still fits in `avail` bytes. */
function cutAtBytes(text: string, start: number, avail: number): number {
  let bytes = 0;
  let i = start;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    const isPair = c >= 0xd800 && c <= 0xdbff && i + 1 < text.length;
    const size = c < 0x80 ? 1 : c < 0x800 ? 2 : isPair ? 4 : 3;
    if (bytes + size > avail) break;
    bytes += size;
    i += isPair ? 2 : 1;
  }
  return Math.max(i, start + 1);
}
