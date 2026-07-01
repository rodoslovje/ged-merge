import type { GedNode } from "./types";

/**
 * Canonical helpers for navigating and mutating the raw GedNode line tree.
 *
 * Before this module existed the codebase re-implemented `children.find(c =>
 * c.tag === "X")` (and its `.filter` / `.value` / find-or-create variants)
 * hundreds of times, so tag-matching and undefined-safety were re-decided ad
 * hoc. Route all direct-child access through here instead.
 *
 * Tags are matched **exactly** (case-sensitive). GEDCOM tags are uppercase by
 * spec and the parser preserves them verbatim, so this mirrors the existing
 * behaviour — it does not fold case. A `tag` argument may be a single tag or a
 * list, in which case any listed tag matches.
 */

function matches(node: GedNode, tag: string | readonly string[]): boolean {
  return typeof tag === "string" ? node.tag === tag : tag.includes(node.tag);
}

/** First direct child with the given tag (or any of the given tags), if any. */
export function firstChild(node: GedNode, tag: string | readonly string[]): GedNode | undefined {
  return node.children.find((c) => matches(c, tag));
}

/** All direct children with the given tag (or any of the given tags), in order. */
export function childrenByTag(node: GedNode, tag: string | readonly string[]): GedNode[] {
  return node.children.filter((c) => matches(c, tag));
}

/** Whether the node has a direct child with the given tag (or any of them). */
export function hasChild(node: GedNode, tag: string | readonly string[]): boolean {
  return node.children.some((c) => matches(c, tag));
}

/** Raw `value` of the first matching direct child (untrimmed), or undefined. */
export function childValue(node: GedNode, tag: string | readonly string[]): string | undefined {
  return firstChild(node, tag)?.value;
}

/**
 * Trimmed, non-empty `value` of the first matching direct child, or undefined.
 * (An all-whitespace or missing value collapses to undefined.)
 */
export function childText(node: GedNode, tag: string | readonly string[]): string | undefined {
  const v = firstChild(node, tag)?.value?.trim();
  return v || undefined;
}

/**
 * Walk a chain of tags from `node`, taking the first matching child at each
 * step, e.g. `findByPath(indi, ["BIRT", "DATE"])`. Returns undefined if any
 * step is missing.
 */
export function findByPath(node: GedNode, path: readonly string[]): GedNode | undefined {
  let cur: GedNode | undefined = node;
  for (const tag of path) {
    if (!cur) return undefined;
    cur = firstChild(cur, tag);
  }
  return cur;
}

/**
 * Find the first direct child with `tag`, or create and append one. When it
 * already exists it is returned untouched (its value is *not* overwritten);
 * pass `value` only to set it on a freshly-created node.
 */
export function upsertChild(parent: GedNode, tag: string, value?: string): GedNode {
  const existing = firstChild(parent, tag);
  if (existing) return existing;
  const child: GedNode = { level: parent.level + 1, tag, children: [] };
  if (value !== undefined) child.value = value;
  parent.children.push(child);
  return child;
}

/** Remove every direct child with the given tag (or any of them). Returns the count removed. */
export function removeChildren(node: GedNode, tag: string | readonly string[]): number {
  let removed = 0;
  node.children = node.children.filter((c) => {
    if (matches(c, tag)) {
      removed++;
      return false;
    }
    return true;
  });
  return removed;
}

/** Deep-clone a GedNode tree. All string fields are primitives so no reference aliasing occurs. */
export function cloneNode(n: GedNode): GedNode {
  const c: GedNode = { level: n.level, tag: n.tag, children: n.children.map(cloneNode) };
  if (n.xref !== undefined) c.xref = n.xref;
  if (n.value !== undefined) c.value = n.value;
  return c;
}
