import type { Dataset, GedNode } from "../gedcom/types";
import { isPointer, looksLikeUrl, objeInfoOf, objeNodesFor } from "../gedcom/source";
import { label } from "../match/relatives";
import { familySpouses, type PersonRef, type SourceUse } from "./sources";

/**
 * Whether a `FILE` value points at the web rather than a local file. `looksLikeUrl`
 * only matches a value that *starts* with the scheme; some exporters write a
 * labelled link (e.g. `"#018 - https://data.matricula-online.eu/…"`) where the
 * URL trails a caption, so we also catch an `http(s)://` anywhere in the value.
 * Either way it isn't in the media folder, so the folder check skips it — a
 * filename can't legitimately contain `://`, so this won't drop real local files.
 */
function isWebFile(file: string): boolean {
  return looksLikeUrl(file) || /https?:\/\//i.test(file);
}

/**
 * Collect every distinct **local** media file referenced by the dataset, with
 * the `INDI`/`FAM` records that reference it — the input to the Tools-tab "check
 * photo folder" health check, which resolves each path against the loaded media
 * folder and reports the ones that are missing.
 *
 * Pure and synchronous: it gathers the file paths and usage links here, leaving
 * the (async, folder-dependent) existence check to the UI. URL `FILE` values are
 * skipped — they live on the web, not in the folder, so there's nothing to find.
 */

export interface MediaFileUse {
  /** The raw local `FILE` value as written in the GEDCOM (path or bare filename). */
  file: string;
  /** Media title from the `OBJE`/`FILE`, when recorded. */
  title?: string;
  /** `INDI`/`FAM` records that reference this file — the navigate targets. */
  usedBy: SourceUse[];
}

/** Numeric-aware, case-insensitive collator for ordering the report. */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function collectLocalMediaFiles(dataset: Dataset): MediaFileUse[] {
  const objeNodes = objeNodesFor(dataset.records);
  // Keyed by the lowercased file string so two references to the same file
  // (even with different case) coalesce into one row with both usages.
  const byKey = new Map<string, MediaFileUse>();
  // Shared OBJE records already reached via an INDI/FAM pointer, so the
  // trailing top-level pass doesn't list them a second time.
  const seenXrefs = new Set<string>();

  const addUse = (file: string, title: string | undefined, persons: PersonRef[]) => {
    const key = file.toLowerCase();
    let entry = byKey.get(key);
    if (!entry) {
      entry = { file, title, usedBy: [] };
      byKey.set(key, entry);
    } else if (!entry.title && title) {
      entry.title = title;
    }
    if (persons.length) entry.usedBy.push({ persons });
  };

  // Every OBJE in a record subtree (event-level photos included), resolved
  // through its pointer to the shared record when it isn't an inline block.
  const walk = (node: GedNode, persons: PersonRef[]) => {
    for (const child of node.children) {
      if (child.tag === "OBJE") {
        const val = child.value?.trim();
        const objeNode = val && isPointer(val) ? objeNodes.get(val) : child;
        if (!objeNode) continue;
        if (objeNode.xref) seenXrefs.add(objeNode.xref);
        const info = objeInfoOf(objeNode);
        if (info.file && !isWebFile(info.file)) addUse(info.file, info.title, persons);
      } else {
        walk(child, persons);
      }
    }
  };

  for (const rec of dataset.records) {
    if ((rec.tag !== "INDI" && rec.tag !== "FAM") || !rec.xref) continue;
    let persons: PersonRef[];
    if (rec.tag === "INDI") {
      const indi = dataset.individuals.get(rec.xref);
      persons = [{ id: rec.xref, label: indi ? label(indi) : rec.xref }];
    } else {
      persons = familySpouses(dataset, rec.xref);
    }
    if (persons.length === 0) continue;
    walk(rec, persons);
  }

  // Shared OBJE records reached by no INDI/FAM (e.g. cited only by a source):
  // still report a missing file, just with no person to navigate to.
  for (const rec of dataset.records) {
    if (rec.tag !== "OBJE" || !rec.xref || seenXrefs.has(rec.xref)) continue;
    const info = objeInfoOf(rec);
    if (info.file && !isWebFile(info.file)) addUse(info.file, info.title, []);
  }

  return [...byKey.values()].sort((a, b) =>
    collator.compare(a.title ?? a.file, b.title ?? b.file),
  );
}
