import type { Dataset, GedNode } from "../gedcom/types";
import { childText, cloneNode, firstChild } from "../gedcom/node";
import {
  isPointer,
  isWebAddress,
  looksLikeUrl,
  objeInfoOf,
  objeNodesFor,
  fullerSourceOf,
  sourceContentKey,
  sourceContentParts,
  sourceTitle,
  filingNumberOf,
  isSourceStampTag,
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
 *    every descriptive field (a repo link's `CALN` included, so two films of
 *    one collection stay apart), the repositories a source points at and its
 *    `_` tags, but no media pointers and no `CHAN`/`CREA`/`_UPD` stamps. Identical content ⇒ same real-world source/repository even
 *    under different xrefs. A record that says less than one other of its
 *    title — the same register imported without its call number or `DATA` —
 *    joins that record's group, which keeps the fuller one.
 */

export type DupKind = "media" | "source" | "repo";

/** One record within a duplicate group. */
export interface DupMember {
  xref: string;
  /** Display title (falls back to the basename/xref). */
  title: string;
  /** The shared link/filename/website, shown as secondary detail. Not a
   *  link: a source's is its filing number, a media record's may be a local
   *  path — see `url` for what can actually be opened. */
  detail?: string;
  /** The page this record stands for, where it has one that opens: a media
   *  record's own URL, a source's page image (or its `WWW`), a repository's
   *  website. Undefined for a record that names no address — an offline scan,
   *  a source known only by its title. */
  url?: string;
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

/** The page a `SOUR` record opens at: its first page image's URL, or the
 *  record's own `WWW` where it carries one instead. A source known only by
 *  its title and filing number has none — and must not be given a made-up one
 *  (a title is not an address). */
function sourceUrlOf(rec: GedNode, objes: Map<string, GedNode>): string | undefined {
  for (const child of rec.children) {
    if (child.tag !== "OBJE") continue;
    const v = child.value?.trim();
    const node = v && isPointer(v) ? objes.get(v) : child;
    const url = node && objeInfoOf(node).url;
    if (url) return url;
  }
  return childText(rec, "WWW");
}

/** Bucket top-level `tag` records by `keyOf` and emit a {@link DupGroup} per
 *  bucket with 2+ members. The survivor (kept) is the most-cited — so the
 *  fewest pointers are re-written — where `citedFirst` (the apply folds what
 *  the others say into it), else the one saying the most (`fullness`); then
 *  the other of the two, the richest record, and the first in file order. */
function groupRecords(
  records: GedNode[],
  tag: string,
  kind: DupKind,
  keyOf: (rec: GedNode) => string | undefined,
  describe: (rec: GedNode) => { title: string; detail?: string; url?: string },
  refs: Map<string, number>,
  out: DupGroup[],
  fullness: (rec: GedNode) => number,
  citedFirst: boolean,
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
      .map((rec, i) => ({ rec, i, full: fullness(rec), rich: richness(rec), use: refs.get(rec.xref!) ?? 0 }))
      .sort((a, b) =>
        (citedFirst ? b.use - a.use || b.full - a.full : b.full - a.full || b.use - a.use) || b.rich - a.rich || a.i - b.i,
      );
    const members: DupMember[] = ranked.map(({ rec }, idx) => {
      const d = describe(rec);
      return {
        xref: rec.xref!,
        title: d.title,
        detail: d.detail,
        url: isWebAddress(d.url) ? d.url : undefined,
        usage: refs.get(rec.xref!) ?? 0,
        survivor: idx === 0,
      };
    });
    const label = (kind === "media" ? members[0].detail : members[0].title) || members[0].title;
    out.push({ id: `${kind}:${key}`, kind, label, members, removable: members.length - 1 });
  }
}

export function findSourceDuplicates(ds: Dataset): DuplicateReport {
  const refs = countPointerRefs(ds.records);
  const objes = objeNodesFor(ds.records);
  const groups: DupGroup[] = [];

  // Local files identified by bare basename: two cameras both produce an
  // IMG_0001.jpg, so a basename whose records carry *conflicting* titles is
  // split per title (untitled copies then group only among themselves) —
  // where every title agrees, an untitled copy still joins the group.
  const titlesByBase = new Map<string, Set<string>>();
  for (const rec of ds.records) {
    if (rec.tag !== "OBJE" || !rec.xref) continue;
    const file = firstChild(rec, "FILE")?.value?.trim();
    if (!file || looksLikeUrl(file)) continue;
    const title = objeInfoOf(rec).title?.trim().toLowerCase();
    if (!title) continue;
    const key = mediaKey(file);
    const set = titlesByBase.get(key);
    if (set) set.add(title);
    else titlesByBase.set(key, new Set([title]));
  }

  groupRecords(
    ds.records, "OBJE", "media",
    (rec) => {
      const file = firstChild(rec, "FILE")?.value?.trim();
      if (!file) return undefined;
      const key = mediaKey(file);
      if (looksLikeUrl(file) || (titlesByBase.get(key)?.size ?? 0) <= 1) return key;
      const title = objeInfoOf(rec).title?.trim().toLowerCase();
      return `${key}#t:${title ?? "?"}`;
    },
    (rec) => {
      const info = objeInfoOf(rec);
      return { title: info.title || (info.file ? basename(info.file) : rec.xref!), detail: info.url ?? info.file, url: info.url };
    },
    // Media records share only their `FILE`: a dropped one's title or notes
    // would be lost, so the one saying the most leads before the most-cited.
    refs, groups, richness, false,
  );

  // A source or repository saying less than one other of its title is keyed
  // as that fuller record, so it lands in the fuller record's group.
  // One file: the repository a source points at, and its exporter's `_` tags,
  // tell two records apart too (see `SourceKeyOptions`).
  const keyOpts = { sameFile: true };
  const fuller = fullerSourceOf(ds.records, ds.records, keyOpts);
  const byXref = new Map(ds.records.filter((r) => r.xref).map((r) => [r.xref!, r]));
  const contentKey = (rec: GedNode) => {
    const to = fuller.get(rec.xref!);
    const k = sourceContentKey((to && byXref.get(to)) || rec, keyOpts);
    return k ? `c:${k}` : undefined;
  };
  const fullness = (rec: GedNode) => sourceContentParts(rec, keyOpts).length;

  groupRecords(
    ds.records, "SOUR", "source",
    contentKey,
    (rec) => ({ title: sourceTitle(rec) || rec.xref!, detail: filingNumberOf(rec), url: sourceUrlOf(rec, objes) }),
    refs, groups, fullness, true,
  );

  groupRecords(
    ds.records, "REPO", "repo",
    contentKey,
    (rec) => ({ title: childText(rec, "NAME") || rec.xref!, detail: childText(rec, "WWW"), url: childText(rec, "WWW") }),
    refs, groups, fullness, true,
  );

  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  groups.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || collator.compare(a.label, b.label));

  const byKind: Record<DupKind, number> = { media: 0, source: 0, repo: 0 };
  for (const g of groups) byKind[g.kind]++;
  return { groups, byKind };
}

/** Copy into `survivor` every line of `removed` it does not already carry —
 *  matched by tag and value, level by level — so whichever record of a group
 *  is kept, nothing another member said is lost. Stamps stay the survivor's
 *  own, and a text's `CONT`/`CONC` lines belong to the text they continue. */
function foldContent(survivor: GedNode, removed: GedNode, nested = false): void {
  for (const child of removed.children) {
    if (isSourceStampTag(child.tag) || child.tag === "CONT" || child.tag === "CONC") continue;
    const v = child.value?.trim() ?? "";
    const same = survivor.children.find((c) => c.tag === child.tag && (c.value?.trim() ?? "") === v);
    if (same) foldContent(same, child, true);
    // Below the record's own lines, a detail the kept line already states is
    // not stated a second time: one link visited on two dates keeps the kept
    // record's date, rather than ending up with two.
    else if (!(nested && survivor.children.some((c) => c.tag === child.tag))) survivor.children.push(cloneNode(child));
  }
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
 * identical pointers is in `repointed`. A pointer counts as duplicated only
 * when a sibling carries every line of its subtree (so distinct `PAGE`s are
 * preserved, and of a bare and a `QUAY`-graded citation the graded stays), and
 * pre-existing duplicates the merge didn't create are left untouched, keeping
 * the output a minimal change.
 */
function collapseRepointedDuplicates(node: GedNode, repointed: Set<GedNode>): void {
  const pointers = node.children.filter((c) => { const v = c.value?.trim(); return !!v && isPointer(v); });
  const subSigs = new Map(pointers.map((c) => [c, new Set(c.children.map(nodeSig))]));
  // `c` is said again by `o`: the same pointer, and every line under `c` is
  // under `o` too — `SOUR @S1@ / PAGE 186` beside `SOUR @S1@ / PAGE 186 /
  // QUAY 3` once a lean copy of the source is folded into the full one.
  const coveredBy = (c: GedNode, o: GedNode) =>
    o !== c && o.tag === c.tag && o.value?.trim() === c.value?.trim() && [...subSigs.get(c)!].every((s) => subSigs.get(o)!.has(s));
  const dropped = new Set<GedNode>();
  pointers.forEach((c, i) => {
    const by = pointers.find((o, j) => {
      if (dropped.has(o) || !coveredBy(c, o) || !(repointed.has(c) || repointed.has(o))) return false;
      // Of two identical ones the first stays; otherwise the fuller one does.
      return !coveredBy(o, c) || j < i;
    });
    if (by) dropped.add(c);
  });
  if (dropped.size) node.children = node.children.filter((c) => !dropped.has(c));
}

/**
 * Collapse each given duplicate group to its survivor, returning a fresh record
 * forest (the input is never mutated). For every removed record, its citations
 * across the whole file are re-pointed onto the survivor; a removed `SOUR`'s or
 * `REPO`'s lines the survivor lacks (its `OBJE`/`REPO` links, a call number, an
 * address) are first folded onto the survivor so they aren't lost,
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

  // Fold what a removed source or repository says onto its survivor before drop.
  for (const g of groups) {
    if (g.kind === "media") continue;
    const survivor = g.members.find((m) => m.survivor);
    const survNode = survivor && byXref.get(survivor.xref);
    if (!survNode) continue;
    for (const m of g.members) {
      if (m.survivor) continue;
      const removedNode = byXref.get(m.xref);
      if (removedNode) foldContent(survNode, removedNode);
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
