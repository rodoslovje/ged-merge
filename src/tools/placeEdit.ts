import type { Dataset, GedNode } from "../gedcom/types";
import { placeCollator } from "../gedcom/place";
import { cloneRaw } from "../ui/historyTypes";
import { rebuildIndividual, rebuildFamily } from "../gedcom/edit";
import { reconcilePlaceForm } from "../gedcom/edit/geo";
import type { RecordPatch } from "../ui/historyTypes";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace matching segments in a PLAC/ADDR value. Handles two forms:
 *  1. Exact comma segment:   "Sveti Nikole, Macedonia (FYR)" → "Sveti Nikole, North Macedonia"
 *     The tree shows the raw segment text, so node.name = "Macedonia (FYR)" and from
 *     matches it exactly.
 *  2. Parenthetical country: "Skopje (Macedonia)" → "Skopje (North Macedonia)"
 *     Where the country was extracted from a parenthetical in another segment.
 * Returns null if nothing changed.
 */
function renameInValue(raw: string, from: string, to: string): string | null {
  let result = raw;
  let changed = false;

  // 1. Comma-separated segments — exact match on trimmed value.
  const parts = result.split(",");
  if (to === "") {
    // Deletion: remove the matching segment(s) entirely rather than leaving an empty slot.
    const filtered = parts.filter((p) => {
      if (p.trim() !== from) return true;
      changed = true;
      return false;
    });
    if (changed) result = filtered.join(",");
  } else {
    // When `to` appends extra jurisdiction levels (e.g. "England" → "England,United Kingdom"),
    // skip a segment whose immediately-following neighbours already carry those extra levels,
    // so places already correctly placed don't get a duplicate parent injected.
    const appendedSegs = to.split(",").slice(from.split(",").length).map((s) => s.trim());
    const newParts = parts.map((p, i) => {
      if (p.trim() !== from) return p;
      // Skip empty segments when looking ahead so "England,,United Kingdom" is treated
      // the same as "England, United Kingdom" and doesn't get a duplicate parent.
      const nextNonEmpty = parts.slice(i + 1).map((s) => s.trim()).filter((s) => s.length > 0);
      if (
        appendedSegs.length > 0 &&
        appendedSegs.every((seg, j) => nextNonEmpty[j]?.toLowerCase() === seg.toLowerCase())
      ) return p;
      changed = true;
      return p.replace(from, to);
    });
    if (changed) result = newParts.join(",");
  }

  // 2. Bracketed country form: "(Macedonia)" / "[Macedonia]" → "(North Macedonia)".
  //    The bracket kind already in the file is kept.
  //    Skipped for deletion (empty `to`) — removing a parenthetical leaves "()".
  if (to !== "") {
    const parenRe = new RegExp(`([([])(\\s*)${escapeRegex(from)}(\\s*)([)\\]])`, "g");
    const parenResult = result.replace(parenRe, (full, open, lead, trail, close) =>
      (open === "(") === (close === ")") ? `${open}${lead}${to}${trail}${close}` : full,
    );
    if (parenResult !== result) {
      result = parenResult;
      changed = true;
    }
  }

  return changed ? result : null;
}

/** Recursively rename matching PLAC/ADDR segments in a GedNode subtree. Returns true if anything changed. */
function renameInNode(node: GedNode, from: string, to: string): boolean {
  let changed = false;
  for (const child of node.children) {
    if ((child.tag === "PLAC" || child.tag === "ADDR") && child.value) {
      const next = renameInValue(child.value, from, to);
      if (next !== null) {
        const prev = child.value;
        child.value = next;
        // A FORM names each comma part of the value it sits on; a rename that
        // changes how many parts there are leaves it describing something else.
        if (child.tag === "PLAC") reconcilePlaceForm(child, undefined, prev);
        changed = true;
      }
    }
    if (renameInNode(child, from, to)) changed = true;
  }
  return changed;
}

export interface PlaceRenamePreview {
  /** Number of INDI/FAM records that contain the segment and will be updated. */
  affectedCount: number;
  /** Up to 5 raw PLAC/ADDR value examples showing before → after. */
  examples: Array<{ before: string; after: string }>;
}

/** Non-destructive preview: how many records would change and sample before/after strings. */
export function previewPlaceRename(dataset: Dataset, from: string, to: string, scope?: Set<string>): PlaceRenamePreview {
  const examples: Array<{ before: string; after: string }> = [];
  let affectedCount = 0;

  function scanNode(node: GedNode): boolean {
    let hit = false;
    for (const child of node.children) {
      if ((child.tag === "PLAC" || child.tag === "ADDR") && child.value) {
        const next = renameInValue(child.value, from, to);
        if (next !== null) {
          if (examples.length < 5) examples.push({ before: child.value, after: next });
          hit = true;
        }
      }
      if (scanNode(child)) hit = true;
    }
    return hit;
  }

  for (const indi of dataset.individuals.values()) {
    if (scope && !scope.has(indi.id)) continue;
    if (scanNode(indi.raw)) affectedCount++;
  }
  for (const fam of dataset.families.values()) {
    if (scope && !scope.has(fam.id)) continue;
    if (scanNode(fam.raw)) affectedCount++;
  }

  return { affectedCount, examples };
}

/**
 * Rename a place segment across all PLAC/ADDR values. Mutates the dataset in place
 * and returns RecordPatch[] for the undo stack. When `scope` is provided, only
 * records whose ID is in the set are modified.
 */
export function applyPlaceRename(dataset: Dataset, from: string, to: string, scope?: Set<string>): RecordPatch[] {
  const patches: RecordPatch[] = [];

  for (const indi of dataset.individuals.values()) {
    if (scope && !scope.has(indi.id)) continue;
    const before = cloneRaw(indi.raw);
    if (renameInNode(indi.raw, from, to)) {
      rebuildIndividual(dataset, indi);
      patches.push({ type: "individual", id: indi.id, before, after: cloneRaw(indi.raw) });
    }
  }

  for (const fam of dataset.families.values()) {
    if (scope && !scope.has(fam.id)) continue;
    const before = cloneRaw(fam.raw);
    if (renameInNode(fam.raw, from, to)) {
      rebuildFamily(dataset, fam);
      patches.push({ type: "family", id: fam.id, before, after: cloneRaw(fam.raw) });
    }
  }

  return patches;
}

/** All distinct non-empty comma-separated segments from all PLAC/ADDR values in the dataset. */
export function collectPlaceSegments(dataset: Dataset): string[] {
  const segs = new Set<string>();

  function collect(node: GedNode) {
    for (const child of node.children) {
      if ((child.tag === "PLAC" || child.tag === "ADDR") && child.value) {
        for (const part of child.value.split(",")) {
          const s = part.trim();
          if (s) segs.add(s);
        }
      }
      collect(child);
    }
  }

  for (const indi of dataset.individuals.values()) collect(indi.raw);
  for (const fam of dataset.families.values()) collect(fam.raw);

  return [...segs].sort((a, b) => placeCollator.compare(a, b));
}
