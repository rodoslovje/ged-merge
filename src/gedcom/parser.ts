import { decodeGedcom, type DecodeResult } from "./decode";
import { runSteps, type Steps } from "./steps";
import { isPointer } from "./uri";
import type { GedNode, GedcomVersion, ParseResult, ParseWarning } from "./types";

// Leading whitespace is tolerated: 5.5.1 asks readers to accept an indented
// line, and some exporters indent by level. Without it every line of such a
// file was kept verbatim and the file read as empty.
const LINE_RE = /^\s*(\d+)\s+(?:(@[^@]+@)\s+)?([A-Za-z0-9_.]+)(?:\s(.*))?$/;

/** The message of the error `parseGedcom` throws for bytes that are not a
 *  GEDCOM file at all. Only the message crosses the worker boundary, so the
 *  main thread recognises the case by it (and shows a translated line). */
export const NOT_GEDCOM = "not-gedcom";

/**
 * Parse raw GEDCOM bytes into a lossless line tree (`ParseResult`).
 *
 * Steps: decode bytes → split into lines → match each line → assemble the tree
 * by tracking a stack indexed by level → fold CONT/CONC into parent values.
 */
export function parseGedcom(buffer: ArrayBuffer): ParseResult {
  return parseGedcomText(decodeGedcom(buffer));
}

/**
 * Parse GEDCOM text already decoded — by {@link parseGedcom}, or text this app
 * serialized itself (a worker handed the main file as text), which `charset`
 * and `bom` then describe as the file it came from.
 */
export function parseGedcomText(decoded: DecodeResult): ParseResult {
  return runSteps(parseGedcomSteps(decoded));
}

/** Text split into lines at a time by {@link parseGedcomSteps}, which yields
 *  between pieces: about 1 MB, some 40 000 lines. */
const CHUNK_CHARS = 1 << 20;

const EOL_RE = /\r\n?|\n/;

/**
 * The lines of `text` from `pos` up to the first line break at least
 * {@link CHUNK_CHARS} on, the position after that break, and whether any text
 * follows. Joined, the pieces are the lines `text.split(EOL_RE)` gives: a cut
 * falls just after a "\n", so a "\r\n" is never parted, and the empty line
 * the split leaves after a piece's last break is dropped (the text goes on).
 */
function nextLines(text: string, pos: number): [string[], number, boolean] {
  const nl = pos + CHUNK_CHARS < text.length ? text.indexOf("\n", pos + CHUNK_CHARS) : -1;
  if (nl < 0) return [text.slice(pos).split(EOL_RE), text.length, false];
  const lines = text.slice(pos, nl + 1).split(EOL_RE);
  lines.pop();
  return [lines, nl + 1, true];
}

/** {@link parseGedcomText} as a stepped pass (see `steps.ts`), yielding after
 *  every {@link CHUNK_CHARS} of text — what the main thread runs in slices. */
export function* parseGedcomSteps(decoded: DecodeResult): Steps<ParseResult> {
  const { text, charset, warnings: decodeWarnings, bom } = decoded;
  const warnings: ParseWarning[] = [...decodeWarnings];

  // Remember the source's line-ending style and whether it ended with a newline
  // so the serializer can round-trip byte-faithfully (clean before/after diffs).
  // Classic-Mac CR-only endings (e.g. Reunion exports) must be recognised too,
  // otherwise their lines would be re-joined with LF on save.
  const eol = text.includes("\r\n") ? "\r\n" : text.includes("\r") && !text.includes("\n") ? "\r" : "\n";
  const finalNewline = /[\r\n]$/.test(text);
  // The at-sign escape depends on the version, and every line is decoded as
  // it is read — so the header's declaration is looked up first.
  const legacyAt = !/^7\./.test(declaredVersion(text) ?? "");

  // Split on any line ending (\r\n, lone \r, or \n) — directly, which avoids
  // allocating a full normalized copy of the text first, and a piece at a time
  // (nextLines): splitting a 95 MB file at once held the main thread ~0.5 s.
  let lines: string[] = [];
  let first = 0; // the line number of lines[0], from 0
  let pos = 0; // where the text not yet split starts
  let more = true;

  const roots: GedNode[] = [];
  // stack[level] holds the most recent node opened at that level.
  const stack: GedNode[] = [];

  // Some exporters (MyHeritage in particular) paste free text — census
  // transcriptions, newspaper excerpts — into a TEXT/NOTE value and forget to
  // re-encode the text's own embedded line breaks as CONT/CONC: the break
  // just becomes a bare physical line with no level/tag prefix, which isn't
  // valid GEDCOM syntax. `textBlob` tracks the node whose value is "in
  // progress" (its own line, or a CONT/CONC continuation of it), so a line
  // that fails to fit the tree for that reason gets folded back into the
  // value it clearly belongs to instead of being flagged and detached.
  // Cleared on any well-formed non-CONT/CONC line.
  let textBlob: GedNode | undefined;
  // Values with a line that doubles its at-signs: never written back bare.
  const atMixed = new WeakSet<GedNode>();

  for (let i = 0; ; i++) {
    if (i - first >= lines.length) {
      if (!more) break;
      if (i) yield;
      first = i;
      [lines, pos, more] = nextLines(text, pos);
      if (!lines.length) break;
    }
    const line = lines[i - first];
    if (line.trim() === "") continue;

    const m = LINE_RE.exec(line);
    if (!m) {
      if (textBlob) {
        textBlob.value = (textBlob.value ?? "") + "\n" + line;
        continue;
      }
      warnings.push({ kind: "syntax", message: `Unparsable line (kept verbatim): ${truncate(line)}`, line: i + 1 });
      // Keep the line losslessly: attach a verbatim node at the current point
      // in the stream (the deepest open node's children, or the root list), so
      // depth-first serialization re-emits it at exactly its original position.
      const raw: GedNode = { level: 0, tag: "", children: [], verbatim: line };
      let parent: GedNode | undefined;
      for (let l = stack.length - 1; l >= 0 && !parent; l--) parent = stack[l];
      if (parent) parent.children.push(raw);
      else roots.push(raw);
      continue;
    }

    const level = Number(m[1]);
    const xref = m[2];
    const tag = m[3].toUpperCase();
    const spelling = m[3] !== tag ? m[3] : undefined;
    let value = m[4];
    // GEDCOM writes a literal at-sign as `@@` so text cannot read as a
    // pointer. 5.5.x doubles every one (`ana@@example.si`); 7.0 only a
    // leading one, and reads any later `@@` as two at-signs. Fold each back
    // by its version's rule; the serializer re-doubles by the same rule (see
    // `atEscapeFor`), so a valid file still round-trips byte-faithfully.
    // A 5.5.x file that writes its at-signs bare (`ana@example.si`, as many
    // exporters do) is remembered as such, so an untouched value saves the way
    // it was read (see `GedNode.atBare`).
    const atStyle = legacyAt && value !== undefined ? atStyleOf(value) : undefined;
    if (value !== undefined && value.includes("@@")) {
      value = legacyAt ? value.replace(/@@/g, "@") : value.startsWith("@@") ? value.slice(1) : value;
    }

    // CONT (new line) and CONC (no separator) extend the parent's value.
    if (tag === "CONT" || tag === "CONC") {
      let parent: GedNode | undefined = stack[level - 1];
      // A continuation at the wrong level still continues the text above it.
      // Taken at its level, `1 NOTE first` / `1 CONT second` would append to
      // the INDI record's own (empty) value, and a `3 CONT` under a level-1
      // NOTE would find no parent at all; either way the text leaves the note.
      // It is misleveled when it misses the text being continued, or — with no
      // such text in progress — lands on a valueless line that is not the one
      // just above it. The serializer writes it back at its parent's level.
      const misleveled = !parent ||
        (textBlob ? parent !== textBlob : parent !== stack[stack.length - 1] && parent.value === undefined);
      if (misleveled) {
        let target = textBlob;
        for (let l = stack.length - 1; l >= 0 && !target; l--) {
          if (stack[l]?.value !== undefined) target = stack[l];
        }
        if (!target) {
          warnings.push({ kind: "structure", message: `${tag} with no parent`, line: i + 1 });
          continue;
        }
        warnings.push({
          kind: "structure",
          message: `${tag} at level ${level} does not fit the line above it; attached to the ${target.tag} line it continues.`,
          line: i + 1,
        });
        parent = target;
      }
      const sep = tag === "CONT" ? "\n" : "";
      const before = parent.value ?? "";
      parent.value = before + sep + (value ?? "");
      // Remember where a CONC broke the value, so saving an untouched record
      // reproduces the file's own wrapping instead of re-flowing it (see
      // `GedNode.conc`). CONT needs no note: it is the "\n" in the value, and
      // the serializer splits on that anyway. `of` is re-pointed at the value
      // as it grows, so it ends up being the finished string.
      if (tag === "CONC") {
        const at = parent.conc?.at ?? [];
        at.push(before.length);
        parent.conc = { at, of: parent.value };
      } else if (parent.conc) {
        // A CONT after a CONC grows the value the offsets were measured
        // against; re-point `of` or they would read as stale.
        parent.conc = { at: parent.conc.at, of: parent.value };
      }
      if (atStyle === "doubled" || atMixed.has(parent)) {
        atMixed.add(parent);
        delete parent.atBare;
      } else if (atStyle === "bare" || parent.atBare !== undefined) {
        parent.atBare = parent.value;
      }
      textBlob = parent;
      continue;
    }

    const node: GedNode = { level, tag, children: [] };
    if (xref) node.xref = xref;
    if (value !== undefined) node.value = value;
    if (spelling) node.spelling = spelling;
    if (value === "") node.spaced = true;
    if (atStyle === "bare") node.atBare = value;
    else if (atStyle === "doubled") atMixed.add(node);

    if (level === 0) {
      roots.push(node);
    } else {
      const parent = stack[level - 1];
      if (!parent) {
        // A line that happens to match the tag grammar (a digit, some words)
        // but doesn't fit the tree is almost always more of the same
        // unescaped free text, just coincidentally starting with a number —
        // fold it too, same as the no-match case above.
        if (textBlob) {
          textBlob.value = (textBlob.value ?? "") + "\n" + line;
          continue;
        }
        // Clamp the level jump: attach to the deepest open node, so the line
        // stays inside the record it appeared in (serialization takes depth
        // from tree position, so it re-emits at the clamped level). Promoting
        // it to a root would silently move the data out of its record.
        let ancestor: GedNode | undefined;
        for (let l = Math.min(level, stack.length) - 1; l >= 0 && !ancestor; l--) ancestor = stack[l];
        warnings.push({
          kind: "structure",
          message: `Line at level ${level} has no parent at level ${level - 1}; ${
            ancestor ? `attached to the nearest containing ${ancestor.tag} line` : "kept as a top-level record"
          }.`,
          line: i + 1,
        });
        if (ancestor) ancestor.children.push(node);
        else roots.push(node); // nothing open at all — keep as a root rather than lose data
      } else {
        parent.children.push(node);
      }
    }

    stack[level] = node;
    stack.length = level + 1; // discard deeper, now-stale entries
    // A pointer (`1 NOTE @N1@`) holds no text to continue: folding the next
    // stray line into it would turn `3 DATE 1900` into note text.
    textBlob = (tag === "TEXT" || tag === "NOTE") && !(value && isPointer(value.trim())) ? node : undefined;
  }

  // A photo, a zip, a .docx, an empty file: none of it is GEDCOM, yet every
  // line "parses" (kept verbatim) and the result is a tree with nobody in it —
  // which the app would load, show as an empty file and, with caching on,
  // restore at every boot. Refuse a file with neither a header nor a single
  // record, so the slot reports it instead.
  if (!roots.some((r) => r.tag === "HEAD" || r.tag === "TRLR" || r.tag === "INDI" || r.tag === "FAM" || r.xref)) {
    throw new Error(NOT_GEDCOM);
  }
  const version = detectVersion(roots, warnings);
  return { version, charset, records: roots, warnings, eol, finalNewline, bom };
}

/**
 * How a 5.5.x line value spells its literal at-signs: `"doubled"` when any is
 * written `@@` (the spec's way), `"bare"` when some are single and none are
 * doubled, undefined when it has none — a pointer and an `@#D…@` calendar
 * escape are at-sign constructs, not literal at-signs.
 */
function atStyleOf(raw: string): "bare" | "doubled" | undefined {
  if (!raw.includes("@") || isPointer(raw)) return undefined;
  let bare = false;
  for (const run of raw.replace(/@#D[A-Z ]*@/g, "").match(/@+/g) ?? []) {
    if (run.length > 1) return "doubled";
    bare = true;
  }
  return bare ? "bare" : undefined;
}

/**
 * The `HEAD.GEDC.VERS` a file declares, read straight off the text before it
 * is parsed: the header opens the file, so its first stretch is enough. Any
 * level-2 line of the GEDC block may come first (`2 FORM` before `2 VERS`).
 */
export function declaredVersion(text: string): string | undefined {
  const head = text.slice(0, 1 << 16);
  const gedc = /(?:^|[\r\n])[^\S\r\n]*1[^\S\r\n]+GEDC[^\r\n]*((?:[\r\n]+[^\S\r\n]*[2-9][^\S\r\n][^\r\n]*)*)/i.exec(head);
  return gedc ? /[\r\n][^\S\r\n]*2[^\S\r\n]+VERS[^\S\r\n]+([^\r\n]*)/i.exec(gedc[1])?.[1]?.trim() : undefined;
}

function detectVersion(roots: GedNode[], warnings: ParseWarning[]): GedcomVersion {
  const head = roots.find((r) => r.tag === "HEAD");
  const gedc = head?.children.find((c) => c.tag === "GEDC");
  const vers = gedc?.children.find((c) => c.tag === "VERS")?.value?.trim();
  // 5.5.5 is a stricter revision of 5.5.1, so it reads as the same family.
  if (vers === "5.5.1" || vers === "5.5" || vers === "5.5.5") return "5.5.1";
  if (vers === "7.0" || vers?.startsWith("7.")) return "7.0";
  warnings.push({
    kind: "version",
    message: `Unrecognized GEDCOM version ${vers ?? "(missing)"}; treating as unknown.`,
  });
  return "unknown";
}

function truncate(s: string, n = 60): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
