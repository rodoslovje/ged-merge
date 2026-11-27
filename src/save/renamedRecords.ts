import { xrefLabel } from "../gedcom/nameDisplay";
import type { GedNode } from "../gedcom/types";
import type { Translate } from "../locales/i18n";
import type { ChangeReport } from "../merge/merge";

/**
 * A record that only changed its id reads as one edited record, not as one
 * removed and one added.
 *
 * A rename (the health check's fix for an id the GEDCOM version refuses) cannot
 * be told from a delete plus a create by the change tracking: its patches are
 * keyed by xref, so the old id leaves and the new one arrives. Left at that,
 * the preview prints the record twice in full — once red, once green — and the
 * reader has to find the one character that differs.
 *
 * So a removed record and a new one whose lines are the same apart from the id
 * are paired here: the removed card goes, the new one becomes an edit with a
 * single "Record ID" row, and `before` gains the old record under the new id so
 * the line diff shows exactly the `0 @…@` line changing.
 *
 * A record renamed *and* edited in the same session is not paired — its two
 * versions no longer match — and still shows as removed and new.
 */
export function pairRenamedRecords(
  report: ChangeReport,
  records: GedNode[],
  before: Map<string, GedNode>,
  t: Translate,
): void {
  const removedIds = new Set<string>();
  const newIds = new Set<string>();
  for (const c of report.changes) {
    if (c.removedRecord) removedIds.add(c.recordId);
    else if (c.newRecord) newIds.add(c.recordId);
  }
  if (removedIds.size === 0 || newIds.size === 0) return;

  // The removed records by what they hold, each waiting for a new record that
  // holds the same.
  const waiting = new Map<string, string[]>();
  for (const id of removedIds) {
    const node = before.get(id);
    if (!node) continue;
    const key = contentKey(node, id);
    const ids = waiting.get(key);
    if (ids) ids.push(id);
    else waiting.set(key, [id]);
  }
  if (waiting.size === 0) return;

  /** New id → the id the record had. */
  const renamed = new Map<string, string>();
  for (const record of records) {
    if (!record.xref || !newIds.has(record.xref) || renamed.has(record.xref)) continue;
    const oldId = waiting.get(contentKey(record, record.xref))?.shift();
    if (oldId) renamed.set(record.xref, oldId);
  }
  if (renamed.size === 0) return;

  const gone = new Set(renamed.values());
  const rowed = new Set<string>();
  report.changes = report.changes.flatMap((c) => {
    if (gone.has(c.recordId)) return [];
    const oldId = renamed.get(c.recordId);
    if (!oldId) return [c];
    // Everything said about the "new" record described its whole contents as
    // an addition; the one thing that happened to it is the id.
    if (rowed.has(c.recordId)) return [];
    rowed.add(c.recordId);
    return [
      { recordId: c.recordId, field: "", from: "", to: "", action: "incoming" as const },
      { recordId: c.recordId, field: t("preview.field.recordId"), from: xrefLabel(oldId), to: xrefLabel(c.recordId), action: "incoming" as const },
    ];
  });
  for (const [newId, oldId] of renamed) {
    const kind = report.recordKinds[newId];
    if (kind === "individual") report.newPersons--;
    else if (kind === "family") report.newFamilies--;
    delete report.recordLabels[oldId];
    delete report.recordKinds[oldId];
    delete report.familySpouses[oldId];
    before.set(newId, before.get(oldId)!);
  }
  report.recordsChanged = new Set(report.changes.map((c) => c.recordId)).size;
}

/** A record's lines as one string, its own id left out: the record line's
 *  xref, and any line beneath it pointing back at the record. */
function contentKey(node: GedNode, own: string): string {
  const parts: string[] = [];
  const walk = (n: GedNode, depth: number): void => {
    const value = n.value?.trim() === own ? "@" : n.value ?? "";
    parts.push(`${depth} ${n.spelling ?? n.tag} ${value}`);
    for (const c of n.children) walk(c, depth + 1);
  };
  walk(node, 0);
  return parts.join("\n");
}
