import type { Dataset, GedNode } from "../../gedcom/types";
import { cloneNode, nodesEqual } from "../../gedcom/node";
import { familyMembers, pointersHeld, pruneRecordsLeftBehind, removeFamily } from "../../gedcom/edit";
import { applyRecordPatches, patchesFromSnapshots, snapshotRecords, type RecordPatch } from "../historyTypes";
import { deletePerson } from "./deletePerson";

/** What the dirty tracking knows about the record being taken out of a save. */
export interface RevertTracking {
  /** The record was in the file when it loaded (vs. created this session). */
  loaded: boolean;
  /** Its first-dirty snapshot — the record as the file had it. */
  snapshot?: GedNode;
  /** Shared records (NOTE/OBJE/SOUR) whose edits were made through this
   *  record's card, as they stood before: reverted along with it. */
  ownedRecords: [string, GedNode][];
  /** Whether a shared record was in the file when it loaded. */
  wasLoadedRecord: (xref: string) => boolean;
}

const LINK_TAGS = { individual: ["FAMS", "FAMC"], family: ["HUSB", "WIFE", "CHIL"] } as const;

/** The record's family links, order aside — the lines the other side of each
 *  link mirrors. */
function linkKey(kind: "individual" | "family", raw: GedNode): string {
  const tags: readonly string[] = LINK_TAGS[kind];
  return raw.children
    .filter((c) => tags.includes(c.tag))
    .map((c) => `${c.tag} ${c.value?.trim() ?? ""}`)
    .sort()
    .join("\n");
}

/**
 * Whether "Remove from save" can take this record out without breaking a link.
 * A record created this session is deleted whole, which unlinks it properly.
 * A loaded one is put back to its snapshot — safe only when the edit left its
 * family links as they were: an edit that added a relative linked the person
 * into a family whose own lines would keep naming them, and one that took a
 * family away would leave the restored pointer naming a family that no longer
 * lists them.
 */
export function canRemoveFromSave(
  dataset: Dataset,
  kind: "individual" | "family",
  id: string,
  tracking: Pick<RevertTracking, "loaded" | "snapshot">,
): boolean {
  if (!tracking.loaded) return true;
  const raw = (kind === "individual" ? dataset.individuals : dataset.families).get(id)?.raw;
  if (!raw || !tracking.snapshot) return false;
  return linkKey(kind, raw) === linkKey(kind, tracking.snapshot);
}

/**
 * Take one person or family out of the pending save, mutating the dataset, and
 * return the undo patches for everything that changed. A record created this
 * session is deleted (see {@link deletePerson}); a loaded one returns to its
 * snapshot together with the shared records edited through it, and the shared
 * records its edit created that nothing points at any more go too. Returns an
 * empty list when {@link canRemoveFromSave} says no.
 */
export function removeFromSave(
  dataset: Dataset,
  kind: "individual" | "family",
  id: string,
  tracking: RevertTracking,
): RecordPatch[] {
  if (!canRemoveFromSave(dataset, kind, id, tracking)) return [];
  if (!tracking.loaded) return kind === "individual" ? deleteCreatedPerson(dataset, id) : deleteCreatedFamily(dataset, id);

  const raw = (kind === "individual" ? dataset.individuals : dataset.families).get(id)!.raw;
  const held = pointersHeld(raw);
  const owner = { kind, id };
  const patches: RecordPatch[] = [{ type: kind, id, before: cloneNode(raw), after: cloneNode(tracking.snapshot!) }];
  for (const [xref, snap] of tracking.ownedRecords) {
    const existing = dataset.records.find((r) => r.xref === xref);
    if (existing && nodesEqual(existing, snap)) continue;
    if (existing) pointersHeld(existing, held);
    patches.push({ type: "record", id: xref, before: existing ? cloneNode(existing) : null, after: cloneNode(snap), owner });
  }
  applyRecordPatches(dataset, patches, "redo");
  patches.push(...prunePatches(dataset, [...held].filter((x) => !tracking.wasLoadedRecord(x))));
  return patches;
}

function deleteCreatedPerson(dataset: Dataset, id: string): RecordPatch[] {
  const indi = dataset.individuals.get(id);
  return indi ? deletePerson(dataset, indi) : [];
}

function deleteCreatedFamily(dataset: Dataset, id: string): RecordPatch[] {
  const fam = dataset.families.get(id);
  if (!fam) return [];
  const held = pointersHeld(fam.raw);
  const before = snapshotRecords(dataset, familyMembers(dataset, fam), [id]);
  const position = positions(dataset);
  removeFamily(dataset, fam);
  return [...patchesFromSnapshots(dataset, before), ...prunePatches(dataset, held, position)];
}

function positions(dataset: Dataset): Map<string, number> {
  const out = new Map<string, number>();
  dataset.records.forEach((r, i) => { if (r.xref) out.set(r.xref, i); });
  return out;
}

/** Prune the shared records among `candidates` nothing points at any more,
 *  as deletion patches indexed against the file before the prune. */
function prunePatches(dataset: Dataset, candidates: Iterable<string>, position = positions(dataset)): RecordPatch[] {
  return pruneRecordsLeftBehind(dataset, candidates).map((rec) => {
    const index = position.get(rec.xref!);
    return { type: "record" as const, id: rec.xref!, before: rec, after: null, ...(index !== undefined ? { index } : {}) };
  });
}
