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
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const finalNewline = /[\r\n]$/.test(text);

  // Split on any line ending (\r\n, lone \r, or \n) in a single pass. Doing the
  // split directly avoids allocating a full normalized copy of the text first —
  // a meaningful saving on large (tens-of-MB) files.
  const lines = text.split(/\r\n?|\n/);

  const roots: GedNode[] = [];
  // stack[level] holds the most recent node opened at that level.
  const stack: GedNode[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;

    const m = LINE_RE.exec(line);
    if (!m) {
      warnings.push({ kind: "syntax", message: `Unparsable line: ${truncate(line)}`, line: i + 1 });
      continue;
    }

    const level = Number(m[1]);
    const xref = m[2];
    const tag = m[3].toUpperCase();
    const value = m[4];

    // CONT (new line) and CONC (no separator) extend the parent's value.
    if (tag === "CONT" || tag === "CONC") {
      const parent = stack[level - 1];
      if (!parent) {
        warnings.push({ kind: "structure", message: `${tag} with no parent`, line: i + 1 });
        continue;
      }
      const sep = tag === "CONT" ? "\n" : "";
      parent.value = (parent.value ?? "") + sep + (value ?? "");
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
        warnings.push({
          kind: "structure",
          message: `Line at level ${level} has no parent at level ${level - 1}`,
          line: i + 1,
        });
        // Treat as a root to avoid losing data.
        roots.push(node);
      } else {
        parent.children.push(node);
      }
    }

    stack[level] = node;
    stack.length = level + 1; // discard deeper, now-stale entries
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
