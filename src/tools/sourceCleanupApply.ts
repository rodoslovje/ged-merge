import type { Dataset, GedNode } from "../gedcom/types";
import { rebuildFamily, rebuildIndividual } from "../gedcom/edit";
import { bumpSourceCacheVersion } from "../gedcom/edit/cache";
import { firstChild } from "../gedcom/node";
import { clearObjeNodeCache } from "../gedcom/source";
import { familySearchPageUrl } from "../normalize/links";
import { cloneRaw, type RecordPatch } from "../ui/historyTypes";
import { reshapeSources, type ReshapeEnrichment, type ReshapeGroup, type ReshapeOptions } from "./sourceReshape";
import { dedupeSources, type DupGroup } from "./sourceDuplicates";

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
): RecordPatch[] {
  const reshaped = reshape.groups.length
    ? reshapeSources(dataset.records, reshape.groups, reshape.enrichment, reshape.options).records
    : dataset.records;
  const next = dupGroups.length ? dedupeSources(reshaped, dupGroups).records : reshaped;
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
  return patches;
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
    if (!live || live.tag !== rec.tag) return rec; // a record the run created
    live.value = rec.value;
    live.children = rec.children;
    return live;
  });
  dataset.records.splice(0, dataset.records.length, ...merged);
}
