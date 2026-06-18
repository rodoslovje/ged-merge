import type { GedNode } from "../gedcom/types";

export interface RecordPatch {
  type: "individual" | "family";
  id: string;
  /** State before the action. null = this record was created by the action (undo removes it). */
  before: GedNode | null;
  /** State after the action. null = this record was deleted by the action (undo restores it). */
  after: GedNode | null;
}

export function cloneRaw(raw: GedNode): GedNode {
  return JSON.parse(JSON.stringify(raw)) as GedNode;
}

/** Queued by App.tsx after an undo/redo; consumed by EditView once it is mounted. */
export interface PendingEditApply {
  patches: RecordPatch[];
  direction: "undo" | "redo";
  navigateTo?: string;
  redoNavigateTo?: string;
}
