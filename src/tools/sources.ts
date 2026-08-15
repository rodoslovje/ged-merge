import type { Dataset, GedNode } from "../gedcom/types";
import {
  buildObjeIndex,
  buildRepoIndex,
  childText,
  cropOf,
  isPointer,
  repoTooltip,
  sourceTitle,
  sourceTooltip,
  type CropRegion,
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

/** A single linkable person within a usage row. */
export interface PersonRef {
  /** Individual xref, e.g. "@I1@". */
  id: string;
  /** Fallback label, shown only when the individual can't be resolved. */
  label: string;
}

/** An `INDI`/`FAM` record that cites a source or media object — a navigate target. */
export interface SourceUse {
  /**
   * The person(s) to display and link: one for an `INDI` record, the spouses
   * for a `FAM` record. Rendered as standard person links (FAM records have no
   * individual page of their own to navigate to).
   */
  persons: PersonRef[];
  /** This record's GEDCOM 7 crop region for the media object — present only when
   *  the citing `OBJE` link marks a subregion (e.g. this person in a group photo).
   *  Populated by {@link mediaUsedBy}; lets the viewer move the highlight on hover. */
  crop?: CropRegion;
}

export interface MediaEntry {
  xref: string;
  title?: string;
  /** Resolvable URL, when the `FILE` is an absolute link rather than a local filename. */
  url?: string;
  /** The raw `FILE` value (URL or bare local filename), for display as a tooltip. */
  file?: string;
  /** Date the media depicts (level-1 `DATE`), if recorded. */
  date?: string;
  /** Place the media depicts (`PLAC`), if recorded. */
  place?: string;
  /** Free-text description (`_DSCR`/`NOTE`), if recorded. */
  description?: string;
  /** Records that cite this media object directly (not via its parent source). */
  usedBy: SourceUse[];
}

export interface SourceEntry {
  xref: string;
  title?: string;
  /** Every descriptive field on the record, for a hover tooltip. */
  tooltip: string;
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
  /** Every descriptive field on the REPO record, for a hover tooltip. */
  tooltip?: string;
  sources: SourceEntry[];
}

export interface SourceTree {
  repos: RepoGroup[];
  /** Top-level OBJE links (FILE is a URL) cited by no source. */
  unattachedLinks: MediaEntry[];
  /** Top-level OBJE media (FILE is a local filename) cited by no source. */
  unattachedMedia: MediaEntry[];
  sourceCount: number;
  repoCount: number;
  mediaCount: number;
}

/** Numeric-aware, case-insensitive collator for sorting tree levels by name. */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Sort sources/media by their display title (falling back to the xref). */
const byTitle = (a: { title?: string; xref: string }, b: { title?: string; xref: string }) =>
  collator.compare(a.title ?? a.xref, b.title ?? b.xref);

/** The spouse individuals of a family, each as an independently linkable ref. */
export function familySpouses(dataset: Dataset, famId: string): PersonRef[] {
  const fam = dataset.families.get(famId);
  if (!fam) return [];
  const refs: PersonRef[] = [];
  for (const spouseId of [fam.husband, fam.wife]) {
    const indi = spouseId && dataset.individuals.get(spouseId);
    if (indi) refs.push({ id: indi.id, label: label(indi) });
  }
  return refs;
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
    let persons: PersonRef[];
    if (rec.tag === "INDI") {
      const indi = dataset.individuals.get(rec.xref);
      persons = [{ id: rec.xref, label: indi ? label(indi) : rec.xref }];
    } else {
      persons = familySpouses(dataset, rec.xref);
    }
    if (persons.length === 0) continue;
    const use: SourceUse = { persons };
    const sourcePtrs = new Set<string>();
    const mediaPtrs = new Set<string>();
    collectPointers(rec, "SOUR", sourcePtrs);
    collectPointers(rec, "OBJE", mediaPtrs);
    for (const x of sourcePtrs) add(bySource, x, use);
    for (const x of mediaPtrs) add(byMedia, x, use);
  }
  return { bySource, byMedia };
}

/**
 * The `INDI`/`FAM` records that cite a single media object directly. Same shape
 * as one entry of {@link buildUsageIndex}'s `byMedia`, but scoped to one xref so
 * the photo viewer can show a media object's "referenced by" list without
 * building the whole source tree.
 */
export function mediaUsedBy(dataset: Dataset, mediaXref: string): SourceUse[] {
  const uses: SourceUse[] = [];
  for (const rec of dataset.records) {
    if (rec.tag !== "INDI" && rec.tag !== "FAM") continue;
    if (!rec.xref) continue;
    const mediaPtrs = new Set<string>();
    collectPointers(rec, "OBJE", mediaPtrs);
    if (!mediaPtrs.has(mediaXref)) continue;
    const persons =
      rec.tag === "INDI"
        ? [{ id: rec.xref, label: dataset.individuals.get(rec.xref) ? label(dataset.individuals.get(rec.xref)!) : rec.xref }]
        : familySpouses(dataset, rec.xref);
    if (persons.length > 0) uses.push({ persons, crop: objeLinkCrop(rec, mediaXref) });
  }
  return uses;
}

/**
 * The `INDI`/`FAM` records whose subtree points at `xref` under any tag — a
 * `SOUR` citation, an `OBJE` link, wherever it sits. The duplicates list's
 * "cited by N" opens this, the way a count opens its people elsewhere.
 */
export function recordCitedBy(dataset: Dataset, xref: string): SourceUse[] {
  const pointsAt = (node: GedNode): boolean =>
    node.children.some((c) => c.value?.trim() === xref || pointsAt(c));
  const uses: SourceUse[] = [];
  for (const rec of dataset.records) {
    if ((rec.tag !== "INDI" && rec.tag !== "FAM") || !rec.xref || !pointsAt(rec)) continue;
    const persons =
      rec.tag === "INDI"
        ? [{ id: rec.xref, label: dataset.individuals.get(rec.xref) ? label(dataset.individuals.get(rec.xref)!) : rec.xref }]
        : familySpouses(dataset, rec.xref);
    if (persons.length > 0) uses.push({ persons });
  }
  return uses;
}

/** The crop region on this record's `OBJE` link to `mediaXref`, if any — the
 *  subregion of the shared media that depicts the record (e.g. its person in a
 *  group photo). Walks descendants since a link can sit under an event. */
function objeLinkCrop(rec: GedNode, mediaXref: string): CropRegion | undefined {
  let crop: CropRegion | undefined;
  const walk = (node: GedNode) => {
    for (const child of node.children) {
      if (child.tag === "OBJE" && child.value?.trim() === mediaXref) {
        crop = crop ?? cropOf(child);
      }
      walk(child);
    }
  };
  walk(rec);
  return crop;
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
      file: info?.file,
      date: info?.date,
      place: info?.place,
      description: info?.description,
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
      })
      .sort(byTitle);
    const entry: SourceEntry = {
      xref: rec.xref,
      title: sourceTitle(rec),
      tooltip: sourceTooltip(rec),
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

  // Each level sorted by name: repositories alphabetically (the synthetic "no
  // repository" bucket always last), sources within each repository by title.
  const repos: RepoGroup[] = [];
  for (const rec of dataset.records) {
    if (rec.tag !== "REPO" || !rec.xref) continue;
    // A repository holding no sources still lists (with a 0 count) — it stays
    // visible, editable and reachable for the Add Source repository picker.
    const sources = repoGroups.get(rec.xref) ?? [];
    const info = repoIndex.get(rec.xref);
    repos.push({ xref: rec.xref, name: info?.name, url: info?.url, tooltip: repoTooltip(rec), sources: sources.sort(byTitle) });
  }
  repos.sort((a, b) => collator.compare(a.name ?? a.xref ?? "", b.name ?? b.xref ?? ""));
  const noRepo = repoGroups.get(undefined);
  if (noRepo) repos.push({ sources: noRepo.sort(byTitle) });

  // Top-level OBJE records that no source attaches — cited directly by events.
  // Split by whether the FILE is a URL (a link) or a local filename (media).
  const unattachedLinks: MediaEntry[] = [];
  const unattachedMedia: MediaEntry[] = [];
  for (const rec of dataset.records) {
    if (rec.tag !== "OBJE" || !rec.xref) continue;
    if (usedMedia.has(rec.xref)) continue;
    if (!byMedia.has(rec.xref)) continue;
    const entry = mediaEntry(rec.xref);
    (entry.url ? unattachedLinks : unattachedMedia).push(entry);
  }
  unattachedLinks.sort(byTitle);
  unattachedMedia.sort(byTitle);

  return {
    repos,
    unattachedLinks,
    unattachedMedia,
    sourceCount,
    repoCount: repoIndex.size,
    mediaCount: objeIndex.size,
  };
}
