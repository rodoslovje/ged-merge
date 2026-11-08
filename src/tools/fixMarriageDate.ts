import type { Dataset } from "../gedcom/types";
import { rebuildFamily, setFamilyEventField } from "../gedcom/edit";
import { cloneNode } from "../gedcom/node";
import { type RecordPatch } from "../ui/historyTypes";
import type { MarriageDateFix } from "./validate";

/**
 * The "Born before the marriage" repair: a marriage the file only estimates
 * (ABT 1775) or bounds (BEF 1773) gets the date its eldest child's stated
 * birth proves — `BEF` that birth. One write per family, however many of its
 * children raised the finding. Returns `RecordPatch[]` for the undo stack.
 */
export function fixMarriageDates(dataset: Dataset, fixes: readonly MarriageDateFix[]): RecordPatch[] {
  const patches: RecordPatch[] = [];
  const byFamily = new Map(fixes.map((f) => [f.famId, f.value]));
  for (const [famId, value] of byFamily) {
    const fam = dataset.families.get(famId);
    if (!fam || fam.events.find((e) => e.tag === "MARR")?.date?.raw === value) continue;
    const before = cloneNode(fam.raw);
    setFamilyEventField(fam, "MARR", { date: value });
    rebuildFamily(dataset, fam);
    patches.push({ type: "family", id: famId, before, after: cloneNode(fam.raw) });
  }
  return patches;
}
