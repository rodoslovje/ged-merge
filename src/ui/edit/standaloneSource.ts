import type { GedNode } from "../../gedcom/types";
import { firstChild } from "../../gedcom/node";
import { createRepoRecord, createSourceRecord, type NewSourceFields } from "../../gedcom/edit";
import { applySiteSourceExtras, createSiteRepo, type ReshapeSite } from "../../tools/sourceReshape";
import type { SourceLayout } from "../../normalize/types";
import { cloneRaw, type RecordPatch } from "../historyTypes";
import type { AddSourceResult } from "../AddSourceDialog";

/** Page media titled the way the cleanup tool titles them (`#page - title`) —
 * only for recognized-site sources, whose OBJE is a page image of a register. */
export function pageObjeTitle(
  site: ReshapeSite | undefined,
  title: string | undefined,
  page: string | undefined,
): string | undefined {
  return site && title ? (page ? `#${page} - ${title}` : title) : undefined;
}

/**
 * Create a brand-new top-level `SOUR` record (plus its `OBJE` page image and
 * `REPO` extras where applicable) from the Add Source dialog's fields, and
 * return the undoable record patches. Shared by the Edit view (which then
 * attaches a citation to the person/family) and the Tools → Sources panel
 * (which adds the source on its own, cited by nothing yet).
 */
export function createStandaloneSource(
  records: GedNode[],
  fields: AddSourceResult,
  opts: { sourceLayout: SourceLayout | "auto" },
): { sourceXref: string; page?: string; pageObjeXref?: string; extraPatches: RecordPatch[] } {
  const extraPatches: RecordPatch[] = [];
  const sourceNode = createSourceRecord(records, fields as NewSourceFields);
  // The dialog's Repository dropdown sends an explicit choice (an existing
  // xref, "" for none, or create-the-site's); without one — older callers —
  // the automatic site-repo behavior applies as before.
  const explicitRepo = fields.repoXref !== undefined || fields.repoCreateSite || !!fields.repoCreateName?.trim();
  if (fields.site || fields.place || fields.dateRange) {
    // A recognized site URL gets the same PLAC/DATE/REPO extras the
    // Organize sources tool writes, so it needs no cleanup pass later;
    // a hand-entered place still lands as PLAC in the file's place format.
    const repo = applySiteSourceExtras(records, sourceNode, fields.site, fields.url ?? "", fields, {
      sourceLayout: opts.sourceLayout,
      repo: explicitRepo ? "none" : "auto",
    });
    if (repo) extraPatches.push({ type: "record", id: repo.xref!, before: null, after: cloneRaw(repo) });
  }
  if (explicitRepo) {
    let repoXref = fields.repoXref?.trim() || undefined;
    const createName = fields.repoCreateName?.trim();
    if (!repoXref && createName) {
      const repo = createRepoRecord(records, createName);
      repoXref = repo.xref!;
      extraPatches.push({ type: "record", id: repo.xref!, before: null, after: cloneRaw(repo) });
    }
    if (!repoXref && fields.repoCreateSite && fields.site) {
      const repo = createSiteRepo(records, fields.site, fields.url ?? "", fields.agency, fields.collection);
      if (repo) {
        repoXref = repo.xref!;
        extraPatches.push({ type: "record", id: repo.xref!, before: null, after: cloneRaw(repo) });
      }
    }
    if (repoXref) {
      const repoLink: GedNode = { level: 1, tag: "REPO", value: repoXref, children: [] };
      const caln = fields.repoCaln?.trim();
      if (caln) repoLink.children.push({ level: 2, tag: "CALN", value: caln, children: [] });
      sourceNode.children.push(repoLink);
    }
  }
  extraPatches.push({ type: "record", id: sourceNode.xref!, before: null, after: cloneRaw(sourceNode) });
  const objeChild = firstChild(sourceNode, "OBJE");
  if (objeChild?.value) {
    const objeNode = records.find((r) => r.tag === "OBJE" && r.xref === objeChild.value);
    if (objeNode) {
      const title = pageObjeTitle(fields.site, fields.title, fields.page);
      if (title) objeNode.children.push({ level: 1, tag: "TITL", value: title, children: [] });
      extraPatches.push({ type: "record", id: objeNode.xref!, before: null, after: cloneRaw(objeNode) });
    }
  }
  return { sourceXref: sourceNode.xref!, page: fields.page, pageObjeXref: objeChild?.value, extraPatches };
}
