import type { Dataset, GedNode } from "../gedcom/types";
import { noteInsertedXref, rebuildFamily, rebuildIndividual } from "../gedcom/edit";
import { bumpSourceCacheVersion } from "../gedcom/edit/cache";
import { firstChild } from "../gedcom/node";
import { clearObjeNodeCache } from "../gedcom/source";
import { familySearchPageUrl } from "../normalize/links";
import { cloneRaw, type RecordPatch } from "../ui/historyTypes";
import { reshapeSources, type ReshapeEnrichment, type ReshapeGroup, type ReshapeOptions } from "./sourceReshape";
import { dedupeSources, findSourceDuplicates, type DupGroup } from "./sourceDuplicates";
import { regroupRepositories, scanRepoRegroup, type RepoRegroupGroup } from "./repoRegroup";
import { linkMissingPageMedia, type PageMediaGroup } from "./pageMediaCheck";
import { applyPassSafely } from "./passSafety";

/**
 * Apply the Sources tools — Organize sources' reshape and the duplicate-source
 * merge — to the loaded file itself, the way every other Tools repair works:
 * the dataset changes in place and the whole run is one undoable step, taken
 * along by the next save, instead of arriving as a separate GEDCOM download.
 *
 * Both tools are pure whole-file rebuilders: they clone the record forest and
 * hand back a new one. So the change set is a diff — every record the rebuild
 * added, dropped or rewrote — and the transplant then swaps each rewritten
 * record's contents into the node the file already had, keeping the node
 * identity every typed `Individual.raw` points at.
 *
 * Neither tool creates or deletes a person or a family, only citations on
 * them; a new record is always a `SOUR`/`OBJE`/`REPO`, a dropped one always a
 * duplicate of those.
 */
export function applySourceCleanup(
  dataset: Dataset,
  reshape: { groups: ReshapeGroup[]; enrichment: ReshapeEnrichment; options: ReshapeOptions },
  dupGroups: DupGroup[],
  regroupGroups: RepoRegroupGroup[] = [],
  pageMediaGroups: PageMediaGroup[] = [],
): RecordPatch[] {
  const reshaped = reshape.groups.length
    ? reshapeSources(dataset.records, reshape.groups, reshape.enrichment, reshape.options).records
    : dataset.records;
  // Each later step was scanned on the file as it was before the run; it is
  // read again on the forest the step before it left, so it acts on records
  // that still exist — a regroup whose country repository the dedupe merged
  // away joins the one it kept rather than minting a fresh one.
  const dupsNow = dupGroups.length && reshaped !== dataset.records ? rescanDuplicates(reshaped, dupGroups) : dupGroups;
  const deduped = dupsNow.length ? dedupeSources(reshaped, dupsNow).records : reshaped;
  // The regroup runs last, so the sources the reshape just created are
  // gathered under their country's repository along with the older ones.
  const regroupNow = regroupGroups.length && deduped !== dataset.records ? rescanRegroup(deduped, regroupGroups) : regroupGroups;
  const regrouped = regroupNow.length ? regroupRepositories(deduped, regroupNow).records : deduped;
  // Last: the page images it links are the ones the passes above have finished
  // moving and merging, so a pointer is never written to a record that another
  // pass then drops.
  const next = linkMissingPageMedia(
    regrouped,
    new Set(pageMediaGroups.map((g) => g.sourceXref)),
  ).records;
  if (next === dataset.records) return [];

  // A media group merged away duplicates that differed only by viewer state —
  // with "Shorten links" on, the kept record's stored link is trimmed too, so
  // one apply leaves one record with one canonical link. The reshape's own
  // tidy pass only reaches media its conversion touches; the survivor of a
  // pure duplicate merge is this pass's to finish.
  if (reshape.options.tidyLinks) {
    for (const g of dupGroups) {
      if (g.kind !== "media") continue;
      const survivor = g.members.find((m) => m.survivor);
      const node = survivor && next.find((r) => r.tag === "OBJE" && r.xref === survivor.xref);
      const file = node && firstChild(node, "FILE");
      const stored = file?.value?.trim();
      const tidied = stored && familySearchPageUrl(stored);
      if (file && tidied && tidied !== stored) file.value = tidied;
    }
  }

  const patches = diffRecordForests(dataset.records, next);
  if (patches.length === 0) return [];
  // The live file changes only from here on; a throw while it does puts it
  // back from the patches' own `before` clones (see applyPassSafely).
  applyPassSafely(dataset, (journal) => {
    for (const p of patches) if (p.before) journal.keep(p.id, p.before);
    transplant(dataset, next);

    for (const p of patches) {
      if (p.type === "individual") {
        const indi = dataset.individuals.get(p.id);
        if (p.after === null) dataset.individuals.delete(p.id);
        else if (indi) rebuildIndividual(dataset, indi);
      } else if (p.type === "family") {
        const fam = dataset.families.get(p.id);
        if (p.after === null) dataset.families.delete(p.id);
        else if (fam) rebuildFamily(dataset, fam);
      }
    }
    // Sources and media the run created, retitled or merged away: the caches
    // that resolve a citation pointer must not answer from the old forest.
    bumpSourceCacheVersion(dataset.records);
    clearObjeNodeCache(dataset.records);
  });
  return patches;
}

/**
 * The selected duplicate groups as they stand in `records`, keeping the record
 * the reader chose to keep. A group the scan still finds is taken as it finds
 * it; one it no longer finds under its id (a retitle changed its key) keeps
 * its members that still exist, and is dropped once fewer than two — or not
 * the kept one — remain.
 */
function rescanDuplicates(records: GedNode[], selected: DupGroup[]): DupGroup[] {
  const present = new Set(records.map((r) => r.xref).filter(Boolean));
  const now = new Map(findSourceDuplicates({ records } as Dataset).groups.map((g) => [g.id, g]));
  const out: DupGroup[] = [];
  for (const g of selected) {
    const keep = g.members.find((m) => m.survivor)?.xref;
    const members = (now.get(g.id) ?? g).members.filter((m) => present.has(m.xref));
    if (!keep || members.length < 2 || !members.some((m) => m.xref === keep)) continue;
    out.push({ ...g, members: members.map((m) => ({ ...m, survivor: m.xref === keep })), removable: members.length - 1 });
  }
  return out;
}

/** The selected repository regroups as they stand in `records`: the country's
 *  repository and the sources still to move, read afresh. */
function rescanRegroup(records: GedNode[], selected: RepoRegroupGroup[]): RepoRegroupGroup[] {
  const ids = new Set(selected.map((g) => g.id));
  return scanRepoRegroup(records).groups.filter((g) => ids.has(g.id));
}

function patchType(rec: GedNode): RecordPatch["type"] {
  return rec.tag === "INDI" ? "individual" : rec.tag === "FAM" ? "family" : "record";
}

/** Every record that differs between two forests, as undo/redo patches: added
 *  (`before: null`), dropped (`after: null`, with the position it stood at, so
 *  undo puts it back there) or rewritten. Records the file carries without an
 *  xref — `HEAD`, `TRLR` — are not a tool's business and are not compared. */
function diffRecordForests(before: GedNode[], after: GedNode[]): RecordPatch[] {
  const nextByXref = new Map<string, GedNode>();
  for (const rec of after) if (rec.xref) nextByXref.set(rec.xref, rec);
  const patches: RecordPatch[] = [];
  const seen = new Set<string>();
  before.forEach((live, index) => {
    if (!live.xref) return;
    seen.add(live.xref);
    const now = nextByXref.get(live.xref);
    if (!now) {
      patches.push({ type: patchType(live), id: live.xref, before: cloneRaw(live), after: null, index });
      return;
    }
    if (JSON.stringify(live) === JSON.stringify(now)) return;
    patches.push({ type: patchType(live), id: live.xref, before: cloneRaw(live), after: cloneRaw(now) });
  });
  for (const rec of after) {
    if (rec.xref && !seen.has(rec.xref)) {
      patches.push({ type: patchType(rec), id: rec.xref, before: null, after: cloneRaw(rec) });
    }
  }
  return patches;
}

/** Make the dataset's own record list the rebuilt one — reusing each record's
 *  existing node, contents and all, so every `.raw` back-reference into the
 *  typed model still points at a record the file holds. */
function transplant(dataset: Dataset, next: GedNode[]): void {
  const liveByXref = new Map<string, GedNode>();
  const liveUnkeyed: GedNode[] = [];
  for (const rec of dataset.records) {
    if (rec.xref) liveByXref.set(rec.xref, rec);
    else liveUnkeyed.push(rec);
  }
  let unkeyed = 0;
  const merged = next.map((rec) => {
    const live = rec.xref ? liveByXref.get(rec.xref) : liveUnkeyed[unkeyed++];
    if (!live || live.tag !== rec.tag) {
      // A record the run created — allocated by nextXref against the *cloned*
      // forest, so the live array's own max-xref cache never saw it. Note it,
      // or the next hand-created source would be handed the same xref.
      noteInsertedXref(dataset.records, rec.xref);
      return rec;
    }
    live.value = rec.value;
    live.children = rec.children;
    return live;
  });
  dataset.records.splice(0, dataset.records.length, ...merged);
}
