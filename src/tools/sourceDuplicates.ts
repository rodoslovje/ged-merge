import type { Dataset, GedNode } from "../gedcom/types";
import { childText, cloneNode, firstChild } from "../gedcom/node";
import {
  isPointer,
  looksLikeUrl,
  objeInfoOf,
  sourceContentKey,
  sourceTitle,
} from "../gedcom/source";
import { linkKey } from "../normalize/links";

/**
 * Within-file duplicate finder for the supporting records (`OBJE`, `SOUR`,
 * `REPO`) — the media/links, sources and repositories shown in the Sources tab.
 *
 * Two GEDCOM exports of overlapping family lines routinely describe the *same*
 * real-world media or source under unrelated xrefs: the same scan linked twice,
 * one parish register imported as both `@S5@` and `@S37@`, one archive named in
 * two `REPO` records. These bloat the file and split a record's citations.
 *
 * This finds those groups by identity and, on demand, collapses each selected
 * group to one survivor — re-pointing every citation onto it and dropping the
 * rest. It's a pure, synchronous whole-file tool (like `bulkNormalize`): the
 * live dataset is never touched; the caller serializes the returned records to a
 * download.
 *
 * Identity per kind:
 *  - **media** (`OBJE`) — by `FILE`: a normalized URL (`linkKey`, so language
 *    and trailing-slash variants compare equal) or, for a local file, its bare
 *    lower-cased basename.
 *  - **source** (`SOUR`) / **repository** (`REPO`) — by `sourceContentKey`:
 *    every descriptive field except relational pointers. Identical content ⇒
 *    same real-world source/repository even under different xrefs.
 */

export type DupKind = "media" | "source" | "repo";

/** One record within a duplicate group. */
export interface DupMember {
  xref: string;
  /** Display title (falls back to the basename/xref). */
  title: string;
  /** The shared link/filename/website, shown as secondary detail. */
  detail?: string;
  /** How many records cite this record across the whole file. */
  usage: number;
  /** True for the record kept when the group is fixed (the rest fold into it). */
  survivor: boolean;
}

/** A set of records that all describe the same media/source/repository. */
export interface DupGroup {
  /** Stable identity (`${kind}:${key}`), used as the selection/React key. */
  id: string;
  kind: DupKind;
  /** The shared link/filename/title, for the group header. */
  label: string;
  /** Members, survivor first. */
  members: DupMember[];
  /** Records dropped if this group is fixed (`members.length - 1`). */
  removable: number;
}

export interface DuplicateReport {
  groups: DupGroup[];
  /** Number of duplicate groups per kind. */
  byKind: Record<DupKind, number>;
}

const KIND_ORDER: Record<DupKind, number> = { media: 0, source: 1, repo: 2 };

/** The bare filename of a (possibly path-qualified) `FILE` value. */
function basename(file: string): string {
  const parts = file.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || file;
}

/** Identity key for an `OBJE` media `FILE` — normalized URL, or lower-cased basename. */
function mediaKey(file: string): string {
  return looksLikeUrl(file) ? `url:${linkKey(file)}` : `file:${basename(file).trim().toLowerCase()}`;
}

/** Total descendant lines under a node — a "richness" proxy for picking the survivor. */
function richness(node: GedNode): number {
  let n = 0;
  for (const c of node.children) n += 1 + richness(c);
  return n;
}

/** Count pointer references to each xref across the whole record forest. */
function countPointerRefs(records: GedNode[]): Map<string, number> {
  const counts = new Map<string, number>();
  const walk = (n: GedNode): void => {
    for (const c of n.children) {
      const v = c.value?.trim();
      if (v && isPointer(v)) counts.set(v, (counts.get(v) ?? 0) + 1);
      walk(c);
    }
  };
  for (const r of records) walk(r);
  return counts;
}

/** Bucket top-level `tag` records by `keyOf` and emit a {@link DupGroup} per
 *  bucket with 2+ members. The survivor (kept) is the richest record, then the
 *  most-cited, then the first in file order — minimizing data loss and changes. */
function groupRecords(
  records: GedNode[],
  tag: string,
  kind: DupKind,
  keyOf: (rec: GedNode) => string | undefined,
  describe: (rec: GedNode) => { title: string; detail?: string },
  refs: Map<string, number>,
  out: DupGroup[],
): void {
  const buckets = new Map<string, GedNode[]>();
  for (const rec of records) {
    if (rec.tag !== tag || !rec.xref) continue;
    const key = keyOf(rec);
    if (!key) continue;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(rec);
    else buckets.set(key, [rec]);
  }

  for (const [key, recs] of buckets) {
    if (recs.length < 2) continue;
    const ranked = recs
      .map((rec, i) => ({ rec, i, rich: richness(rec), use: refs.get(rec.xref!) ?? 0 }))
      .sort((a, b) => b.rich - a.rich || b.use - a.use || a.i - b.i);
    const members: DupMember[] = ranked.map(({ rec }, idx) => {
      const d = describe(rec);
      return { xref: rec.xref!, title: d.title, detail: d.detail, usage: refs.get(rec.xref!) ?? 0, survivor: idx === 0 };
    });
    const label = (kind === "media" ? members[0].detail : members[0].title) || members[0].title;
    out.push({ id: `${kind}:${key}`, kind, label, members, removable: members.length - 1 });
  }
}

export function findSourceDuplicates(ds: Dataset): DuplicateReport {
  const refs = countPointerRefs(ds.records);
  const groups: DupGroup[] = [];

  groupRecords(
    ds.records, "OBJE", "media",
    (rec) => {
      const file = firstChild(rec, "FILE")?.value?.trim();
      return file ? mediaKey(file) : undefined;
    },
    (rec) => {
      const info = objeInfoOf(rec);
      return { title: info.title || (info.file ? basename(info.file) : rec.xref!), detail: info.url ?? info.file };
    },
    refs, groups,
  );

  groupRecords(
    ds.records, "SOUR", "source",
    (rec) => { const k = sourceContentKey(rec); return k ? `c:${k}` : undefined; },
    (rec) => ({ title: sourceTitle(rec) || rec.xref!, detail: childText(rec, "FILN") }),
    refs, groups,
  );

  groupRecords(
    ds.records, "REPO", "repo",
    (rec) => { const k = sourceContentKey(rec); return k ? `c:${k}` : undefined; },
    (rec) => ({ title: childText(rec, "NAME") || rec.xref!, detail: childText(rec, "WWW") }),
    refs, groups,
  );

  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  groups.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || collator.compare(a.label, b.label));

  const byKind: Record<DupKind, number> = { media: 0, source: 0, repo: 0 };
  for (const g of groups) byKind[g.kind]++;
  return { groups, byKind };
}

/** Append a pointer child to `survivor` unless it already has the same tag+value. */
function foldPointer(survivor: GedNode, child: GedNode): void {
  const v = child.value?.trim();
  if (survivor.children.some((c) => c.tag === child.tag && c.value?.trim() === v)) return;
  survivor.children.push(cloneNode(child));
}

/** Full-subtree signature of a node — distinguishes two citations of the same
 *  source that differ in their `PAGE` (or any other sub-detail). */
function nodeSig(n: GedNode): string {
  const head = `${n.tag} ${n.value ?? ""}`;
  return n.children.length ? `${head}{${n.children.map(nodeSig).join("|")}}` : head;
}

/**
 * Remove pointer children of `node` that duplicate an earlier sibling *only*
 * when the duplication was introduced by re-pointing — i.e. one of the two
 * identical pointers is in `repointed`. Two pointers count as identical only
 * when their whole subtree matches (so distinct `PAGE`s are preserved), and
 * pre-existing duplicates the merge didn't create are left untouched, keeping
 * the output a minimal change.
 */
function collapseRepointedDuplicates(node: GedNode, repointed: Set<GedNode>): void {
  const seen = new Map<string, GedNode>();
  node.children = node.children.filter((c) => {
    const v = c.value?.trim();
    if (!v || !isPointer(v)) return true;
    const sig = nodeSig(c);
    const prev = seen.get(sig);
    if (prev && (repointed.has(c) || repointed.has(prev))) return false;
    if (!prev) seen.set(sig, c);
    return true;
  });
}

/**
 * Collapse each given duplicate group to its survivor, returning a fresh record
 * forest (the input is never mutated). For every removed record, its citations
 * across the whole file are re-pointed onto the survivor; a removed `SOUR`'s own
 * `OBJE`/`REPO` links are first folded onto the survivor so they aren't lost,
 * then the removed top-level records are dropped and any duplicate sibling
 * pointers introduced by re-pointing are collapsed.
 */
export function dedupeSources(records: GedNode[], groups: DupGroup[]): { records: GedNode[]; removed: number } {
  const remap = new Map<string, string>();
  for (const g of groups) {
    const survivor = g.members.find((m) => m.survivor);
    if (!survivor) continue;
    for (const m of g.members) if (!m.survivor) remap.set(m.xref, survivor.xref);
  }
  if (remap.size === 0) return { records, removed: 0 };

  const clone = records.map(cloneNode);
  const byXref = new Map<string, GedNode>();
  for (const r of clone) if (r.xref) byXref.set(r.xref, r);

  // Fold a removed source's own media/repo links onto its survivor before drop.
  for (const g of groups) {
    if (g.kind !== "source") continue;
    const survivor = g.members.find((m) => m.survivor);
    const survNode = survivor && byXref.get(survivor.xref);
    if (!survNode) continue;
    for (const m of g.members) {
      if (m.survivor) continue;
      const removedNode = byXref.get(m.xref);
      if (!removedNode) continue;
      for (const child of removedNode.children) {
        if ((child.tag === "OBJE" || child.tag === "REPO") && child.value && isPointer(child.value.trim())) {
          foldPointer(survNode, child);
        }
      }
    }
  }

  // Re-point every citation that targets a removed record onto its survivor,
  // tracking the nodes we changed. Where re-pointing makes a record cite the
  // same record twice, collapse that one duplicate — but only that one, so
  // untouched records (and citations differing by PAGE) are left exactly as is.
  const repointed = new Set<GedNode>();
  const repoint = (n: GedNode): void => {
    let changedHere = false;
    for (const c of n.children) {
      const v = c.value?.trim();
      const to = v && remap.get(v);
      if (to) { c.value = to; repointed.add(c); changedHere = true; }
    }
    if (changedHere) collapseRepointedDuplicates(n, repointed);
    for (const c of n.children) repoint(c);
  };
  for (const r of clone) repoint(r);

  const kept = clone.filter((r) => !(r.xref && remap.has(r.xref)));
  return { records: kept, removed: remap.size };
}
