import type { Dataset, GedNode } from "../gedcom/types";
import {
  buildObjeIndex,
  buildRepoIndex,
  childText,
  isPointer,
} from "../gedcom/source";
import { label } from "../match/relatives";

/**
 * Source explorer: a read-only Repository → Source → Media containment tree
 * over the supporting records (`REPO`, `SOUR`, `OBJE`) that can't be inspected
 * anywhere else in the app. Pure and synchronous over the typed/raw model so it
 * runs on the main thread alongside the other Tools-tab builders.
 *
 * Each source and media entry also carries the `INDI`/`FAM` records that cite
 * it, so the UI can navigate straight to a using record in Edit mode.
 */

/** An `INDI`/`FAM` record that cites a source or media object — a navigate target. */
export interface SourceUse {
  /** Record xref, e.g. "@I1@". */
  id: string;
  /** Display label (person name + birth, or composed family label). */
  label: string;
}

export interface MediaEntry {
  xref: string;
  title?: string;
  /** Resolvable URL, when the `FILE` is an absolute link rather than a local filename. */
  url?: string;
  /** Records that cite this media object directly (not via its parent source). */
  usedBy: SourceUse[];
}

export interface SourceEntry {
  xref: string;
  title?: string;
  agency?: string;
  filingNumber?: string;
  media: MediaEntry[];
  usedBy: SourceUse[];
}

export interface RepoGroup {
  /** Repository xref, or undefined for the synthetic "no repository" bucket. */
  xref?: string;
  name?: string;
  url?: string;
  sources: SourceEntry[];
}

export interface SourceTree {
  repos: RepoGroup[];
  /** Top-level media cited by no source (referenced directly by events). */
  unattachedMedia: MediaEntry[];
  sourceCount: number;
  repoCount: number;
  mediaCount: number;
}

/** Compose a family display label from its spouses' labels. */
function familyLabel(dataset: Dataset, famId: string): string {
  const fam = dataset.families.get(famId);
  if (!fam) return famId;
  const h = fam.husband && dataset.individuals.get(fam.husband);
  const w = fam.wife && dataset.individuals.get(fam.wife);
  const names = [h && label(h), w && label(w)].filter(Boolean);
  return names.length ? names.join(" & ") : famId;
}

/** Recursively collect pointer values under a given tag within a record subtree. */
function collectPointers(node: GedNode, tag: string, into: Set<string>): void {
  for (const child of node.children) {
    if (child.tag === tag && child.value && isPointer(child.value.trim())) {
      into.add(child.value.trim());
    }
    collectPointers(child, tag, into);
  }
}

/**
 * Map every top-level `SOUR`/`OBJE` xref to the `INDI`/`FAM` records that cite
 * it. One pass over the dataset records; each record contributes at most once
 * per referenced xref (a record that cites a source many times lists it once).
 */
function buildUsageIndex(dataset: Dataset): {
  bySource: Map<string, SourceUse[]>;
  byMedia: Map<string, SourceUse[]>;
} {
  const bySource = new Map<string, SourceUse[]>();
  const byMedia = new Map<string, SourceUse[]>();

  const add = (map: Map<string, SourceUse[]>, xref: string, use: SourceUse) => {
    const list = map.get(xref);
    if (list) list.push(use);
    else map.set(xref, [use]);
  };

  for (const rec of dataset.records) {
    if (rec.tag !== "INDI" && rec.tag !== "FAM") continue;
    if (!rec.xref) continue;
    const use: SourceUse = {
      id: rec.xref,
      label:
        rec.tag === "INDI"
          ? dataset.individuals.get(rec.xref)
            ? label(dataset.individuals.get(rec.xref)!)
            : rec.xref
          : familyLabel(dataset, rec.xref),
    };
    const sourcePtrs = new Set<string>();
    const mediaPtrs = new Set<string>();
    collectPointers(rec, "SOUR", sourcePtrs);
    collectPointers(rec, "OBJE", mediaPtrs);
    for (const x of sourcePtrs) add(bySource, x, use);
    for (const x of mediaPtrs) add(byMedia, x, use);
  }
  return { bySource, byMedia };
}

export function buildSourceTree(dataset: Dataset): SourceTree {
  const objeIndex = buildObjeIndex(dataset.records);
  const repoIndex = buildRepoIndex(dataset.records);
  const { bySource, byMedia } = buildUsageIndex(dataset);

  const mediaEntry = (xref: string): MediaEntry => {
    const info = objeIndex.get(xref);
    return {
      xref,
      title: info?.title,
      url: info?.url,
      usedBy: byMedia.get(xref) ?? [],
    };
  };

  // Bucket sources by their holding repository, preserving file order.
  const repoGroups = new Map<string | undefined, SourceEntry[]>();
  const usedMedia = new Set<string>();
  let sourceCount = 0;

  for (const rec of dataset.records) {
    if (rec.tag !== "SOUR" || !rec.xref) continue;
    sourceCount++;
    const repoXref = rec.children.find((c) => c.tag === "REPO" && c.value)?.value?.trim();
    const media = rec.children
      .filter((c) => c.tag === "OBJE" && c.value && isPointer(c.value.trim()))
      .map((c) => {
        const x = c.value!.trim();
        usedMedia.add(x);
        return mediaEntry(x);
      });
    const entry: SourceEntry = {
      xref: rec.xref,
      title: childText(rec, "TITL") ?? childText(rec, "ABBR"),
      agency: childText(rec, "AGNC"),
      filingNumber: childText(rec, "FILN"),
      media,
      usedBy: bySource.get(rec.xref) ?? [],
    };
    const key = repoXref && repoIndex.has(repoXref) ? repoXref : undefined;
    const list = repoGroups.get(key);
    if (list) list.push(entry);
    else repoGroups.set(key, [entry]);
  }

  // Order: real repositories (file order) first, then the "no repository" bucket.
  const repos: RepoGroup[] = [];
  for (const rec of dataset.records) {
    if (rec.tag !== "REPO" || !rec.xref) continue;
    const sources = repoGroups.get(rec.xref);
    if (!sources) continue;
    const info = repoIndex.get(rec.xref);
    repos.push({ xref: rec.xref, name: info?.name, url: info?.url, sources });
  }
  const noRepo = repoGroups.get(undefined);
  if (noRepo) repos.push({ sources: noRepo });

  // Top-level media that no source attaches — cited directly by events.
  const unattachedMedia: MediaEntry[] = [];
  for (const rec of dataset.records) {
    if (rec.tag !== "OBJE" || !rec.xref) continue;
    if (usedMedia.has(rec.xref)) continue;
    if (!byMedia.has(rec.xref)) continue;
    unattachedMedia.push(mediaEntry(rec.xref));
  }

  return {
    repos,
    unattachedMedia,
    sourceCount,
    repoCount: repoIndex.size,
    mediaCount: objeIndex.size,
  };
}
