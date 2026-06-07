import type { Dataset, GedNode } from "./types";

export interface SerializeOptions {
  /** Line-ending to join with. Defaults to "\n". */
  eol?: string;
  /** Emit a trailing newline after the last line. Defaults to true. */
  finalNewline?: boolean;
}

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
 * Caveat: GEDCOM `CONC` (continue without a line break) is folded into the value
 * at parse time and cannot be told apart from a value that was simply long, so
 * long values originally wrapped with CONC re-emit as a single line. `CONT`
 * (line break) round-trips exactly. Tag case is normalized to upper-case.
 */
export function serializeGedcom(records: GedNode[], opts: SerializeOptions = {}): string {
  const eol = opts.eol ?? "\n";
  const lines: string[] = [];
  for (const record of records) emitNode(record, 0, lines);
  const text = lines.join(eol);
  return opts.finalNewline === false ? text : text + eol;
}

/** Serialize a whole dataset, preserving its source line-ending conventions. */
export function serializeDataset(ds: Dataset): string {
  return serializeGedcom(ds.records, { eol: ds.eol, finalNewline: ds.finalNewline });
}

function emitNode(node: GedNode, depth: number, lines: string[]): void {
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
    lines.push(segments[0] === "" ? head : `${head} ${segments[0]}`);
    for (let i = 1; i < segments.length; i++) {
      const seg = segments[i];
      lines.push(seg.length ? `${depth + 1} CONT ${seg}` : `${depth + 1} CONT`);
    }
  }

  for (const child of node.children) emitNode(child, depth + 1, lines);
}
