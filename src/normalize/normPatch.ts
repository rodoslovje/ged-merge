import type { GedNode } from "../gedcom/types";

/**
 * What `normalizeDataset` changed, as edits a second parse of the same bytes
 * can replay — so the main thread need not normalize an incoming file the
 * worker has already normalized (seconds on an index-scale file).
 *
 * Diffed, not recorded: normalization is a dozen passes over a cloned record
 * forest, and comparing that forest with the one it was cloned from catches
 * every change any pass makes, including passes written later. The forest
 * keeps its length (no pass adds or drops a top-level record), so each edit
 * names a record by index and a node below it by a child-index path.
 *
 * Compact on purpose: against a main with another place style, nearly every
 * event of a large file changes, and a patch of a million small objects costs
 * as much to post and receive as the normalization it replaces. So the edits
 * are numbers in one `Int32Array` and the strings they write are one string
 * cut by a length table — both cheap to post — and only nodes the incoming
 * file did not have travel as objects.
 *
 * Ops, each `[op, record, depth, ...path, ...operands]` (paths in the
 * numbering the node's parent has once earlier ops ran):
 *  - `SCALARS mask` — the node's fields in `SCALAR_FIELDS` order whose bit is
 *    set take the next strings (length -1 = remove the field); bit 5 takes the
 *    next object as `conc`.
 *  - `CHILDREN n e1…en` — the node's children become: `e ≥ 0` its old child at
 *    that index, `e < 0` the object `-e - 1`. Later ops then reach them.
 *  - `REPLACE obj keepXref` — the node (its level or xref changed) is
 *    replaced by the object; `keepXref` 1 keeps the node's own xref (see
 *    {@link applyNormPatch}).
 */
export interface NormPatch {
  /** Length of the record forest the edits address, as a guard. */
  count: number;
  ops: Int32Array;
  /** Length of each string the ops consume, in order; -1 for "remove". */
  lens: Int32Array;
  /** The strings, back to back. */
  text: string;
  /** Whole nodes (and CONC tables) that travel as objects. */
  objs: unknown[];
}

const OP_SCALARS = 1;
const OP_CHILDREN = 2;
const OP_REPLACE = 3;
const SCALAR_FIELDS = ["tag", "value", "spelling", "reshapedFrom", "verbatim"] as const;
const CONC_BIT = 1 << SCALAR_FIELDS.length;

class Writer {
  ops: number[] = [];
  lens: number[] = [];
  parts: string[] = [];
  objs: unknown[] = [];
  head(op: number, r: number, path: number[]): void {
    this.ops.push(op, r, path.length, ...path);
  }
  str(s: string | undefined): void {
    if (s === undefined) this.lens.push(-1);
    else {
      this.lens.push(s.length);
      this.parts.push(s);
    }
  }
  obj(o: unknown): number {
    this.objs.push(o);
    return this.objs.length - 1;
  }
}

/** The edits that turn `before` into `after` (see {@link NormPatch}).
 *  Undefined when the two forests differ in length — not expected of
 *  normalization; the caller then has no patch to offer. */
export function diffNormalized(before: GedNode[], after: GedNode[]): NormPatch | undefined {
  if (before.length !== after.length) return undefined;
  const w = new Writer();
  const path: number[] = [];
  for (let r = 0; r < before.length; r++) diffNode(before[r], after[r], r, path, w);
  return {
    count: before.length,
    ops: Int32Array.from(w.ops),
    lens: Int32Array.from(w.lens),
    text: w.parts.join(""),
    objs: w.objs,
  };
}

/** Whether `b` can be reached from `a` by field and child edits. */
const sameShape = (a: GedNode, b: GedNode) => a.level === b.level && a.xref === b.xref;

function diffNode(a: GedNode, b: GedNode, r: number, path: number[], w: Writer): void {
  if (a === b) return;
  if (!sameShape(a, b)) {
    w.head(OP_REPLACE, r, path);
    w.ops.push(w.obj(b), a.xref === b.xref ? 1 : 0);
    return;
  }
  let mask = 0;
  SCALAR_FIELDS.forEach((k, i) => {
    if (a[k] !== b[k]) mask |= 1 << i;
  });
  if (!concEqual(a.conc, b.conc)) mask |= CONC_BIT;
  if (mask) {
    w.head(OP_SCALARS, r, path);
    w.ops.push(mask);
    SCALAR_FIELDS.forEach((k, i) => {
      if (mask & (1 << i)) w.str(b[k]);
    });
    if (mask & CONC_BIT) w.ops.push(w.obj(b.conc ?? null));
  }
  // Align the children: each new child reuses the next old one of the same
  // tag and shape (normalization drops and appends lines, it never reorders
  // them), and is otherwise new. Ties are harmless — the recursion below makes
  // a reused child equal to its counterpart whatever it started as.
  const old = a.children;
  const next = b.children;
  const from: number[] = [];
  let k = 0;
  let aligned = old.length === next.length;
  for (const child of next) {
    let found = -1;
    for (let i = k; i < old.length; i++) {
      if (old[i].tag === child.tag && sameShape(old[i], child)) {
        found = i;
        break;
      }
    }
    if (found !== k) aligned = false;
    if (found >= 0) k = found + 1;
    from.push(found);
  }
  if (!aligned) {
    w.head(OP_CHILDREN, r, path);
    w.ops.push(next.length);
    next.forEach((child, j) => w.ops.push(from[j] >= 0 ? from[j] : -w.obj(child) - 1));
  }
  next.forEach((child, j) => {
    if (from[j] < 0) return;
    path.push(j);
    diffNode(old[from[j]], child, r, path, w);
    path.pop();
  });
}

function concEqual(a: GedNode["conc"], b: GedNode["conc"]): boolean {
  if (a === b) return true;
  if (!a || !b || a.of !== b.of || a.at.length !== b.at.length) return false;
  return a.at.every((v, i) => v === b.at[i]);
}

/**
 * Replay a {@link NormPatch} onto a fresh parse of the same bytes, in place.
 * Returns false when the forest is not the one the patch was made against —
 * then the records may be half-patched and must be parsed again.
 *
 * A replaced record keeps the target's xref: the diff is taken after
 * `buildDataset` gave duplicate-xref records fresh ids, a parse not yet built
 * still holds the originals, and the build that follows renames them alike.
 */
export function applyNormPatch(records: GedNode[], patch: NormPatch): boolean {
  if (records.length !== patch.count) return false;
  const { ops, lens, text, objs } = patch;
  let at = 0; // next op
  let s = 0; // next length
  let pos = 0; // next string's start in `text`
  const nextStr = (): string | undefined => {
    const len = lens[s++];
    if (len < 0) return undefined;
    const out = text.slice(pos, pos + len);
    pos += len;
    return out;
  };
  while (at < ops.length) {
    const op = ops[at++];
    const r = ops[at++];
    const depth = ops[at++];
    let parent: GedNode | undefined;
    let node: GedNode | undefined = records[r];
    let last = -1;
    for (let d = 0; d < depth; d++) {
      parent = node;
      last = ops[at++];
      node = node?.children[last];
    }
    if (!node) return false;
    if (op === OP_SCALARS) {
      const mask = ops[at++];
      SCALAR_FIELDS.forEach((k, i) => {
        if (!(mask & (1 << i))) return;
        const v = nextStr();
        if (k === "tag") node.tag = v ?? "";
        else if (v === undefined) delete node[k];
        else node[k] = v;
      });
      if (mask & CONC_BIT) {
        const conc = objs[ops[at++]] as GedNode["conc"] | null;
        if (conc) node.conc = conc;
        else delete node.conc;
      }
    } else if (op === OP_CHILDREN) {
      const n = ops[at++];
      const old = node.children;
      const children: GedNode[] = [];
      for (let j = 0; j < n; j++) {
        const e = ops[at++];
        const child = e >= 0 ? old[e] : (objs[-e - 1] as GedNode);
        if (!child) return false;
        children.push(child);
      }
      node.children = children;
    } else if (op === OP_REPLACE) {
      const next = objs[ops[at++]] as GedNode;
      if (ops[at++]) {
        if (node.xref !== undefined) next.xref = node.xref;
        else delete next.xref;
      }
      if (parent) parent.children[last] = next;
      else records[r] = next;
    } else return false;
  }
  return true;
}
