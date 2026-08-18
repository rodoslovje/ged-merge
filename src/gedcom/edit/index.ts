/**
 * In-place mutation helpers for the Edit mode.
 *
 * Each helper mutates an individual's raw `GedNode` tree directly — the same
 * tree `serializeGedcom` walks — so edits round-trip with minimal diffs. After
 * mutating, call `rebuildIndividual` to re-derive the typed `Individual` (and
 * update `dataset.individuals`) without rebuilding the whole dataset.
 *
 * Split by concern: `shared` (canonical child orders + generic node/record
 * plumbing), `events`, `names`, `family` (structure/links), `records`
 * (record-level notes & links), `media`, `sources`, `cache` (lazy
 * media/source indexes + typed-model rebuilds). This barrel is the module's
 * public API — import from `../gedcom/edit`, not the individual files.
 */

export {
  EVENT_CHILD_ORDER, FAM_CHILD_ORDER, INDI_CHILD_ORDER, NAME_CHILD_ORDER,
  EDITABLE_LINK_TAGS, EVENT_LINK_TAG, clearEventAuditStamps, insertGrouped, insertOrdered, insertRecord, insertRecordAt, markEventTouched, nextXref,
} from "./shared";

export {
  applyEventNodeUpdate, setEventField, setEventFieldAtIndex, changeEventTagAtIndex,
  removeEventAtIndex, restoreEvent, addEventField, addEventNode,
  setFamilyEventField, changeFamilyEventTag, addFamilyEventNode, removeFamilyEvent,
  copyEventToIndividual, copyEventToFamily, individualCopyBlock, familyCopyBlock,
} from "./events";
export type { EventFieldUpdate, CopyEventBlock } from "./events";

export {
  setName, setNickname, setMarriedName, setAdditionalName,
  foldAdditionalNameToMarnm, addAdditionalName, removeAdditionalName, setSex,
  writeNameValue,
} from "./names";
export type { NameVariantUpdate } from "./names";

export {
  addIndividual, addFamily, addParent, addPartner, addChild,
  connectExistingParent, connectExistingPartner, connectExistingChild,
  pruneDegenerateFamily, detachSpouseRole, detachChildFromFamily,
  removeIndividual, removeFamily,
} from "./family";

export { setNotes, setFamilyNotes, setIndividualLinks, setFamilyLinks, setFsIds, preferredFsIdTag, type FsIdTag } from "./records";

export {
  noteCtx, applyNoteRefs, setSharedNoteText, setSharedNotePrivate,
  removeNoteRecordIfOrphaned, countNoteRefs, rebuildNoteReferrers,
} from "./notes";
export type { SharedNoteChange, SharedNoteCtx } from "./notes";

export {
  createMediaRecord, findSharedMediaByFile, attachInlineMedia, attachMediaPointer,
  removeMediaAt, reorderMedia, setMediaInfo, setCropRegion, pruneUnreferencedMedia,
} from "./media";
export type { MediaInfoFields } from "./media";

export {
  createSourceRecord, createRepoRecord, addObjeToSource, attachSourceCitation,
  updateSourceCitation, removeSourceCitationAtIndex, pruneUnreferencedSource,
  setSourceRecordFields, sourceRecordEditFields, setRepoRecordFields, repoRecordEditFields,
} from "./sources";
export type { EditSourceFields, EditRepoFields, NewSourceFields } from "./sources";

export { bumpSourceCacheVersion, getMediaAndSourceCtx, rebuildIndividual, rebuildFamily } from "./cache";

export { clearPlaceGov, formatCoordValue, setPlaceCoord } from "./geo";
