import { decodeGedcom } from "./decode";
import type { GedNode, GedcomVersion, ParseResult, ParseWarning } from "./types";

const LINE_RE = /^(\d+)\s+(?:(@[^@]+@)\s+)?([A-Za-z0-9_.]+)(?:\s(.*))?$/;

/**
 * Parse raw GEDCOM bytes into a lossless line tree (`ParseResult`).
 *
 * Steps: decode bytes → split into lines → match each line → assemble the tree
 * by tracking a stack indexed by level → fold CONT/CONC into parent values.
 */
export function parseGedcom(buffer: ArrayBuffer): ParseResult {
  const { text, charset, warnings: decodeWarnings } = decodeGedcom(buffer);
  const warnings: ParseWarning[] = [...decodeWarnings];

  // Remember the source's line-ending style and whether it ended with a newline
  // so the serializer can round-trip byte-faithfully (clean before/after diffs).
  // Classic-Mac CR-only endings (e.g. Reunion exports) must be recognised too,
  // otherwise their lines would be re-joined with LF on save.
  const eol = text.includes("\r\n") ? "\r\n" : text.includes("\r") && !text.includes("\n") ? "\r" : "\n";
  const finalNewline = /[\r\n]$/.test(text);

  // Split on any line ending (\r\n, lone \r, or \n) in a single pass. Doing the
  // split directly avoids allocating a full normalized copy of the text first —
  // a meaningful saving on large (tens-of-MB) files.
  const lines = text.split(/\r\n?|\n/);

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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
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
    let value = m[4];
    // GEDCOM doubles a leading at-sign (`@@`) so a value can start with a
    // literal `@` without reading as a pointer. Fold it back to a single `@`;
    // the serializer re-doubles it on output, so a valid file still
    // round-trips byte-faithfully.
    if (value !== undefined && value.startsWith("@@")) value = value.slice(1);

    // CONT (new line) and CONC (no separator) extend the parent's value.
    if (tag === "CONT" || tag === "CONC") {
      const parent = stack[level - 1];
      if (!parent) {
        warnings.push({ kind: "structure", message: `${tag} with no parent`, line: i + 1 });
        continue;
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
      textBlob = parent;
      continue;
    }

    const node: GedNode = { level, tag, children: [] };
    if (xref) node.xref = xref;
    if (value !== undefined) node.value = value;

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
    textBlob = tag === "TEXT" || tag === "NOTE" ? node : undefined;
  }

  const version = detectVersion(roots, warnings);
  return { version, charset, records: roots, warnings, eol, finalNewline };
}

function detectVersion(roots: GedNode[], warnings: ParseWarning[]): GedcomVersion {
  const head = roots.find((r) => r.tag === "HEAD");
  const gedc = head?.children.find((c) => c.tag === "GEDC");
  const vers = gedc?.children.find((c) => c.tag === "VERS")?.value?.trim();
  if (vers === "5.5.1" || vers === "5.5") return "5.5.1";
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
