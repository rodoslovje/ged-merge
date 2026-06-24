import type { GedNode, Individual, Family } from "../../gedcom/types";
import type { RecordPatch } from "../historyTypes";
import type { EditSourceFields, EventFieldUpdate } from "../../gedcom/edit";

/** A mutation applied to the selected person's raw record, then rebuilt and
 * re-rendered. `extraPatches` carries undo/redo entries for any other
 * top-level record the mutation touched (e.g. a `SOUR`/`OBJE` created or
 * modified by "Add Source"). */
export type Commit = (mutate: (indi: Individual) => void, extraPatches?: RecordPatch[]) => void;

/** A mutation applied to a family's raw record, then rebuilt and
 * re-rendered — see `Commit` for `extraPatches`. */
export type FamilyCommit = (fam: Family, mutate: (fam: Family) => void, extraPatches?: RecordPatch[]) => void;

/** Where a confirmed "Add Source" citation should attach: the selected
 * person's own record, or a specific event (via its already-bound
 * `commitField`, so the dialog doesn't need to know which row it is). Or,
 * for "Edit Source", the existing citation being edited. Or, for a legacy
 * plain link (Links have been merged into Sources in the UI), its three
 * possible outcomes — built by whichever component owns that link's local
 * `links` array, since only it knows how to commit a plain rename/removal. */
export type SourceDialogTarget =
  | { kind: "individual" }
  | { kind: "event"; commitField: (update: EventFieldUpdate, extraPatches?: RecordPatch[]) => void }
  | { kind: "edit"; node: GedNode; index: number; owner: RemoveSourceOwner; fields: EditSourceFields }
  | {
      kind: "edit-link";
      url: string;
      /** Just the URL changed — stays a plain link, no `SOUR` record involved. */
      commitRename: (url: string) => void;
      /** Drop the link entirely. */
      commitRemove: () => void;
      /** Bibliographic fields were filled in too — promote it to a real `SOUR`
       * citation (using the already-resolved/created record) and drop the old
       * plain link in the same commit. */
      commitPromote: (sourceXref: string, page: string | undefined, extraPatches: RecordPatch[]) => void;
    };

/** Which top-level record a removed/edited `SOUR` citation's owner-snapshot
 * should be filed under — see `commitRemoveSource`/`commitEditSource`. */
export type RemoveSourceOwner = { kind: "individual"; indi: Individual } | { kind: "family"; fam: Family };
/** Removes the `index`th `SOUR` citation from `node` and commits it (with
 * undo-safe patches for any pruned `SOUR`/`OBJE`) — see `commitRemoveSource`. */
export type CommitRemoveSource = (node: GedNode, index: number, owner: RemoveSourceOwner) => void;
/** Opens the Edit Source dialog for the `index`th `SOUR` citation on `node` —
 * see `openEditSource`. Threaded down to event rows the same way
 * `CommitRemoveSource` used to be, now that removal lives inside that dialog. */
export type OpenEditSource = (node: GedNode, index: number, owner: RemoveSourceOwner) => void;
