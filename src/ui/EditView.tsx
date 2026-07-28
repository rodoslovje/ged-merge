import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { type RecordPatch, type PendingEditApply, cloneRaw, noteChangePatches, snapshotRecords, patchesFromSnapshots } from "./historyTypes";
import { useTranslation } from "react-i18next";
import type { Dataset, Family, GedNode, GeoCoord, Individual } from "../gedcom/types";
import { birthDateOf } from "../gedcom/lifespan";
import { coupleAgesDisplay, lifespanWithAge } from "../gedcom/age";
import { isSameSexCouple } from "../gedcom/couple";
import { childrenByTag, firstChild } from "../gedcom/node";
import { defaultStartId, primaryName } from "../match/relatives";
import { splitFullName } from "../gedcom/name";
import { AddPersonIcon } from "./icons/AddPersonIcon";
import { useNameOf, useSettings } from "./SettingsContext";
import { useChartSettings, type ChartKind } from "./ChartSettingsContext";
import { BackButton } from "./BackButton";
import { ChartIcon } from "./icons/ChartIcon";
import { kinshipInfo, kinshipTooltip as kinshipTooltipText, lineageClass } from "../match/kinship";
import { decisionKey, decisionStatusByMainId, type CandidateDecision, type MatchDecisionStatus } from "../review/types";
import {
  addChild,
  addEventNode,
  addIndividual,
  addObjeToSource,
  addParent,
  addPartner,
  attachInlineMedia,
  attachMediaPointer,
  attachSourceCitation,
  bumpSourceCacheVersion,
  connectExistingChild,
  connectExistingParent,
  connectExistingPartner,
  copyEventToFamily,
  copyEventToIndividual,
  createMediaRecord,
  createSourceRecord,
  findSharedMediaByFile,
  removeMediaAt,
  reorderMedia,
  setCropRegion,
  setMediaInfo,
  detachChildFromFamily,
  detachSpouseRole,
  FAM_CHILD_ORDER,
  getMediaAndSourceCtx,
  EVENT_CHILD_ORDER,
  INDI_CHILD_ORDER,
  insertOrdered,
  insertRecord,
  insertRecordAt,
  noteCtx,
  rebuildFamily,
  rebuildIndividual,
  rebuildNoteReferrers,
  removeIndividual,
  removeSourceCitationAtIndex,
  setIndividualLinks,
  setName,
  setNotes,
  updateSourceCitation,
  type EditSourceFields,
  type NewSourceFields,
  type SharedNoteChange,
  type SharedNoteCtx,
} from "../gedcom/edit";
import { childText, clearObjeNodeCache, findExistingSource, isPointer, resolveSourceCitation, sourceTitle, type CropRegion } from "../gedcom/source";
import { applySiteSourceExtras, detectPageMediaStyle, smartCitationTarget } from "../tools/sourceReshape";
import { detectMediaMode } from "../gedcom/media";
import { useMediaFolder } from "./MediaFolderContext";
import { AddSourceDialog, type AddSourceResult } from "./AddSourceDialog";
import { AddMediaDialog } from "./AddMediaDialog";
import { nodeId } from "./edit/nodeId";
import { useStableHandler } from "./edit/useStableHandler";
import { useMergeOverlay } from "./edit/useMergeOverlay";
import { buildPlaceSuggestions } from "./edit/placeSuggestions";
import { CoordShareProvider, type CoordShare } from "./edit/CoordShareContext";
import { PlaceLookupProvider, usePlaceLookupValue } from "./edit/PlaceLookupContext";
import { applyGeocodeByAddress, placeAddrKey, walkPlaceAddr } from "../tools/geocode";
import { INDIVIDUAL_EVENT_GROUPS } from "./edit/editConstants";
import { KEY, KEY_STATUS, isEditableTarget, isModalOpen } from "../keyboard/shortcuts";
import type { Commit, FamilyCommit, MediaOwner, SourceDialogTarget, RemoveSourceOwner, CommitRemoveSource, OpenEditSource } from "./edit/types";
import { FamilySection, ParentFamilyGroup } from "./edit/FamilySections";
import { NameEditor } from "./edit/NameEditor";
import { SexToggle } from "./edit/SexToggle";
import { PrivateToggle } from "./edit/PrivateToggle";
import { detectPrivacyStyle, isPrivateNode, setPrivateFlag } from "../gedcom/private";
import { OtherNamesEditor } from "./edit/OtherNamesEditor";
import { EventList } from "./edit/EventList";
import { CopyEventDialog, type CopyEventRequest } from "./edit/CopyEventDialog";
import { NotesEditor } from "./edit/NotesEditor";
import { MAP_EVENT_KINDS, personPoints } from "../geo/points";
import { buildPersonPaths } from "../geo/paths";
import { kindsColorVar } from "./map/markerStyle";

/** The person's places map, in the shared Leaflet lazy chunk. */
const MiniPlaceMap = lazy(() => import("./map/MiniPlaceMap"));
import { LinksEditor } from "./edit/LinksEditor";
import { ConfirmDialog } from "./ConfirmDialog";
import { PersonMedia } from "./PersonMedia";
import { useMediaViewer, type MediaEditFields, type MediaRefContext } from "./MediaViewer";
import { mediaKindOf } from "./mediaPath";
import { collectMediaRefs, mediaNodeAt, type MediaAddress } from "../gedcom/media";


interface Props {
  dataset: Dataset;
  fileName: string;
  /** Seeds the initial selection (the Merge-mode start person, if set). */
  startId?: string;
  /** Called to change (or clear) the start person. */
  changeStart: (id: string | undefined) => void;
  /** Called whenever the dataset is mutated so the parent can track which records changed. */
  onDirty: (type: "individual" | "family", id: string) => void;
  /** Open the Charts hub on this person — at the last-used kind, or a specific
   *  one (the V/R shortcuts deep-link to a pedigree chart / the relationship). */
  onShowCharts: (id: string, kind?: ChartKind) => void;
  /** True when the main file records married surnames inline as `_MARNM`, so
   * the name editor offers a married-name field. */
  marriedNameTag?: boolean;
  /** Navigate to this person when it changes (used by the save dialog person links). */
  navigateToId?: string;
  /** Called once after `navigateToId` has been honoured, so the parent can reset
   *  it and re-request the same person again later (e.g. the "go start" icon). */
  onNavigated?: () => void;
  /** Called whenever the currently-shown person changes, so the parent can
   * jump Merge to that same person's match candidate when switching modes
   * (tab click or the "m" shortcut), instead of leaving Merge on whatever it
   * had selected before. */
  onPersonChange?: (id: string) => void;
  /** Returns the compare id of the given person's best (highest-ranked) match
   * candidate, if any — lets the name row show Confirm/Reject/Defer buttons
   * for that pair without switching to Merge mode. */
  matchCompareIdFor?: (id: string) => string | undefined;
  /** Main ids in the same (filtered) order as Merge's own Left/Right/Prev/Next —
   * lets Edit's Left/Right step through that same match list. `undefined` when
   * there's no incoming file loaded, in which case Left/Right do nothing. */
  matchOrder?: string[];
  /** Merge decisions — used to preview incoming values for confirmed matches. */
  decisions?: Map<string, CandidateDecision>;
  /** Main ids with unsaved edits — relatives in that set show an "M" chip. */
  changedPersonIds: Set<string>;
  /** The incoming dataset — needed to resolve confirmed match incoming values. */
  compareDataset?: Dataset;
  /** Called when an extra merge event is dismissed — sets its fields to "main" in the decision.
   * Takes the decision's own map key (not necessarily the Merge tab's currently selected
   * candidate — Edit can be showing a different confirmed person, e.g. after navigating to a
   * spouse) so the caller updates the right entry instead of whichever candidate Merge last had selected. */
  onUpdateDecision?: (key: string, next: CandidateDecision) => void;
  /** Called with each edit's patches so the parent can push to the unified undo stack. */
  onPushEdit: (patches: RecordPatch[], navigateTo?: string, redoNavigateTo?: string) => void;
  /** Called after undo/redo patches are applied so the parent can update dirty tracking. */
  onPatchApplied?: (patches: RecordPatch[], direction: "undo" | "redo") => void;
  /** When non-null, apply these patches and then call onApplied. */
  pendingApply: PendingEditApply | null;
  /** Called after pendingApply has been processed. */
  onApplied: () => void;
  /** A request to create a new, unattached person (the header button, the `N`
   * shortcut, the global search's create row). `nonce` increments per request —
   * each value is honoured exactly once — and `name` pre-fills the name from
   * whatever the user had already typed. */
  addPersonRequest?: { nonce: number; name?: string };
  /** False when Edit is mounted but hidden behind Merge mode — kept mounted
   * across mode switches so toggling modes with a large match list doesn't
   * re-render the whole tab from scratch. Gates the global keydown shortcut
   * so it doesn't fire while another mode is the one actually visible. */
  active: boolean;
}

/**
 * The no-confirmed-match merge preview — one frozen instance, so the merge
 * props handed to the memoized sections keep a stable identity across `tick`
 * re-renders while no merge is active (the common case). A fresh object per
 * render would bust their `React.memo` prop equality on every keystroke-commit.
 */

/** Edit mode's person view: parents on top, the selected person in the
 * center, partners + children on the bottom. The center panel is editable;
 * relatives navigate on click. */
export function EditView({ dataset, fileName, startId, changeStart, onDirty, onShowCharts, marriedNameTag, navigateToId, onNavigated, onPersonChange, matchCompareIdFor, matchOrder, decisions, changedPersonIds, compareDataset, onUpdateDecision, onPushEdit, onPatchApplied, pendingApply, onApplied, addPersonRequest, active }: Props) {
  const { t } = useTranslation();
  const formatName = useNameOf();
  const { settings, set: setSettings } = useSettings();
  // Last-used chart kind — the V shortcut reopens it (falling back to the tree
  // when the relationship diagram was last, since V means a pedigree chart).
  const { settings: chartSettings } = useChartSettings();
  const [selectedId, setSelectedId] = useState<string | undefined>(
    // Guard against a stale start person (id not in this dataset) so we land on a
    // real individual rather than a dead id that renders the empty state.
    () =>
      (startId && dataset.individuals.has(startId) ? startId : undefined) ??
      defaultStartId(dataset) ??
      dataset.individuals.keys().next().value,
  );
  const [history, setHistory] = useState<string[]>([]);
  // Bumped after every edit to force a re-render — the dataset is mutated
  // in place, so React has no other signal that `person` changed.
  const [tick, setTick] = useState(0);
  const focusNextName = useRef(false);
  // Per-person snapshot of notes at the last clean/saved state, so newly added
  // or edited notes can render bold. Refreshed whenever the person has no unsaved
  // edits (freshly opened or just saved); preserved once it's being edited.
  const noteBaselineRef = useRef(new Map<string, string[]>());
  // Whether the user has clicked "+ Add note" for the current person.
  const [notesAdded, setNotesAdded] = useState(false);
  // Trigger counters to add a note to a specific family (keyed by family ID).
  const [famNoteAdd, setFamNoteAdd] = useState<Record<string, number>>({});
  const [pickingSlot, setPickingSlot] = useState<{ kind: "father" | "mother" | "partner" | "child"; fam: Family | undefined } | null>(null);
  // Incremented on every undo/redo so components with local state re-mount and
  // pick up the restored GEDCOM data rather than showing stale values.
  const [undoVersion, setUndoVersion] = useState(0);
  // Tracks which family-event row should auto-focus its date field on mount.
  const [pendingFocusFamEventKey, setPendingFocusFamEventKey] = useState<string | null>(null);
  useEffect(() => { if (pendingFocusFamEventKey) setPendingFocusFamEventKey(null); }, [pendingFocusFamEventKey]);
  // Tracks which individual-event row should auto-focus its date field on mount.
  const [pendingFocusEventNodeId, setPendingFocusEventNodeId] = useState<number | null>(null);
  useEffect(() => { if (pendingFocusEventNodeId !== null) setPendingFocusEventNodeId(null); }, [pendingFocusEventNodeId]);
  const [pendingConfirm, setPendingConfirm] = useState<{ message: string; confirmLabel: string; action: () => void; danger?: boolean } | null>(null);
  // The event whose "Copy event to…" picker is open (null = closed).
  const [copyEventRequest, setCopyEventRequest] = useState<CopyEventRequest | null>(null);

  // ── Undo / Redo (applied here; stack lives in App.tsx) ───────────────────

  function applyEditPatches(patches: RecordPatch[], direction: "undo" | "redo") {
    const pick: "before" | "after" = direction === "undo" ? "before" : "after";
    // First pass: remove records that need to go away.
    for (const patch of patches) {
      if (patch[pick] === null) {
        const ri = dataset.records.findIndex((r) => r.xref === patch.id);
        if (ri !== -1) dataset.records.splice(ri, 1);
        if (patch.type === "individual") dataset.individuals.delete(patch.id);
        else if (patch.type === "family") dataset.families.delete(patch.id);
        else if (patch.type === "record") { bumpSourceCacheVersion(dataset.records); clearObjeNodeCache(dataset.records); }
      }
    }
    // Second pass: restore or re-add generic top-level records (e.g. a
    // SOUR/OBJE created or pruned by "Add Source") *before* any
    // individual/family rebuild below — that rebuild re-resolves source
    // citations via getMediaAndSourceCtx(dataset.records) (each iteration here
    // also bumps its cache, so the rebuild can't reuse a stale pre-undo
    // version), so a SOUR/OBJE this same batch touched must already be back
    // in place, or a citation pointer resolves dangling (no title/url) until
    // the next edit.
    for (const patch of patches) {
      if (patch.type !== "record") continue;
      const target = patch[pick];
      if (target === null) continue;
      const restored = cloneRaw(target);
      const existing = dataset.records.find((r) => r.xref === patch.id);
      if (existing) {
        existing.value = restored.value;
        existing.children = restored.children;
      } else {
        insertRecord(dataset.records, restored);
      }
      // A SOUR/OBJE this patch touches may now have a different FILE value or
      // existence than `getMediaAndSourceCtx`'s cache last saw.
      bumpSourceCacheVersion(dataset.records);
      clearObjeNodeCache(dataset.records);
    }
    // Third pass: restore individual/family records and rebuild them. Sorted by
    // original position so re-added records (undo of a deletion) land back at
    // their original indices — inserting ascending keeps every later index valid.
    const byPosition = [...patches].sort((a, b) => (a.index ?? Infinity) - (b.index ?? Infinity));
    for (const patch of byPosition) {
      const target = patch[pick];
      if (target === null) continue;
      const restored = cloneRaw(target);
      if (patch.type === "individual") {
        const existing = dataset.individuals.get(patch.id);
        if (existing) {
          existing.raw.value = restored.value;
          existing.raw.children = restored.children;
          rebuildIndividual(dataset, existing);
        } else {
          insertRecordAt(dataset.records, restored, patch.index);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          rebuildIndividual(dataset, { raw: restored } as any);
        }
      } else if (patch.type === "family") {
        const existing = dataset.families.get(patch.id);
        if (existing) {
          existing.raw.value = restored.value;
          existing.raw.children = restored.children;
          rebuildFamily(dataset, existing);
        } else {
          insertRecordAt(dataset.records, restored, patch.index);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          rebuildFamily(dataset, { raw: restored } as any);
        }
      }
    }
    // Shared NOTE records restored above: referrers other than the patched
    // owner still project the pre-undo text — refresh them (and the editors).
    const noteChanges = patches
      .filter((p) => p.type === "record" && (p.before ?? p.after)?.tag === "NOTE")
      .map((p) => ({ xref: p.id }));
    if (noteChanges.length) {
      rebuildNoteReferrers(dataset, noteChanges);
      noteGenRef.current++;
    }
  }

  // Apply patches queued by the parent (triggered by unified undo/redo).
  // Frame 1: navigate to the affected person so the user sees them first.
  // Frame 2 (RAF): apply the patches so the change is visible on the right person.
  useEffect(() => {
    if (!pendingApply) return;
    const navId = pendingApply.direction === "undo" ? pendingApply.navigateTo : pendingApply.redoNavigateTo;
    // Always reset local UI state on undo/redo so stale values don't linger.
    setNotesAdded(false);
    setFamNoteAdd({});
    if (navId !== undefined) {
      setSelectedId(navId);
    }
    const patches = pendingApply.patches;
    const direction = pendingApply.direction;
    onApplied();
    // Apply exactly once: normally on the next frame (so the navigation above
    // paints first), but synchronously from the cleanup when the effect re-runs
    // before that frame fires — the entry is already popped off the undo stack,
    // so skipping the apply would silently desync the dataset from the history.
    // (applyEditPatches and onPatchApplied are idempotent, so StrictMode's
    // setup/cleanup/setup double-run applying twice is harmless.)
    let applied = false;
    const apply = () => {
      if (applied) return;
      applied = true;
      applyEditPatches(patches, direction);
      setTick((v) => v + 1);
      setUndoVersion((v) => v + 1);
      onPatchApplied?.(patches, direction);
    };
    const raf = requestAnimationFrame(apply);
    return () => {
      cancelAnimationFrame(raf);
      apply();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingApply]);
  // ─────────────────────────────────────────────────────────────────────────

  const person = selectedId ? dataset.individuals.get(selectedId) : undefined;

  // The current person's own best match candidate (if any) — lets the name
  // row offer Confirm/Reject/Defer directly, without switching to Merge mode,
  // and lets the same C/R/D shortcuts Merge mode uses work here too.
  const matchCompareId = person ? matchCompareIdFor?.(person.id) : undefined;
  const matchDecKey = person && matchCompareId ? decisionKey("individual", person.id, matchCompareId) : undefined;
  const matchDecision = matchDecKey ? decisions?.get(matchDecKey) : undefined;
  const matchStatus = matchDecision?.status ?? "undecided";

  function toggleMatchStatus(next: MatchDecisionStatus) {
    if (!matchDecKey || !onUpdateDecision) return;
    onUpdateDecision(matchDecKey, { status: matchStatus === next ? "undecided" : next, fields: matchDecision?.fields ?? {} });
  }

  // Identity-stable across renders (latest-ref wrappers), so the memoized
  // sections and event list they're passed to can skip re-rendering on ticks
  // that didn't change their data.
  const navigate = useStableHandler((id: string) => {
    if (!id || id === selectedId) return;
    if (selectedId) setHistory((h) => [...h, selectedId]);
    setNotesAdded(false);
    setPickingSlot(null);
    setSelectedId(id);
  });

  const goBack = useStableHandler(() => {
    setHistory((h) => {
      if (h.length === 0) return h;
      setSelectedId(h[h.length - 1]);
      return h.slice(0, -1);
    });
  });

  // V (tree) shortcut, Left/Right record navigation, Up/Down scrolling, and C/R/D
  // decision shortcuts (mirroring Merge mode's). Kept as a ref-fed closure
  // (rather than effect deps) so the listener doesn't need to be torn down
  // and re-added on every render/edit.
  const chartKind = chartSettings.kind;
  const shortcutRef = useRef({ selectedId, onShowCharts, chartKind, startId, matchOrder, navigate, goBack, matchDecKey, toggleMatchStatus });
  shortcutRef.current = { selectedId, onShowCharts, chartKind, startId, matchOrder, navigate, goBack, matchDecKey, toggleMatchStatus };
  // The scrollable person panel — Up/Down scroll this instead of navigating
  // when it actually has overflow to scroll.
  const editBodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active) return;
    function onKey(e: KeyboardEvent) {
      if (isEditableTarget(e.target) || isModalOpen()) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const { selectedId: id, onShowCharts: showCharts, chartKind: kind, startId: hId, matchOrder: order, navigate: nav, goBack: back, matchDecKey: decKey, toggleMatchStatus: toggle } = shortcutRef.current;
      const key = e.key.toLowerCase();
      if (key === KEY.tree) {
        // A pedigree chart (the last one used) — never the relationship diagram,
        // which has its own key below.
        if (id) { e.preventDefault(); showCharts(id, kind === "relationship" ? "tree" : kind); }
        return;
      }
      if (key === KEY.relationship) {
        if (id) { e.preventDefault(); showCharts(id, "relationship"); }
        return;
      }
      if (key === KEY.home) {
        if (hId) { e.preventDefault(); nav(hId); }
        return;
      }
      if (e.key === "Backspace") {
        // Swallow it even with empty history, so it never triggers the
        // browser's page-back navigation.
        e.preventDefault();
        back();
        return;
      }
      const statusHit = KEY_STATUS[key];
      if (statusHit) {
        if (decKey) { e.preventDefault(); toggle(statusHit); }
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        // Previous/next person in the same (filtered) match list Merge's own
        // Left/Right use — does nothing without an incoming file loaded, or
        // when the current person isn't itself a match candidate.
        if (!order || !id) return;
        const idx = order.indexOf(id);
        if (idx === -1) return;
        const nextIdx = e.key === "ArrowLeft" ? idx - 1 : idx + 1;
        if (nextIdx < 0 || nextIdx >= order.length) return;
        e.preventDefault();
        nav(order[nextIdx]);
        return;
      }
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        const el = editBodyRef.current;
        if (!el || el.scrollHeight <= el.clientHeight) return;
        e.preventDefault();
        el.scrollBy({ top: e.key === "ArrowDown" ? 96 : -96, behavior: "smooth" });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  useEffect(() => {
    if (navigateToId) {
      navigate(navigateToId);
      onNavigated?.();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigateToId]);

  useEffect(() => {
    if (selectedId) onPersonChange?.(selectedId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // ── Merge overlay (confirmed match projected onto this person) ───────────
  const {
    mergeHighlight, mergeIncomingLinks, mergeIncomingSources,
    mainMergeKeyBases, mainMergeCompareKeys, mainMergeSortKeys,
    extraMergeEvents, familyMergeKeyBases: familyKeyBaseById,
    mergeGen, resolvedSessionFields, materializedEventIds, markMaterializedEvent,
    rejectIncomingEvent, materializeMergeEventSources, dismissExtraEvent,
    resolveMergeFields, markFamilyTagRetagged,
  } = useMergeOverlay({ person, selectedId, dataset, compareDataset, decisions, onUpdateDecision, tick, t });

  const { folderName, canReferenceFiles, resolveDroppedHandle, openFolder, importFile } = useMediaFolder();
  const { openPerson } = useMediaViewer();
  const [mediaPickerOpen, setMediaPickerOpen] = useState(false);
  // Follow the main's photo house-style (inline OBJE/FILE vs. shared top-level
  // OBJE + pointer); ties / no photos fall back to shared.
  const mediaMode = useMemo(() => detectMediaMode(dataset.records), [dataset.records]);
  // The file's privacy-marker dialect (PRIV / _PRIV / RESN) — the person and
  // family lock toggles write markers in the file's own style, unless the
  // Settings → GEDCOM override picks one explicitly.
  const privacyStyle = useMemo(
    () => settings.formatOverrides.privacy ?? detectPrivacyStyle(dataset.records),
    [dataset.records, settings.formatOverrides.privacy],
  );
  const [mediaDragOver, setMediaDragOver] = useState(false);

  /** After a commit whose note ctx touched shared NOTE records: refresh every
   *  other referrer's stale projection and remount the note editors. */
  function afterNoteChanges(changes: SharedNoteChange[], skipId: string) {
    if (!changes.length) return;
    rebuildNoteReferrers(dataset, changes, skipId);
    noteGenRef.current++;
  }

  const commit: Commit = useStableHandler((mutate: (indi: Individual, noteCtx: SharedNoteCtx) => void, extraPatches?: RecordPatch[]) => {
    if (!person) return;
    const before = cloneRaw(person.raw);
    const notes = noteCtx(dataset.records, privacyStyle);
    mutate(person, notes);
    const after = cloneRaw(person.raw);
    const extra = [...(extraPatches ?? []), ...noteChangePatches(notes.changes, { kind: "individual", id: person.id })];
    if (JSON.stringify(before) === JSON.stringify(after) && !extra.length) return;
    rebuildIndividual(dataset, person);
    onPushEdit([{ type: "individual", id: person.id, before, after }, ...extra], selectedId);
    onDirty("individual", person.id);
    afterNoteChanges(notes.changes, person.id);
    setTick((v) => v + 1);
  });

  const commitFamily: FamilyCommit = useStableHandler((fam: Family, mutate: (fam: Family, noteCtx: SharedNoteCtx) => void, extraPatches?: RecordPatch[]) => {
    const before = cloneRaw(fam.raw);
    const notes = noteCtx(dataset.records, privacyStyle);
    mutate(fam, notes);
    const after = cloneRaw(fam.raw);
    const extra = [...(extraPatches ?? []), ...noteChangePatches(notes.changes, { kind: "family", id: fam.id })];
    if (JSON.stringify(before) === JSON.stringify(after) && !extra.length) return;
    rebuildFamily(dataset, fam);
    onPushEdit([{ type: "family", id: fam.id, before, after }, ...extra], selectedId);
    onDirty("family", fam.id);
    afterNoteChanges(notes.changes, fam.id);
    setTick((v) => v + 1);
  });

  /**
   * Bumped on structural edits (relative added/connected/detached, person
   * deleted) — the memoized parent/family sections fold it into their props so
   * their kinship badges recompute even when their own family object didn't
   * change (the kinship path to the start person can run anywhere in the
   * graph). Undo/redo is covered by `undoVersion`.
   */
  const relationsGenRef = useRef(0);
  /**
   * Bumped when a shared top-level `SOUR`/`OBJE` record is edited or pruned in
   * place — the media trays key on it (plus the owner's identity) so they
   * remount and re-read shared-record metadata that changed via *another*
   * owner's edit. Replaces keying every tray on the global `tick`, which
   * remounted (and re-resolved blobs for) every tray on every keystroke-commit.
   */
  const mediaGenRef = useRef(0);
  /**
   * Bumped when a shared top-level `NOTE` record is edited or removed — the
   * note editors key on it so a referrer's chips remount and re-read text
   * that changed via *another* owner's edit (the shared-note counterpart of
   * `mediaGenRef`).
   */
  const noteGenRef = useRef(0);

  // ── Media (OBJE) ──────────────────────────────────────────────────────────

  /** Pop a benign (non-destructive) acknowledgement dialog. */
  function infoDialog(message: string) {
    setPendingConfirm({ message, confirmLabel: t("confirm.ok"), danger: false, action: () => {} });
  }

  const ownerRaw = (owner: MediaOwner): GedNode | undefined =>
    owner.kind === "individual" ? person?.raw : owner.fam.raw;

  /** Route a raw-record mutation through the owner's commit helper. */
  function ownerCommit(owner: MediaOwner, mutate: (raw: GedNode) => void, extraPatches?: RecordPatch[]) {
    if (owner.kind === "individual") commit((indi) => mutate(indi.raw), extraPatches);
    else commitFamily(owner.fam, (f) => mutate(f.raw), extraPatches);
  }

  /** Attach a photo by folder-relative path, following the main's media mode:
   *  an inline OBJE/FILE block, or a pointer to a shared top-level OBJE. In
   *  shared mode an `existingXref` (or a record with the same file) is reused,
   *  else a new top-level OBJE is created and captured as a record patch. */
  function addMediaTo(owner: MediaOwner, file: string, existingXref?: string) {
    if (mediaMode === "inline") {
      ownerCommit(owner, (raw) => { attachInlineMedia(raw, file); });
      return;
    }
    const extraPatches: RecordPatch[] = [];
    let objeXref = existingXref ?? findSharedMediaByFile(dataset.records, file)?.xref;
    if (!objeXref) {
      const rec = createMediaRecord(dataset.records, file);
      objeXref = rec.xref!;
      extraPatches.push({ type: "record", id: rec.xref!, before: null, after: cloneRaw(rec) });
    }
    ownerCommit(owner, (raw) => attachMediaPointer(raw, objeXref!), extraPatches);
  }

  /** Edit a photo's metadata (title/date/place/description). An inline OBJE is
   *  edited on the owner record (normal commit); a shared top-level OBJE is
   *  edited in place and captured as a `record` patch for undo, with the owner
   *  marked dirty so the change surfaces in the save preview. */
  function editMediaOn(owner: MediaOwner, addr: MediaAddress, fields: MediaEditFields) {
    const raw = ownerRaw(owner);
    if (!raw) return;
    const objeChild = mediaNodeAt(raw, addr);
    if (!objeChild) return;
    const ptr = objeChild.value?.trim();
    const sharedXref = ptr && isPointer(ptr) ? ptr : undefined;
    if (sharedXref) {
      const rec = dataset.records.find((r) => r.tag === "OBJE" && r.xref === sharedXref);
      if (!rec) return;
      const before = cloneRaw(rec);
      setMediaInfo(rec, fields);
      if (isPrivateNode(rec) !== fields.private) setPrivateFlag(rec, fields.private, privacyStyle, dataset.records);
      const after = cloneRaw(rec);
      if (JSON.stringify(before) === JSON.stringify(after)) return;
      bumpSourceCacheVersion(dataset.records);
      mediaGenRef.current += 1; // other owners' trays may show this shared record
      if (owner.kind === "individual") {
        if (person) rebuildIndividual(dataset, person);
      } else {
        rebuildFamily(dataset, owner.fam);
      }
      // The owner's own raw is untouched here — tag the patch with the owner so
      // undo/redo can re-evaluate the owner's dirty flag from the shared record.
      const patchOwner = owner.kind === "individual"
        ? (person ? { kind: "individual" as const, id: person.id } : undefined)
        : { kind: "family" as const, id: owner.fam.id };
      onPushEdit([{ type: "record", id: sharedXref, before, after, owner: patchOwner }], selectedId);
      if (owner.kind === "individual") { if (person) onDirty("individual", person.id); }
      else onDirty("family", owner.fam.id);
      setTick((v) => v + 1);
    } else {
      ownerCommit(owner, (r) => {
        const child = mediaNodeAt(r, addr);
        if (child) {
          setMediaInfo(child, fields);
          if (isPrivateNode(child) !== fields.private) setPrivateFlag(child, fields.private, privacyStyle, dataset.records);
        }
      });
    }
  }

  /** Write (or clear) the person-region crop on the owner's media link. The
   *  CROP lives on the link node inside the owner record, so a plain owner
   *  commit covers undo/dirty/save-preview. */
  function editMediaCropOn(owner: MediaOwner, addr: MediaAddress, crop: CropRegion | null) {
    ownerCommit(owner, (raw) => {
      const child = mediaNodeAt(raw, addr);
      if (child) setCropRegion(child, crop);
    });
  }

  /** Referenced-by + edit context handed to the photo viewer/tray in Edit mode. */
  const mediaCtxFor = useStableHandler((owner: MediaOwner): MediaRefContext => ({
    dataset,
    onNavigate: navigate,
    onEditMedia: (addr, fields) => editMediaOn(owner, addr, fields),
    onEditMediaCrop: (addr, crop) => editMediaCropOn(owner, addr, crop),
  }));
  const mediaRefCtx = mediaCtxFor({ kind: "individual" });

  /** After adding a single photo, open it in the viewer so its metadata can be
   *  filled in straight away. Adds append to the record's own `OBJE` children,
   *  so target the last of those by address — a plain last-tray-index could
   *  land on an event-level photo instead. */
  function openLastMedia(owner: MediaOwner) {
    const raw = ownerRaw(owner);
    if (!raw) return;
    const objeCount = childrenByTag(raw, "OBJE").length;
    if (objeCount === 0) return;
    openPerson(raw, dataset.records, { objeIndex: objeCount - 1 }, mediaCtxFor(owner), true);
  }

  /** Which record the picker adds to — set by the "Add media" entry points. */
  const [mediaAddTarget, setMediaAddTarget] = useState<MediaOwner>({ kind: "individual" });

  /** The "Add media" entry point: ensure a media folder is chosen, then open
   *  the picker (which lists the folder's images — works in every browser that
   *  can load a folder). Dragging files in from outside is the Chrome/Edge-only
   *  path handled separately. */
  const handleAddMedia = useStableHandler((owner: MediaOwner) => {
    if (!folderName) {
      setPendingConfirm({
        message: t("media.selectFolderPrompt"),
        confirmLabel: t("media.chooseFolder"),
        danger: false,
        action: () => { void openFolder(); },
      });
      return;
    }
    setMediaAddTarget(owner);
    setMediaPickerOpen(true);
  });

  /** Remove the owner's media at `addr`. Mirrors `commitRemoveSource`:
   *  snapshots the shared OBJE first so undo can restore it if the delete
   *  pruned it as now-unreferenced. */
  function deleteMediaOn(owner: MediaOwner, addr: MediaAddress) {
    const raw = ownerRaw(owner);
    if (!raw) return;
    const objeChild = mediaNodeAt(raw, addr);
    const ptr = objeChild?.value?.trim();
    const sharedXref = ptr && isPointer(ptr) ? ptr : undefined;
    const sharedNode = sharedXref ? dataset.records.find((r) => r.tag === "OBJE" && r.xref === sharedXref) : undefined;
    const sharedBefore = sharedNode ? cloneRaw(sharedNode) : undefined;

    const before = cloneRaw(raw);
    removeMediaAt(dataset, raw, addr);
    const after = cloneRaw(raw);

    const extraPatches: RecordPatch[] = [];
    if (sharedXref && sharedBefore && !dataset.records.some((r) => r.xref === sharedXref)) {
      extraPatches.push({ type: "record", id: sharedXref, before: sharedBefore, after: null });
      mediaGenRef.current += 1; // a shared record was pruned
    }
    if (owner.kind === "individual") {
      if (!person) return;
      rebuildIndividual(dataset, person);
      onPushEdit([{ type: "individual", id: person.id, before, after }, ...extraPatches], selectedId);
      onDirty("individual", person.id);
    } else {
      rebuildFamily(dataset, owner.fam);
      onPushEdit([{ type: "family", id: owner.fam.id, before, after }, ...extraPatches], selectedId);
      onDirty("family", owner.fam.id);
    }
    setTick((v) => v + 1);
  }

  const handleDeleteMedia = useStableHandler((owner: MediaOwner, addr: MediaAddress) => {
    setPendingConfirm({
      message: t("media.deleteConfirm"),
      confirmLabel: t("confirm.delete"),
      action: () => deleteMediaOn(owner, addr),
    });
  });

  /** Reference dropped image files that live inside the chosen media folder.
   *  DataTransferItems are invalidated after the first `await`, so every
   *  handle is requested synchronously up front, then resolved. */
  function handleMediaDrop(e: React.DragEvent) {
    if (!e.dataTransfer.types.includes("Files")) return; // internal reorder drag
    e.preventDefault();
    setMediaDragOver(false);
    const handlePromises: Promise<FileSystemHandle | null>[] = [];
    let fileCount = 0;
    for (const item of Array.from(e.dataTransfer.items)) {
      if (item.kind !== "file") continue;
      fileCount++;
      const get = (item as unknown as { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> }).getAsFileSystemHandle;
      if (get) handlePromises.push(get.call(item));
    }
    if (fileCount === 0) return;
    void resolveDroppedMedia(handlePromises, fileCount);
  }

  async function resolveDroppedMedia(handlePromises: Promise<FileSystemHandle | null>[], fileCount: number) {
    if (!folderName) { infoDialog(t("media.selectFolderPrompt")); return; }
    if (!canReferenceFiles || handlePromises.length < fileCount) { infoDialog(t("media.importUnsupported")); return; }
    let anyFailed = false;
    let added = 0;
    for (const promise of handlePromises) {
      const handle = await promise;
      if (!handle || handle.kind !== "file" || mediaKindOf(handle.name) === null) continue;
      // Inside the folder → reference it; outside → copy it in first (the
      // browser asks once per session to allow writing to the folder).
      let rel = await resolveDroppedHandle(handle);
      if (!rel) {
        const file = await (handle as FileSystemFileHandle).getFile().catch(() => null);
        rel = file && (await importFile(file));
      }
      if (rel) { addMediaTo({ kind: "individual" }, rel); added++; }
      else anyFailed = true;
    }
    if (added === 1) openLastMedia({ kind: "individual" });
    if (anyFailed) infoDialog(t("media.importFailed"));
  }

  // ── Add Source dialog ────────────────────────────────────────────────────
  // `sourceDialogTarget` says where the confirmed citation should attach:
  // the selected person's own record, or a specific event's `commitField`
  // (already bound to that event's index/tag by the caller).
  const [sourceDialogTarget, setSourceDialogTarget] = useState<SourceDialogTarget | null>(null);

  /**
   * Resolve the dataset-level side of "Add Source": reuse an existing
   * `SOUR`/`OBJE` for the same (or same-book) URL when one exists, otherwise
   * create new ones. Returns the citation pointer to attach plus any extra
   * patches for the top-level records it touched, for the caller's `commit`.
   */
  function resolveSourceFields(
    fields: AddSourceResult,
  ): { sourceXref: string; page?: string; pageObjeXref?: string; extraPatches: RecordPatch[] } {
    // Page media titled the way the cleanup tool titles them (`#page - title`).
    const objeTitle = (title: string | undefined, page: string | undefined) =>
      fields.site && title ? (page ? `#${page} - ${title}` : title) : undefined;
    const extraPatches: RecordPatch[] = [];
    if (fields.url) {
      const match = findExistingSource(dataset.records, fields.url);
      if (match) {
        let pageObjeXref = match.objeXref;
        if (!match.objeXref) {
          const sourceNode = dataset.records.find((r) => r.tag === "SOUR" && r.xref === match.sourceXref)!;
          const before = cloneRaw(sourceNode);
          const page = fields.page ?? match.page;
          const obje = addObjeToSource(dataset.records, match.sourceXref, fields.url, objeTitle(sourceTitle(sourceNode), page));
          extraPatches.push({ type: "record", id: match.sourceXref, before, after: cloneRaw(sourceNode) });
          extraPatches.push({ type: "record", id: obje.xref!, before: null, after: cloneRaw(obje) });
          pageObjeXref = obje.xref ?? undefined;
        }
        return { sourceXref: match.sourceXref, page: fields.page ?? match.page, pageObjeXref, extraPatches };
      }
    }
    const sourceNode = createSourceRecord(dataset.records, fields as NewSourceFields);
    if (fields.site || fields.place || fields.dateRange) {
      // A recognized site URL gets the same PLAC/DATE/REPO extras the
      // Organize sources tool writes, so it needs no cleanup pass later;
      // a hand-entered place still lands as PLAC in the file's place format.
      const repo = applySiteSourceExtras(dataset.records, sourceNode, fields.site, fields.url ?? "", fields, {
        sourceLayout: settings.formatOverrides.sourceLayout ?? "auto",
      });
      if (repo) extraPatches.push({ type: "record", id: repo.xref!, before: null, after: cloneRaw(repo) });
    }
    extraPatches.push({ type: "record", id: sourceNode.xref!, before: null, after: cloneRaw(sourceNode) });
    const objeChild = firstChild(sourceNode, "OBJE");
    if (objeChild?.value) {
      const objeNode = dataset.records.find((r) => r.tag === "OBJE" && r.xref === objeChild.value);
      if (objeNode) {
        const title = objeTitle(fields.title, fields.page);
        if (title) objeNode.children.push({ level: 1, tag: "TITL", value: title, children: [] });
        extraPatches.push({ type: "record", id: objeNode.xref!, before: null, after: cloneRaw(objeNode) });
      }
    }
    return { sourceXref: sourceNode.xref!, page: fields.page, pageObjeXref: objeChild?.value, extraPatches };
  }

  /** Link the cited page's image beside the citation ("on events" style). */
  function linkPageMedia(node: GedNode, pageObjeXref: string | undefined, order: string[]) {
    if (!pageObjeXref) return;
    if (childrenByTag(node, "OBJE").some((c) => c.value?.trim() === pageObjeXref)) return;
    insertOrdered(node, { level: node.level + 1, tag: "OBJE", value: pageObjeXref, children: [] }, order);
  }

  /** Attach the citation to `host`'s `eventTag` event, creating the event
   * when missing — the same placement the Organize sources tool uses. */
  function attachToEvent(
    host: GedNode,
    eventTag: string,
    sourceXref: string,
    page: string | undefined,
    order: string[],
    pageObjeXref?: string,
  ) {
    let event = firstChild(host, eventTag);
    if (!event) {
      event = { level: host.level + 1, tag: eventTag, children: [] };
      insertOrdered(host, event, order);
    }
    attachSourceCitation(event, sourceXref, page, EVENT_CHILD_ORDER);
    linkPageMedia(event, pageObjeXref, EVENT_CHILD_ORDER);
  }

  function handleAddSource(fields: AddSourceResult) {
    if (!sourceDialogTarget || sourceDialogTarget.kind === "edit" || sourceDialogTarget.kind === "edit-link" || !person) return;
    const { sourceXref, page, pageObjeXref, extraPatches } = resolveSourceFields(fields);
    // In the "on events" page-media style the cited page's image is linked
    // beside the citation too (Settings; "auto" matches the file's habit).
    const style = settings.formatOverrides.pageMedia ?? detectPageMediaStyle(dataset.records);
    const pageObje = style === "event" ? pageObjeXref : undefined;
    if (sourceDialogTarget.kind === "individual") {
      // A recognized register/grave source added on the person lands on its
      // matching event (created if missing) when the file keeps citations on
      // events — baptism → BIRT/BAPM, marriage → the sole family's MARR,
      // death → DEAT, grave → BURI.
      const smart = fields.site
        ? smartCitationTarget(dataset.records, fields.site, fields.title, {
            citations: settings.formatOverrides.citations ?? "auto",
            baptism: settings.formatOverrides.baptism ?? "auto",
          })
        : undefined;
      const soleFam = person.spouseOf.length === 1 ? dataset.families.get(person.spouseOf[0]) : undefined;
      if (smart && !smart.onFam) {
        commit((indi) => attachToEvent(indi.raw, smart.eventTag, sourceXref, page, INDI_CHILD_ORDER, pageObje), extraPatches);
      } else if (smart && smart.onFam && soleFam) {
        commitFamily(soleFam, (f) => attachToEvent(f.raw, smart.eventTag, sourceXref, page, FAM_CHILD_ORDER, pageObje), extraPatches);
      } else {
        commit((indi) => {
          attachSourceCitation(indi.raw, sourceXref, page, INDI_CHILD_ORDER);
          linkPageMedia(indi.raw, pageObje, INDI_CHILD_ORDER);
        }, extraPatches);
      }
    } else if (sourceDialogTarget.kind === "family") {
      commitFamily(sourceDialogTarget.fam, (f) => {
        attachSourceCitation(f.raw, sourceXref, page, FAM_CHILD_ORDER);
        linkPageMedia(f.raw, pageObje, FAM_CHILD_ORDER);
      }, extraPatches);
    } else {
      sourceDialogTarget.commitField({ addSource: { sourceXref, page, pageObjeXref: pageObje } }, extraPatches);
    }
    setSourceDialogTarget(null);
  }

/**
   * Remove the `index`th `SOUR` citation from `node` (the individual/family's
   * own record, or one of its event sub-nodes) and commit it. Snapshots the
   * cited `SOUR`/`OBJE` first so that — if `removeSourceCitationAtIndex`
   * prunes them as now-unreferenced — undo gets a `"record"` patch to restore
   * them too. Without this, undo would put the citation pointer back but
   * leave it dangling (no title/url to resolve), showing a bare 🔗 instead of
   * the original 📖. Bypasses the generic `commit`/`commitFamily` helpers
   * since their `extraPatches` argument must be known before the mutation
   * runs, but here it's only known *after* (whether pruning actually happened).
   */
  const commitRemoveSource: CommitRemoveSource = (node, index, owner) => {
    const sourceXref = childrenByTag(node, "SOUR")[index]?.value?.trim();
    const sourceNode = sourceXref ? dataset.records.find((r) => r.tag === "SOUR" && r.xref === sourceXref) : undefined;
    const sourceBefore = sourceNode ? cloneRaw(sourceNode) : undefined;
    const objeBefores = (sourceNode?.children.filter((c) => c.tag === "OBJE" && c.value) ?? [])
      .map((c) => c.value!.trim())
      .map((xref) => [xref, dataset.records.find((r) => r.tag === "OBJE" && r.xref === xref)] as const)
      .filter((entry): entry is readonly [string, GedNode] => !!entry[1])
      .map(([xref, n]) => [xref, cloneRaw(n)] as const);

    const ownerRaw = owner.kind === "individual" ? owner.indi.raw : owner.fam.raw;
    const ownerBefore = cloneRaw(ownerRaw);
    removeSourceCitationAtIndex(dataset, node, index);
    const ownerAfter = cloneRaw(ownerRaw);

    const extraPatches: RecordPatch[] = [];
    if (sourceXref && sourceBefore && !dataset.records.some((r) => r.xref === sourceXref)) {
      extraPatches.push({ type: "record", id: sourceXref, before: sourceBefore, after: null });
      for (const [objeXref, before] of objeBefores) {
        if (!dataset.records.some((r) => r.xref === objeXref)) {
          extraPatches.push({ type: "record", id: objeXref, before, after: null });
        }
      }
    }

    if (extraPatches.length) mediaGenRef.current += 1; // shared SOUR/OBJE records were pruned
    if (owner.kind === "individual") {
      rebuildIndividual(dataset, owner.indi);
      onPushEdit([{ type: "individual", id: owner.indi.id, before: ownerBefore, after: ownerAfter }, ...extraPatches], selectedId);
      onDirty("individual", owner.indi.id);
    } else {
      rebuildFamily(dataset, owner.fam);
      onPushEdit([{ type: "family", id: owner.fam.id, before: ownerBefore, after: ownerAfter }, ...extraPatches], selectedId);
      onDirty("family", owner.fam.id);
    }
    setTick((v) => v + 1);
  }

  /**
   * Open the Edit Source dialog for the `index`th `SOUR` citation on `node`,
   * prefilled from the cited record's own fields (not the resolved
   * `SourceCitation`, whose `title` may already be an "AUTH, PUBL" fallback —
   * the raw `TITL`/`AUTH`/... are read separately so each stays in its own
   * field). `objeXref` (when resolvable) is carried through so saving
   * retargets only this citation's page image, not a sibling page's.
   */
  const openEditSource: OpenEditSource = useStableHandler((node: GedNode, index: number, owner: RemoveSourceOwner) => {
    const citation = childrenByTag(node, "SOUR")[index];
    if (!citation) return;
    const page = childText(citation, "PAGE");
    const value = citation.value?.trim();
    const sourceNode = value ? dataset.records.find((r) => r.tag === "SOUR" && r.xref === value) : undefined;
    if (!sourceNode) {
      // Inline (plain-text) citation: just its own value/page, no shared record.
      setSourceDialogTarget({ kind: "edit", node, index, owner, fields: { title: value, page } });
      return;
    }
    const resolved = resolveSourceCitation(citation, getMediaAndSourceCtx(dataset.records).sourceCtx);
    setSourceDialogTarget({
      kind: "edit",
      node,
      index,
      owner,
      fields: {
        title: childText(sourceNode, "TITL"),
        author: childText(sourceNode, "AUTH"),
        periodical: childText(sourceNode, "PERI"),
        publisher: childText(sourceNode, "PUBL"),
        agency: childText(sourceNode, "AGNC"),
        place: childText(sourceNode, "PLAC"),
        filingNumber: childText(sourceNode, "FILN"),
        // A pointer note prefills with the shared record's resolved text (not
        // the raw "@N1@"); saving routes the edit back into that record.
        note: (() => {
          const v = childText(sourceNode, "NOTE");
          return v && isPointer(v) ? getMediaAndSourceCtx(dataset.records).noteIndex.get(v)?.text.trim() : v;
        })(),
        url: resolved?.url,
        objeXref: resolved?.objeXref,
        page,
      },
    });
  });

  /** Commits an Edit Source dialog save: applies `updateSourceCitation`,
   * then diffs every top-level `SOUR`/`OBJE` record for undo-safe patches —
   * simpler than tracking exactly which ones a shared-record edit touched. */
  function commitEditSource(node: GedNode, index: number, owner: RemoveSourceOwner, fields: EditSourceFields) {
    const isSourceOrObje = (r: GedNode) => r.tag === "SOUR" || r.tag === "OBJE";
    const before = new Map(dataset.records.filter((r) => isSourceOrObje(r) && r.xref).map((r) => [r.xref!, cloneRaw(r)]));

    const ownerRaw = owner.kind === "individual" ? owner.indi.raw : owner.fam.raw;
    const ownerBefore = cloneRaw(ownerRaw);
    const notes = noteCtx(dataset.records, privacyStyle);
    updateSourceCitation(dataset.records, node, index, fields, notes);
    const ownerAfter = cloneRaw(ownerRaw);

    const after = new Map(dataset.records.filter((r) => isSourceOrObje(r) && r.xref).map((r) => [r.xref!, r]));
    const extraPatches: RecordPatch[] = [];
    for (const xref of new Set([...before.keys(), ...after.keys()])) {
      const b = before.get(xref) ?? null;
      const a = after.get(xref);
      const aClone = a ? cloneRaw(a) : null;
      if (JSON.stringify(b) !== JSON.stringify(aClone)) extraPatches.push({ type: "record", id: xref, before: b, after: aClone });
    }
    if (extraPatches.length) mediaGenRef.current += 1; // shared SOUR/OBJE records changed
    extraPatches.push(...noteChangePatches(notes.changes, { kind: owner.kind, id: owner.kind === "individual" ? owner.indi.id : owner.fam.id }));
    afterNoteChanges(notes.changes, owner.kind === "individual" ? owner.indi.id : owner.fam.id);

    if (owner.kind === "individual") {
      rebuildIndividual(dataset, owner.indi);
      onPushEdit([{ type: "individual", id: owner.indi.id, before: ownerBefore, after: ownerAfter }, ...extraPatches], selectedId);
      onDirty("individual", owner.indi.id);
    } else {
      rebuildFamily(dataset, owner.fam);
      onPushEdit([{ type: "family", id: owner.fam.id, before: ownerBefore, after: ownerAfter }, ...extraPatches], selectedId);
      onDirty("family", owner.fam.id);
    }
    setTick((v) => v + 1);
  }

  /** Builds the `editing` prop for the singleton `AddSourceDialog` from
   * whichever `SourceDialogTarget` is open — "edit" (an existing `SOUR`
   * citation) or "edit-link" (a legacy plain link, prefilled with just its
   * URL). A legacy link only gets promoted to a real citation if the user
   * actually filled in a bibliographic field; a bare URL edit/save just
   * renames it in place and leaves it a plain link. */
  function editingSourceDialogProps() {
    if (!sourceDialogTarget) return undefined;
    if (sourceDialogTarget.kind === "edit") {
      const { node, index, owner, fields } = sourceDialogTarget;
      return {
        fields,
        onSave: (saved: EditSourceFields) => { commitEditSource(node, index, owner, saved); setSourceDialogTarget(null); },
        onRemove: () => { commitRemoveSource(node, index, owner); setSourceDialogTarget(null); },
      };
    }
    if (sourceDialogTarget.kind === "edit-link") {
      const { url, commitRename, commitRemove, commitPromote } = sourceDialogTarget;
      return {
        fields: { url },
        onSave: (saved: EditSourceFields) => {
          const hasBiblio = Boolean(
            saved.title || saved.author || saved.periodical || saved.publisher || saved.agency || saved.place || saved.filingNumber || saved.note,
          );
          if (hasBiblio) {
            const { sourceXref, page, extraPatches } = resolveSourceFields(saved);
            commitPromote(sourceXref, page, extraPatches);
          } else {
            commitRename(saved.url ?? "");
          }
          setSourceDialogTarget(null);
        },
        onRemove: () => { commitRemove(); setSourceDialogTarget(null); },
      };
    }
    return undefined;
  }

  const addRelative = useStableHandler((kind: "father" | "mother" | "partner" | "child", fam?: Family) => {
    if (!person) return;
    const beforePerson = cloneRaw(person.raw);
    const beforeFam = fam ? cloneRaw(fam.raw) : null;
    const prevSpouseOf = new Set(person.spouseOf);
    const prevChildOf = new Set(person.childOf);

    const added =
      kind === "partner"
        ? addPartner(dataset, person, fam)
        : kind === "child"
          ? addChild(dataset, person, fam)
          : addParent(dataset, person, fam, kind);

    // Pre-fill surname from family context
    let defaultSurname: string | undefined;
    if (kind === "child") {
      // Inherit from the father of the family the child was added to
      const childFam = added.childOf.map((id) => dataset.families.get(id)).find((f) => f?.husband);
      const father = childFam?.husband ? dataset.individuals.get(childFam.husband) : undefined;
      defaultSurname = (father ? primaryName(father)?.surname : undefined) || undefined;
    } else if (kind === "father") {
      defaultSurname = primaryName(person)?.surname || undefined;
    }
    if (defaultSurname) {
      setName(added, { surname: defaultSurname });
      rebuildIndividual(dataset, added);
    }

    const patches: RecordPatch[] = [
      { type: "individual", id: person.id, before: beforePerson, after: cloneRaw(person.raw) },
      { type: "individual", id: added.id, before: null, after: cloneRaw(added.raw) },
    ];
    if (fam) {
      patches.push({ type: "family", id: fam.id, before: beforeFam!, after: cloneRaw(fam.raw) });
    } else {
      // Capture newly created families
      const seenFams = new Set<string>();
      const updatedPerson = dataset.individuals.get(person.id);
      for (const famId of [
        ...(updatedPerson?.spouseOf ?? []),
        ...(updatedPerson?.childOf ?? []),
        ...added.spouseOf,
        ...added.childOf,
      ]) {
        if (!prevSpouseOf.has(famId) && !prevChildOf.has(famId) && !seenFams.has(famId)) {
          seenFams.add(famId);
          const newFam = dataset.families.get(famId);
          if (newFam) patches.push({ type: "family", id: famId, before: null, after: cloneRaw(newFam.raw) });
        }
      }
    }
    onPushEdit(patches, selectedId, added.id);

    // Mark everything the add touched — including the modified or newly created
    // family — so the save report lists it and CHAN stamping covers it.
    for (const p of patches) if (p.type !== "record") onDirty(p.type, p.id);
    relationsGenRef.current += 1;
    focusNextName.current = true;
    navigate(added.id);
  });

  /**
   * Create a new person attached to nobody — the start of a new branch, or the
   * very first person in an empty file. Unlike `addRelative` this touches no
   * family at all: one new INDI, and Edit lands on it with the name focused.
   * `name` pre-fills from text the user already typed (the search query).
   */
  const addStandalonePerson = useStableHandler((name?: string) => {
    const added = addIndividual(dataset, "U");
    const parts = name ? splitFullName(name, settings.order) : undefined;
    if (parts?.given || parts?.surname) {
      setName(added, parts);
      rebuildIndividual(dataset, added);
    }
    // Undo removes the person and returns to whoever was shown before (nobody,
    // when this was the first person in an empty file).
    onPushEdit(
      [{ type: "individual", id: added.id, before: null, after: cloneRaw(added.raw) }],
      selectedId,
      added.id,
    );
    onDirty("individual", added.id);
    relationsGenRef.current += 1;
    focusNextName.current = true;
    navigate(added.id);
  });

  // Honour each add-person request from the host (header button, `N` shortcut,
  // global search) exactly once — the nonce is the signal, and it only grows.
  const addPersonNonceRef = useRef(0);
  useEffect(() => {
    if (!addPersonRequest || addPersonRequest.nonce === addPersonNonceRef.current) return;
    addPersonNonceRef.current = addPersonRequest.nonce;
    addStandalonePerson(addPersonRequest.name);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addPersonRequest]);

  const connectRelative = useStableHandler((kind: "father" | "mother" | "partner" | "child", existingId: string, fam?: Family) => {
    if (!person) return;
    const existing = dataset.individuals.get(existingId);
    if (!existing) return;

    const beforePerson = cloneRaw(person.raw);
    const beforeExisting = cloneRaw(existing.raw);
    const beforeFam = fam ? cloneRaw(fam.raw) : null;
    const prevSpouseOf = new Set(person.spouseOf);
    const prevChildOf = new Set(person.childOf);

    if (kind === "father") connectExistingParent(dataset, person, existingId, fam, "father");
    else if (kind === "mother") connectExistingParent(dataset, person, existingId, fam, "mother");
    else if (kind === "partner") connectExistingPartner(dataset, person, existingId, fam);
    else connectExistingChild(dataset, person, existingId, fam);

    const patches: RecordPatch[] = [
      { type: "individual", id: person.id, before: beforePerson, after: cloneRaw(person.raw) },
      { type: "individual", id: existingId, before: beforeExisting, after: cloneRaw(existing.raw) },
    ];
    if (fam) {
      patches.push({ type: "family", id: fam.id, before: beforeFam!, after: cloneRaw(fam.raw) });
    } else {
      const seenFams = new Set<string>();
      const updatedPerson = dataset.individuals.get(person.id);
      const updatedExisting = dataset.individuals.get(existingId);
      for (const famId of [
        ...(updatedPerson?.spouseOf ?? []),
        ...(updatedPerson?.childOf ?? []),
        ...(updatedExisting?.spouseOf ?? []),
        ...(updatedExisting?.childOf ?? []),
      ]) {
        if (!prevSpouseOf.has(famId) && !prevChildOf.has(famId) && !seenFams.has(famId)) {
          seenFams.add(famId);
          const newFam = dataset.families.get(famId);
          if (newFam) patches.push({ type: "family", id: famId, before: null, after: cloneRaw(newFam.raw) });
        }
      }
    }

    onPushEdit(patches, selectedId);
    // Mark everything the connect touched — both persons plus the modified or
    // newly created family — so the save report lists it all.
    for (const p of patches) if (p.type !== "record") onDirty(p.type, p.id);
    relationsGenRef.current += 1;
    setPickingSlot(null);
    setTick((v) => v + 1);
  });

  // Identity-stable so the memoized `EventList`/`FamilySection` don't re-render
  // on every keystroke-commit (see `useStableHandler`).
  const onCopyIndividualEvent = useStableHandler((node: GedNode, label: string) => {
    if (person) setCopyEventRequest({ kind: "individual", node, sourceId: person.id, label });
  });
  const onCopyFamilyEvent = useStableHandler((fam: Family, node: GedNode, label: string) => {
    setCopyEventRequest({ kind: "family", node, sourceId: fam.id, label });
  });

  /**
   * Copy the picked event onto every chosen record, as one undoable step —
   * so handing a new residence to the whole household is a single Ctrl+Z away.
   * The source record is never a target (the picker excludes it), and a target
   * that already carries the event is skipped by the copy helpers.
   */
  const applyCopyEvent = useStableHandler((request: CopyEventRequest, targetIds: string[]) => {
    const isIndividual = request.kind === "individual";
    const before = snapshotRecords(
      dataset,
      isIndividual ? targetIds : [],
      isIndividual ? [] : targetIds,
    );
    for (const id of targetIds) {
      if (isIndividual) {
        const indi = dataset.individuals.get(id);
        if (indi && copyEventToIndividual(indi, request.node)) rebuildIndividual(dataset, indi);
      } else {
        const fam = dataset.families.get(id);
        if (fam && copyEventToFamily(fam, request.node)) rebuildFamily(dataset, fam);
      }
    }
    const patches = patchesFromSnapshots(dataset, before);
    if (patches.length === 0) return;
    onPushEdit(patches, selectedId);
    for (const p of patches) if (p.type !== "record") onDirty(p.type, p.id);
    setTick((v) => v + 1);
  });

  // Member ids of a family, for snapshotting before a detach/delete — pruning a
  // family that drops below two members also unlinks its sole surviving member.
  function familyMemberIds(fam: Family): string[] {
    return [fam.husband, fam.wife, ...fam.children].filter(Boolean) as string[];
  }

  const handleDetachSpouseRole = useStableHandler((fam: Family, role: "HUSB" | "WIFE", confirmMsg: string) => {
    setPendingConfirm({
      message: confirmMsg,
      confirmLabel: t("confirm.remove"),
      action: () => {
        const before = snapshotRecords(dataset, familyMemberIds(fam), [fam.id]);
        detachSpouseRole(dataset, fam, role);
        const patches = patchesFromSnapshots(dataset, before);
        if (patches.length === 0) return;
        onPushEdit(patches);
        for (const p of patches) if (p.type !== "record") onDirty(p.type, p.id);
        relationsGenRef.current += 1;
        setTick((v) => v + 1);
      },
    });
  });

  const handleDetachChild = useStableHandler((fam: Family, childId: string, confirmMsg: string) => {
    setPendingConfirm({
      message: confirmMsg,
      confirmLabel: t("confirm.remove"),
      action: () => {
        const before = snapshotRecords(dataset, familyMemberIds(fam), [fam.id]);
        detachChildFromFamily(dataset, fam, childId);
        const patches = patchesFromSnapshots(dataset, before);
        if (patches.length === 0) return;
        onPushEdit(patches);
        for (const p of patches) if (p.type !== "record") onDirty(p.type, p.id);
        relationsGenRef.current += 1;
        setTick((v) => v + 1);
      },
    });
  });

  function handleDeletePerson() {
    if (!person) return;
    const name = formatName(person);
    setPendingConfirm({
      message: t("edit.deletePersonConfirm", { name }),
      confirmLabel: t("confirm.delete"),
      action: () => {
        const personId = person.id;
        const affectedFamilyIds = [...person.spouseOf, ...person.childOf];

        // Snapshot the person, their families, and all members of those families:
        // a family pruned for dropping below two members unlinks its survivors too.
        const memberIds = new Set<string>([personId]);
        for (const famId of affectedFamilyIds) {
          const fam = dataset.families.get(famId);
          if (fam) for (const m of familyMemberIds(fam)) memberIds.add(m);
        }
        const before = snapshotRecords(dataset, memberIds, affectedFamilyIds);

        removeIndividual(dataset, person);

        const patches = patchesFromSnapshots(dataset, before);

        const nextId =
          history.filter((id) => id !== personId).pop() ??
          dataset.individuals.keys().next().value;

        onPushEdit(patches, personId, nextId);

        for (const p of patches) if (p.type !== "record") onDirty(p.type, p.id);
        relationsGenRef.current += 1;
        setHistory((prev) => prev.filter((id) => id !== personId));
        setNotesAdded(false);
        setSelectedId(nextId);
        if (personId === startId) changeStart(nextId);
        setTick((v) => v + 1);
      },
    });
  }

  // These two hooks must run unconditionally (Rules of Hooks) — they're
  // computed here, above the `!person` early return below, even though
  // both are only consumed once `person` is known to exist. The second one
  // builds decision status (confirmed/rejected/deferred) for relatives shown
  // on the father/mother/partner/child cards, mirroring the candidate list's
  // status chip; a "confirmed" decision wins over any other stale decision
  // recorded against the same main id.
  const { placeSuggestions, placeToAddrs, placeCanonical, addrCanonical, placeCoords, pairCoords } = useMemo(
    () => buildPlaceSuggestions(dataset),
    [dataset],
  );
  // The registers behind the place fields: what completes a place this file has
  // never written, in the layout this file writes places in.
  const placeLookup = usePlaceLookupValue(dataset, placeSuggestions);
  const decisionStatusById = useMemo(() => decisionStatusByMainId(decisions), [decisions]);

  // How many events carry each place+address pair — what the coordinate picker
  // needs to offer "copy this pick to the file's other events at this address".
  const pairUses = useMemo(() => {
    const counts = new Map<string, number>();
    const visit = (raw: GedNode) =>
      walkPlaceAddr(raw, (plac, addr) => {
        const key = placeAddrKey(plac.value!.trim(), addr);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      });
    for (const indi of dataset.individuals.values()) visit(indi.raw);
    for (const fam of dataset.families.values()) visit(fam.raw);
    return counts;
    // tick/undoVersion: a place or address edit changes these counts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset, tick, undoVersion]);

  const coordShare = useMemo<CoordShare>(
    () => ({
      // Every event at the pair except the one being edited. Deliberately blind
      // to what those events currently hold: the coordinate they already share
      // is exactly the one being corrected here, and counting that as "nothing
      // to copy" is what used to hide the offer whenever a pinned address was
      // re-pinned. A pick equal to what they hold simply produces no patch.
      countOthers: (place, address) =>
        Math.max(0, (pairUses.get(placeAddrKey(place.trim(), address.trim())) ?? 0) - 1),
      applyToAll: (place, address, coord) => {
        const key = placeAddrKey(place.trim(), address.trim());
        const patches = applyGeocodeByAddress(dataset, new Map([[key, { coord }]]), true);
        if (!patches.length) return;
        onPushEdit(patches);
        for (const p of patches) if (p.type !== "record") onDirty(p.type, p.id);
        setTick((v) => v + 1);
      },
    }),
    [dataset, pairUses, onPushEdit, onDirty],
  );

  // Glyph-tagged parents' ages at this person's birth, for the BIRT row
  // ("Show ages" setting). First parent family with each role wins. Memoized
  // on the person's identity (replaced by rebuildIndividual on each of their
  // own edits) so the memoized EventList's prop stays stable across unrelated
  // ticks.
  // Hidden-map preference: an app setting (Settings → Display), so a user who
  // wants the full height for editing sets it once.
  const mapHidden = !settings.showEditMap;
  const toggleMapHidden = () => setSettings({ showEditMap: mapHidden });

  // The person's coordinate-carrying events (own + spouse-family), grouped
  // per location as coloured pins, plus their chronological life path — the
  // small map under the events list. Null when nothing is geocoded.
  const personMap = useMemo(() => {
    if (!person) return null;
    const points = personPoints(dataset, person.id);
    if (!points.length) return null;
    const byCoord = new Map<
      string,
      { coord: GeoCoord; place: string; addrs: Set<string>; labels: string[]; kinds: Set<string> }
    >();
    for (const p of points) {
      const k = `${p.coord.lat}:${p.coord.lon}`;
      const label = `${t(`event.${p.tag}`, { defaultValue: p.tag })}${p.year !== undefined ? ` ${p.year}` : ""}`;
      const hit = byCoord.get(k);
      if (hit) {
        hit.labels.push(label);
        hit.kinds.add(p.kind);
        if (p.address) hit.addrs.add(p.address);
      } else {
        byCoord.set(k, {
          coord: p.coord,
          place: p.place,
          addrs: new Set(p.address ? [p.address] : []),
          labels: [label],
          kinds: new Set([p.kind]),
        });
      }
    }
    const pins = [...byCoord.values()].map((g) => ({
      coord: g.coord,
      label: g.place,
      // One address means this pin is that house; several events with
      // different addresses landed on one coordinate, so name none.
      ...(g.addrs.size === 1 ? { sub: [...g.addrs][0] } : {}),
      lines: g.labels,
      kind: "candidate" as const,
      colorVar: kindsColorVar(g.kinds),
    }));
    const path = buildPersonPaths(points)
      .find((pp) => pp.personId === person.id)
      ?.stops.map((s) => s.coord);
    // Event kinds present, in the canonical order — the legend row.
    const present = new Set(points.map((p) => p.kind));
    const kinds = MAP_EVENT_KINDS.filter((k) => present.has(k));
    return { pins, path, kinds };
    // person is rebuilt (fresh identity) on each own edit; undoVersion covers
    // undo/redo; tick covers family-event edits, which replace the Family
    // object but not this person (same reason birthParentAges depends on it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset, person, undoVersion, tick, t]);

  const birthParentAges = useMemo(() => {
    if (!settings.showAge || !person) return undefined;
    const birthDate = birthDateOf(person);
    if (!birthDate) return undefined;
    const famsOf = person.childOf.map((famId) => dataset.families.get(famId));
    const fatherId = famsOf.find((f) => f?.husband)?.husband;
    const motherId = famsOf.find((f) => f?.wife)?.wife;
    const father = fatherId ? dataset.individuals.get(fatherId) : undefined;
    const mother = motherId ? dataset.individuals.get(motherId) : undefined;
    return coupleAgesDisplay(
      father,
      mother,
      birthDate,
      isSameSexCouple(father, mother)
        ? { husband: t("event.age.parent"), wife: t("event.age.parent") }
        : { husband: t("event.age.father"), wife: t("event.age.mother") },
      t,
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.showAge, person, dataset, t, tick]); // tick: parents' own dates can change without replacing `person`

  // Shared card context for relative PersonCards — one stable object, not a
  // per-card literal (which would defeat the memoized sections' prop equality).
  const cardRefCtx = useMemo(() => ({ dataset, onNavigate: navigate }), [dataset, navigate]);

  /** Trigger the "+ Add note" flow on a family's NotesEditor. */
  const onAddFamNote = useStableHandler((famId: string) => {
    setFamNoteAdd((prev) => ({ ...prev, [famId]: (prev[famId] ?? 0) + 1 }));
  });

  if (!person) {
    return (
      <div className="section open edit-view">
        <div className="section-body">
          <p className="gm-file main gm-data" title={`${t("tree.main")}: ${fileName}`}>{fileName}</p>
          <p className="muted">{t("edit.empty")}</p>
          <button className="tree-open-btn edit-empty-add" onClick={() => addStandalonePerson()}>
            <AddPersonIcon size={15} /> {t("edit.addNewPerson")}
          </button>
        </div>
      </div>
    );
  }

  const parentFamilies = person.childOf
    .map((famId) => dataset.families.get(famId))
    .filter((f): f is NonNullable<typeof f> => !!f);

  const spouseFamilies = person.spouseOf
    .map((famId) => dataset.families.get(famId))
    .filter((f): f is NonNullable<typeof f> => !!f);

  const lifespan = lifespanWithAge(person, settings.showAge);

  const startInfo = settings.showKinship && startId ? kinshipInfo(dataset, startId, selectedId!, t) : undefined;
  const startPersonName = startId
    ? formatName(dataset.individuals.get(startId)!)
    : undefined;
  const kinship = startInfo?.label;
  const kinshipLineage = lineageClass(startInfo?.lineage);
  const kinshipTooltip = startInfo && startPersonName
    ? kinshipTooltipText(startInfo, startPersonName, t)
    : undefined;


  return (
    <CoordShareProvider value={coordShare}>
    <PlaceLookupProvider value={placeLookup}>
    <div className="section open edit-view">
      <div className="section-body" ref={editBodyRef}>
        <div className="edit-parents">
          {(parentFamilies.length ? parentFamilies : [undefined]).map((fam, i) => (
            <ParentFamilyGroup
              key={fam?.id ?? `empty-${i}`}
              fam={fam}
              personId={person.id}
              dataset={dataset}
              t={t}
              navigate={navigate}
              pickingSlot={pickingSlot}
              setPickingSlot={setPickingSlot}
              connectRelative={connectRelative}
              addRelative={addRelative}
              handleDetachSpouseRole={handleDetachSpouseRole}
              cardRefCtx={cardRefCtx}
              decisionStatusById={decisionStatusById}
              changedPersonIds={changedPersonIds}
              startId={startId}
              startPersonName={startPersonName}
              relationsGen={relationsGenRef.current}
              undoVersion={undoVersion}
            />
          ))}
          <div className="edit-actions">
            <BackButton
              label={t("edit.back")}
              shortcutHint="⌫"
              showLabel
              disabled={history.length === 0}
              onClick={goBack}
            />
            <button
              className="tree-open-btn charts-open-btn"
              onClick={() => selectedId && onShowCharts(selectedId)}
              disabled={!selectedId}
              title={t("edit.charts.tooltip")}
            >
              <ChartIcon size={14} /> {t("edit.charts.button")}
            </button>
          </div>
        </div>

        <div className="edit-connector-v" />

        <div
          className={`edit-person ${mediaDragOver ? "media-drop-active" : ""}`}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            setMediaDragOver(true);
          }}
          onDragLeave={(e) => { if (e.currentTarget === e.target) setMediaDragOver(false); }}
          onDrop={handleMediaDrop}
        >
          <div className="edit-person-header">
            <NameEditor
              key={`name-${person.id}-${undoVersion}`}
              person={person}
              t={t}
              lifespan={lifespan}
              commit={commit}
              focusOnMount={focusNextName.current}
              onMounted={() => { focusNextName.current = false; }}
              mergeHighlight={mergeHighlight}
              hasMatch={!!matchCompareId}
              matchStatus={matchStatus}
              onToggleMatchStatus={toggleMatchStatus}
              kinship={kinship}
              kinshipLineage={kinshipLineage}
              kinshipTooltip={kinshipTooltip}
              modified={changedPersonIds.has(person.id)}
              controls={
                <button
                  type="button"
                  className="edit-delete-btn"
                  title={t("edit.deletePersonTooltip")}
                  onClick={handleDeletePerson}
                >
                  🗑
                </button>
              }
            />
          </div>
          <PersonMedia
            // person.raw is mutated in place, so remount whenever this person
            // was rebuilt (fresh `Individual` identity → fresh nodeId) or a
            // shared OBJE record changed via another owner's edit (mediaGen),
            // to re-read the OBJE children (resolved files are blob-cached).
            key={`photos-${person.id}-${nodeId(person)}-${mediaGenRef.current}-${undoVersion}`}
            raw={person.raw}
            records={dataset.records}
            refCtx={mediaRefCtx}
            editable={{
              onAdd: () => handleAddMedia({ kind: "individual" }),
              onDelete: (addr) => handleDeleteMedia({ kind: "individual" }, addr),
              onReorder: (from, to) => commit((indi) => reorderMedia(indi.raw, from, to)),
            }}
          />
          <OtherNamesEditor
            key={`names-${person.id}-${undoVersion}`}
            person={person}
            t={t}
            commit={commit}
            emptyEventGroups={INDIVIDUAL_EVENT_GROUPS as unknown as { labelKey: string; tags: string[] }[]}
            onAddEvent={(tag) => {
              commit((indi) => addEventNode(indi, tag));
              // addEventNode inserts as the last child with this tag, so find it now.
              const sameTag = childrenByTag(person.raw, tag);
              if (sameTag.length) setPendingFocusEventNodeId(nodeId(sameTag[sameTag.length - 1]));
            }}
            showAddLink={!(person.links ?? []).length && !(person.sources ?? []).length && !mergeIncomingLinks.get("links")?.length && !mergeIncomingSources.get("links")?.length}
            onAddLink={() => setSourceDialogTarget({ kind: "individual" })}
            showAddNote={!notesAdded && !(person.noteRefs ?? []).some((r) => r.text.trim())}
            onAddNote={() => setNotesAdded(true)}
            showAddMedia={collectMediaRefs(person.raw, dataset.records).length === 0}
            onAddMedia={() => handleAddMedia({ kind: "individual" })}
            marriedNameTag={marriedNameTag}
            leadingControl={
              <>
                <SexToggle key={`sex-${person.id}`} person={person} t={t} commit={commit} />
                <PrivateToggle
                  on={!!person.private}
                  t={t}
                  target={t("edit.privateTarget.individual")}
                  onToggle={() => commit((indi) => setPrivateFlag(indi.raw, !indi.private, privacyStyle, dataset.records))}
                />
              </>
            }
          />
          {((person.links ?? []).length > 0 || (person.sources ?? []).length > 0 || (mergeIncomingLinks.get("links")?.length ?? 0) > 0 || (mergeIncomingSources.get("links")?.length ?? 0) > 0) && (
            <div className="edit-record-section">
              <LinksEditor
                key={`rlinks-${person.id}-${undoVersion}`}
                links={person.links ?? []}
                sources={person.sources ?? []}
                incomingLinks={mergeIncomingLinks.get("links")}
                incomingSources={mergeIncomingSources.get("links")}
                sectionLabel={t("field.sources")}
                t={t}
                onCommit={(links) => commit((indi) => setIndividualLinks(indi, links))}
                onAddSource={() => setSourceDialogTarget({ kind: "individual" })}
                onEditSource={(idx) => openEditSource(person.raw, idx, { kind: "individual", indi: person })}
                onOpenSourceDialog={setSourceDialogTarget}
                onAttachSource={(sourceXref, page, extraPatches, links) =>
                  commit((indi) => { attachSourceCitation(indi.raw, sourceXref, page, INDI_CHILD_ORDER); setIndividualLinks(indi, links); }, extraPatches)
                }
              />
            </div>
          )}
          {((person.noteRefs ?? []).some((r) => r.text.trim()) || notesAdded) && (() => {
            // Refresh the baseline while the person is clean (its notes are the
            // saved state); keep it once edits begin so changed notes stay bold.
            const bl = noteBaselineRef.current;
            if (!changedPersonIds.has(person.id) || !bl.has(person.id)) {
              bl.set(person.id, (person.noteRefs ?? []).map((r) => r.text));
            }
            return (
              <div className="edit-record-section">
                <NotesEditor
                  key={`notes-${person.id}-${undoVersion}-${noteGenRef.current}`}
                  notes={person.noteRefs ?? []}
                  addOnMount={notesAdded && !(person.noteRefs ?? []).some((r) => r.text.trim())}
                  sectionLabel={t("field.notes")}
                  baselineNotes={bl.get(person.id)}
                  t={t}
                  onCommit={(refs) => commit((indi, notes) => setNotes(notes, indi, refs))}
                />
              </div>
            );
          })()}
          <EventList
            key={person.id}
            person={person}
            t={t}
            commit={commit}
            openEditSource={openEditSource}
            onOpenSourceDialog={setSourceDialogTarget}
            placeSuggestions={placeSuggestions}
            placeToAddrs={placeToAddrs}
            placeCanonical={placeCanonical}
            addrCanonical={addrCanonical}
            placeCoords={placeCoords}
            pairCoords={pairCoords}
            mergeHighlight={mergeHighlight}
            mergeIncomingSources={mergeIncomingSources}
            mainMergeKeyBases={mainMergeKeyBases}
            mainMergeCompareKeys={mainMergeCompareKeys}
            mainMergeSortKeys={mainMergeSortKeys}
            extraMergeEvents={extraMergeEvents}
            onRejectIncomingEvent={rejectIncomingEvent}
            onMaterializeIncomingSources={materializeMergeEventSources}
            onResolveMergeField={resolveMergeFields}
            resolvedSessionFields={resolvedSessionFields}
            materializedEventIds={materializedEventIds}
            onMaterializeEventNode={markMaterializedEvent}
            pendingFocusNodeId={pendingFocusEventNodeId}
            undoVersion={undoVersion}
            mergeGen={mergeGen}
            birthParentAges={birthParentAges}
            onCopyEvent={onCopyIndividualEvent}
          />
          {personMap && (
            <div className="edit-person-map">
              <div className="edit-person-map-head">
                <button className="edit-person-map-toggle" onClick={toggleMapHidden} aria-expanded={!mapHidden}>
                  {mapHidden ? t("edit.mapShow") : t("edit.mapHide")}
                </button>
                {!mapHidden && (
                  <div className="edit-person-map-legend">
                    {personMap.kinds.map((k) => (
                      <span key={k} className="edit-map-legend-item">
                        <span className="map-kind-dot" style={{ background: `var(--map-${k})` }} />
                        {t(`map.kind.${k}`)}
                      </span>
                    ))}
                    {personMap.path && personMap.path.length > 1 && (
                      <span className="edit-map-legend-item">
                        <span className="edit-map-legend-line" />
                        {t("map.paths")}
                      </span>
                    )}
                  </div>
                )}
              </div>
              {!mapHidden && (
                <Suspense fallback={<div className="tools-geo-minimap" />}>
                  <MiniPlaceMap pins={personMap.pins} path={personMap.path} fitKey={person.id} />
                </Suspense>
              )}
            </div>
          )}
        </div>

        <div className="edit-families">
          {(spouseFamilies.length ? spouseFamilies : [undefined]).map((fam, i) => (
            <FamilySection
              key={fam?.id ?? `empty-${i}`}
              fam={fam}
              personId={person.id}
              dataset={dataset}
              t={t}
              navigate={navigate}
              pickingSlot={pickingSlot}
              setPickingSlot={setPickingSlot}
              connectRelative={connectRelative}
              addRelative={addRelative}
              handleDetachSpouseRole={handleDetachSpouseRole}
              handleDetachChild={handleDetachChild}
              cardRefCtx={cardRefCtx}
              decisionStatusById={decisionStatusById}
              changedPersonIds={changedPersonIds}
              startId={startId}
              startPersonName={startPersonName}
              relationsGen={relationsGenRef.current}
              undoVersion={undoVersion}
              noteGen={noteGenRef.current}
              commitFamily={commitFamily}
              openEditSource={openEditSource}
              onOpenSourceDialog={setSourceDialogTarget}
              onAddFamNote={onAddFamNote}
              handleAddMedia={handleAddMedia}
              handleDeleteMedia={handleDeleteMedia}
              mediaCtxFor={mediaCtxFor}
              markFamilyTagRetagged={markFamilyTagRetagged}
              dismissExtraEvent={dismissExtraEvent}
              onCopyFamilyEvent={onCopyFamilyEvent}
              famMergeKeyBase={fam ? familyKeyBaseById.get(fam.id) : undefined}
              mergeHighlight={mergeHighlight}
              mergeIncomingSources={mergeIncomingSources}
              resolvedSessionFields={resolvedSessionFields}
              placeSuggestions={placeSuggestions}
              placeToAddrs={placeToAddrs}
              placeCanonical={placeCanonical}
              addrCanonical={addrCanonical}
            placeCoords={placeCoords}
            pairCoords={pairCoords}
              pendingFocusFamEventKey={pendingFocusFamEventKey}
              setPendingFocusFamEventKey={setPendingFocusFamEventKey}
              famNoteAddCount={fam ? famNoteAdd[fam.id] : undefined}
              mergeGen={mergeGen}
              mediaGen={mediaGenRef.current}
            />
          ))}
        </div>
      </div>
      <AddSourceDialog
        isOpen={sourceDialogTarget !== null}
        onClose={() => setSourceDialogTarget(null)}
        onAdd={handleAddSource}
        dataset={dataset}
        t={t}
        editing={editingSourceDialogProps()}
      />
      <AddMediaDialog
        isOpen={mediaPickerOpen}
        onClose={() => setMediaPickerOpen(false)}
        onAdd={(picked) => {
          for (const p of picked) addMediaTo(mediaAddTarget, p.path, p.existingXref);
          if (picked.length === 1) openLastMedia(mediaAddTarget);
        }}
        dataset={dataset}
        t={t}
      />
      {copyEventRequest && (
        <CopyEventDialog
          request={copyEventRequest}
          dataset={dataset}
          t={t}
          onCancel={() => setCopyEventRequest(null)}
          onConfirm={(ids) => { applyCopyEvent(copyEventRequest, ids); setCopyEventRequest(null); }}
        />
      )}
      {pendingConfirm && (
        <ConfirmDialog
          message={pendingConfirm.message}
          confirmLabel={pendingConfirm.confirmLabel}
          danger={pendingConfirm.danger ?? true}
          onConfirm={() => { pendingConfirm.action(); setPendingConfirm(null); }}
          onCancel={() => setPendingConfirm(null)}
        />
      )}
    </div>
    </PlaceLookupProvider>
    </CoordShareProvider>
  );
}
