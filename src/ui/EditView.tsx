import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type RecordPatch, type PendingEditApply, cloneRaw, snapshotRecords, patchesFromSnapshots } from "./historyTypes";
import { useTranslation } from "react-i18next";
import type { Dataset, Family, GedNode, SourceCitation } from "../gedcom/types";
import { lifespanOf } from "../gedcom/lifespan";
import { childrenByTag, firstChild } from "../gedcom/node";
import { defaultStartId, primaryName } from "../match/relatives";
import { useNameOf, useSettings } from "./SettingsContext";
import { useChartSettings, type ChartKind } from "./ChartSettingsContext";
import { BackButton } from "./BackButton";
import { ChartIcon } from "./icons/ChartIcon";
import { kinshipInfo, kinshipTooltip as kinshipTooltipText, lineageClass } from "../match/kinship";
import { familyMergeKeyBases, individualFieldRows, lifespanAnchors, orderedEventTags, zoneSortKey } from "../review/fields";
import { materializeEventSources } from "../merge/merge";
import { decisionKey, decisionStatusByMainId, defaultChoice, type CandidateDecision, type MatchDecisionStatus } from "../review/types";
import {
  addChild,
  addEventNode,
  addFamilyEventNode,
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
  createMediaRecord,
  createSourceRecord,
  findSharedMediaByFile,
  removeIndividualMediaAtIndex,
  reorderIndividualMedia,
  setMediaInfo,
  detachChildFromFamily,
  detachSpouseRole,
  FAM_CHILD_ORDER,
  getMediaAndSourceCtx,
  INDI_CHILD_ORDER,
  insertRecord,
  rebuildFamily,
  rebuildIndividual,
  removeFamilyEvent,
  removeIndividual,
  removeSourceCitationAtIndex,
  setFamilyLinks,
  setFamilyNotes,
  setIndividualLinks,
  setName,
  setNotes,
  updateSourceCitation,
  type EditSourceFields,
  type NewSourceFields,
} from "../gedcom/edit";
import { childText, clearObjeNodeCache, findExistingSource, isPointer, resolveSourceCitation } from "../gedcom/source";
import { detectMediaMode } from "../gedcom/media";
import { useMediaFolder } from "./MediaFolderContext";
import { PersonCard } from "./PersonCard";
import { AddSourceDialog, type AddSourceResult } from "./AddSourceDialog";
import { AddPhotoDialog } from "./AddPhotoDialog";
import { nodeId } from "./edit/nodeId";
import { buildPlaceSuggestions } from "./edit/placeSuggestions";
import { INDIVIDUAL_EVENT_GROUPS, FAMILY_HIDDEN_EVENT_TAGS, familyEventHasMergeData } from "./edit/editConstants";
import { MARRIAGE_SYMBOL } from "../chart/nodeDisplay";
import { KEY, KEY_STATUS, isEditableTarget, isModalOpen } from "../keyboard/shortcuts";
import type { Commit, FamilyCommit, SourceDialogTarget, RemoveSourceOwner, CommitRemoveSource, OpenEditSource } from "./edit/types";
import { RelativePickerCard } from "./edit/RelativePickerCard";
import { NameEditor } from "./edit/NameEditor";
import { SexToggle } from "./edit/SexToggle";
import { OtherNamesEditor } from "./edit/OtherNamesEditor";
import { EventList } from "./edit/EventList";
import { FamilyEventRow } from "./edit/FamilyEventRow";
import { AddEventSelect } from "./edit/AddEventSelect";
import { NotesEditor } from "./edit/NotesEditor";
import { LinksEditor } from "./edit/LinksEditor";
import { ConfirmDialog } from "./ConfirmDialog";
import { PersonPhotos } from "./PersonPhotos";
import { collectPhotoRefs, usePhotoViewer, type PhotoEditFields } from "./PhotoViewer";

/** Image filenames the photo drop zone accepts. */
const IMAGE_NAME_RE = /\.(jpe?g|png|gif|webp|bmp|tiff?)$/i;

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
  /** False when Edit is mounted but hidden behind Merge mode — kept mounted
   * across mode switches so toggling modes with a large match list doesn't
   * re-render the whole tab from scratch. Gates the global keydown shortcut
   * so it doesn't fire while another mode is the one actually visible. */
  active: boolean;
}

/** Edit mode's person view: parents on top, the selected person in the
 * center, partners + children on the bottom. The center panel is editable;
 * relatives navigate on click. */
export function EditView({ dataset, fileName, startId, changeStart, onDirty, onShowCharts, marriedNameTag, navigateToId, onNavigated, onPersonChange, matchCompareIdFor, matchOrder, decisions, changedPersonIds, compareDataset, onUpdateDecision, onPushEdit, onPatchApplied, pendingApply, onApplied, active }: Props) {
  const { t } = useTranslation();
  const formatName = useNameOf();
  const { settings } = useSettings();
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
    // Third pass: restore individual/family records and rebuild them.
    for (const patch of patches) {
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
          insertRecord(dataset.records, restored);
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
          insertRecord(dataset.records, restored);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          rebuildFamily(dataset, { raw: restored } as any);
        }
      }
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
    const raf = requestAnimationFrame(() => {
      applyEditPatches(patches, direction);
      setTick((v) => v + 1);
      setUndoVersion((v) => v + 1);
      onPatchApplied?.(patches, direction);
    });
    return () => cancelAnimationFrame(raf);
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

  function navigate(id: string) {
    if (!id || id === selectedId) return;
    if (selectedId) setHistory((h) => [...h, selectedId]);
    setNotesAdded(false);
    setPickingSlot(null);
    setSelectedId(id);
  }

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

  function goBack() {
    setHistory((h) => {
      if (h.length === 0) return h;
      setSelectedId(h[h.length - 1]);
      return h.slice(0, -1);
    });
  }

  /**
   * Event sub-field keys (e.g. "OCCU.value") that were just materialized from
   * a merge suggestion via a direct edit. A field like this starts life on a
   * row with no real event node yet, so its first commit creates the node —
   * which changes the row's React key and remounts `EventFieldsRow`, wiping
   * the local "is this dirty since I started editing" state that ordinary
   * (already-existing) fields keep for the rest of the session. This set lets
   * the field keep showing as dirty/bold across that one-time remount.
   */
  const [resolvedSessionFields, setResolvedSessionFields] = useState<Set<string>>(new Set());
  useEffect(() => { setResolvedSessionFields(new Set()); }, [selectedId]);

  /**
   * Stable `nodeId`s of event nodes materialized this session from an
   * incoming-only ("extra") merge suggestion. Every field of such an event is a
   * change relative to the saved main (the event didn't exist there), so the
   * whole row stays bold until Save — independently of `resolvedSessionFields`,
   * which is per-field and gets cleared once the confirmed decision disappears.
   * Unlike that set, this one must survive merge-state recomputes (the incoming
   * counterpart is rejected on materialization, so there's no `mergeHighlight`
   * entry left to re-derive the marker from); it's reset only on person change.
   */
  const [materializedEventIds, setMaterializedEventIds] = useState<Set<number>>(new Set());
  useEffect(() => { setMaterializedEventIds(new Set()); }, [selectedId]);
  const markMaterializedEvent = useCallback((id: number) => {
    setMaterializedEventIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);

  /**
   * Bumped only when `decisions` itself changes (a match got confirmed,
   * rejected, or a field choice flipped) — not on every dataset edit, even
   * though `mergeData` below also recomputes on plain edits (it depends on
   * `tick`/`dataset` too, to keep displayed values current). Event rows fold
   * this into their React `key` so they remount and re-read fresh merge
   * values when a decision changes — without it, a row already mounted
   * before a match was confirmed keeps the lazy-initialized state (e.g.
   * `expanded`, field values) it had at mount, since merely changing props
   * doesn't re-run a `useState(() => ...)` initializer. Tying this to every
   * `tick` instead would remount rows on every keystroke-commit, dropping
   * in-progress edits in sibling fields of the same row (e.g. losing focus
   * right after expanding a row to add a source) — see e2e/edit.spec.ts.
   */
  const mergeGenRef = useRef(0);
  const lastDecisionsRef = useRef(decisions);
  if (lastDecisionsRef.current !== decisions) {
    lastDecisionsRef.current = decisions;
    mergeGenRef.current += 1;
  }

  /** Merge preview data for the currently selected person's confirmed match. */
  const mergeData = useMemo(() => {
    const empty = {
      mergeHighlight: new Map<string, string>(),
      /** Field key → incoming links the merge will add (record-level "links" row). */
      mergeIncomingLinks: new Map<string, string[]>(),
      /** Field key → incoming source citations the merge will add (per-event "<tag>.sources" rows). */
      mergeIncomingSources: new Map<string, SourceCitation[]>(),
      /** main person.events overall index → field key base aligned with orderedEventTags. */
      mainMergeKeyBases: new Map<number, string>(),
      /** main person.events overall index → the incoming event it's paired with, as
       * `${tag}:${compareIdx}` — see `CandidateDecision.rejectedEvents`. Lets deleting a
       * paired main event also reject its incoming counterpart, so it isn't silently
       * re-added on save. */
      mainMergeCompareKeys: new Map<number, string>(),
      /** main person.events overall index → sort key from incoming date, when main has no date. */
      mainMergeSortKeys: new Map<number, number>(),
      /** Incoming-only events with no main counterpart (BIRT excluded — always shown). */
      extraMergeEvents: [] as { tag: string; keyBase: string; sortKey: number; compareIdx: number }[],
      /** main family id → the `fam.<id>` key base used for that family's rows
       * in `mergeHighlight`/`mergeIncomingSources` (see `familyMergeKeyBases`). */
      familyMergeKeyBases: new Map<string, string>(),
      /** Whether the current person still has a confirmed merge decision. */
      hasMergeDecision: false,
    };
    if (!decisions || !compareDataset || !person) return empty;
    for (const [key, dec] of decisions) {
      if (dec.status !== "confirmed") continue;
      const parts = key.split(":");
      if (parts.length !== 3 || parts[0] !== "individual" || parts[1] !== person.id) continue;
      const incoming = compareDataset.individuals.get(parts[2]);
      if (!incoming) continue;
      const rejectedEvents = dec.rejectedEvents?.length ? new Set(dec.rejectedEvents) : undefined;

      // Field key → incoming value for all fields the merge will add/change.
      const rows = individualFieldRows(t, person, incoming, dataset, compareDataset, undefined, rejectedEvents);
      const mergeHighlight = new Map<string, string>();
      const mergeIncomingLinks = new Map<string, string[]>();
      const mergeIncomingSources = new Map<string, SourceCitation[]>();
      for (const row of rows) {
        if (row.isGroupHeader) continue;
        if (row.state === "agree" || row.state === "main-only") continue;
        const choice = dec.fields[row.key] ?? defaultChoice(row);
        if (choice === "main") continue;
        if (row.incoming) mergeHighlight.set(row.key, row.incoming);
        // The record-level "Sources" row carries plain links as `incomingLinkIcons`
        // (other rows, if any, as `incomingLinks`); both preview the same way.
        const incLinks = row.incomingLinks ?? row.incomingLinkIcons;
        if (incLinks?.length) mergeIncomingLinks.set(row.key, incLinks);
        if (row.incomingSources?.length) mergeIncomingSources.set(row.key, row.incomingSources);
      }

      // Map main overall event index → the key base that orderedEventTags assigned to it.
      // This handles multi-instance keys (e.g. "RESI.0") that arise when incoming has more
      // events of the same tag, or when a same-tag pair scores too low to be merged.
      const mByTagIndices = new Map<string, number[]>();
      person.events.forEach((ev, i) => {
        const arr = mByTagIndices.get(ev.tag) ?? [];
        arr.push(i);
        mByTagIndices.set(ev.tag, arr);
      });
      const mainMergeKeyBases = new Map<number, string>();
      const mainMergeCompareKeys = new Map<number, string>();
      const mainMergeSortKeys = new Map<number, number>();
      const extraMergeEvents: { tag: string; keyBase: string; sortKey: number; compareIdx: number }[] = [];
      const EVENT_SUBS = ["date", "place", "addr", "value", "note", "agency", "type", "cause"] as const;

      // Index incoming events by tag for sort key lookup.
      const cByTag = new Map<string, typeof incoming.events>();
      incoming.events.forEach((ev) => {
        const arr = cByTag.get(ev.tag) ?? [];
        arr.push(ev);
        cByTag.set(ev.tag, arr);
      });

      // Shared anchors so the Edit event list orders events identically to the
      // comparison view (`orderedEventTags`), instead of sorting undated
      // life-zone events before all dated ones.
      const anchors = lifespanAnchors([...person.events, ...incoming.events]);

      for (const inst of orderedEventTags(person, incoming)) {
        const keyBase = inst.multi ? `${inst.tag}.${inst.keyIdx}` : inst.tag;
        if (inst.mainIdx >= 0) {
          const overallIdx = mByTagIndices.get(inst.tag)?.[inst.mainIdx];
          if (overallIdx !== undefined) {
            mainMergeKeyBases.set(overallIdx, keyBase);
            if (inst.compareIdx >= 0 && !rejectedEvents?.has(`${inst.tag}:${inst.compareIdx}`)) {
              mainMergeCompareKeys.set(overallIdx, `${inst.tag}:${inst.compareIdx}`);
            }
            // Authoritative sort key for this main event (zone-aware, falling
            // back to the paired incoming date when main itself has none), so
            // the row keeps the same chronological position as the merge preview.
            const mainDate = person.events[overallIdx]?.date;
            const incomingDate = inst.compareIdx >= 0 ? cByTag.get(inst.tag)?.[inst.compareIdx]?.date : undefined;
            mainMergeSortKeys.set(overallIdx, zoneSortKey(mainDate ?? incomingDate, inst.tag, anchors));
          }
        } else if (inst.tag !== "BIRT") {
          // Incoming-only event — show only if there is merge data for it.
          // BIRT is always shown in its own row so exclude it from extras.
          if (EVENT_SUBS.some((s) => mergeHighlight.has(`${keyBase}.${s}`)) || mergeIncomingSources.has(`${keyBase}.sources`)) {
            const incomingEv = inst.compareIdx >= 0 ? cByTag.get(inst.tag)?.[inst.compareIdx] : undefined;
            if (incomingEv) {
              extraMergeEvents.push({ tag: inst.tag, keyBase, sortKey: zoneSortKey(incomingEv.date, inst.tag, anchors), compareIdx: inst.compareIdx });
            }
          }
        }
      }

      const familyKeyBases = familyMergeKeyBases(person, incoming, dataset, compareDataset);

      return { mergeHighlight, mergeIncomingLinks, mergeIncomingSources, mainMergeKeyBases, mainMergeCompareKeys, mainMergeSortKeys, extraMergeEvents, familyMergeKeyBases: familyKeyBases, hasMergeDecision: true };
    }
    return empty;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decisions, compareDataset, person, dataset, t, tick]); // tick is a cache-bust counter — not used directly but must invalidate the memo

  const { mergeHighlight, mergeIncomingLinks, mergeIncomingSources, mainMergeKeyBases, mainMergeCompareKeys, mainMergeSortKeys, extraMergeEvents, familyMergeKeyBases: familyKeyBaseById, hasMergeDecision } = mergeData;

  /**
   * `resolvedSessionFields` deliberately survives the remount that fires when
   * a field's own commit updates `decisions` (see comment below) so the field
   * keeps showing bold up to Save. But once the confirmed decision itself
   * disappears — Save baked it in, or the match got rejected — there's no
   * more "incoming" value left to be bold about, so clear it then. Without
   * this it stays forced-bold for the rest of the session since nothing else
   * ever removes a key from the set.
   */
  const hadMergeDecisionRef = useRef(false);
  useEffect(() => {
    if (hadMergeDecisionRef.current && !hasMergeDecision) {
      setResolvedSessionFields(new Set());
    }
    hadMergeDecisionRef.current = hasMergeDecision;
  }, [hasMergeDecision]);

  /**
   * Reject an incoming individual event outright — called when the user
   * deletes its paired main event, deletes/dismisses an unmatched "extra"
   * suggestion row, or edits an extra row's field (materializing a new main
   * event from it). Persists into the confirmed decision's `rejectedEvents`
   * (see `CandidateDecision`) so the event is treated as absent everywhere —
   * the live preview here and the merge engine on Save — for the rest of the
   * session, regardless of how main/incoming pairing reshuffles afterward.
   */
  function rejectIncomingEvent(tag: string, compareIdx: number) {
    if (!decisions || !person || !onUpdateDecision || compareIdx < 0) return;
    const eventKey = `${tag}:${compareIdx}`;
    for (const [key, dec] of decisions) {
      const parts = key.split(":");
      if (parts.length !== 3 || parts[0] !== "individual" || parts[1] !== person.id) continue;
      if (dec.status !== "confirmed") continue;
      if (dec.rejectedEvents?.includes(eventKey)) break;
      onUpdateDecision(key, { ...dec, rejectedEvents: [...(dec.rejectedEvents ?? []), eventKey] });
      break;
    }
  }

  /**
   * Copy an "extra" incoming-only event's `SOUR` citations into `eventNode`
   * — the main event a direct field edit just materialized for it. Must
   * run before that event gets `rejectIncomingEvent`'d, since afterward its
   * sources are gone from comparison everywhere, including the merge engine
   * on Save. Returns undo patches for any `SOUR`/`REPO` records it imported.
   */
  function materializeMergeEventSources(eventNode: GedNode, tag: string, compareIdx: number): RecordPatch[] {
    if (!decisions || !person || !compareDataset || compareIdx < 0) return [];
    for (const [key, dec] of decisions) {
      const parts = key.split(":");
      if (parts.length !== 3 || parts[0] !== "individual" || parts[1] !== person.id) continue;
      if (dec.status !== "confirmed") continue;
      const incoming = compareDataset.individuals.get(parts[2]);
      if (!incoming) break;
      const incEvent = childrenByTag(incoming.raw, tag)[compareIdx];
      if (!incEvent) break;
      const imported = materializeEventSources(dataset, compareDataset, eventNode, incEvent);
      return imported.map((r) => ({ type: "record", id: r.xref!, before: null, after: cloneRaw(r) }));
    }
    return [];
  }

  function dismissExtraEvent(keyBase: string) {
    if (!decisions || !person || !onUpdateDecision) return;
    for (const [key, dec] of decisions) {
      const parts = key.split(":");
      if (parts.length !== 3 || parts[0] !== "individual" || parts[1] !== person.id) continue;
      if (dec.status !== "confirmed") continue;
      const updatedFields = { ...dec.fields };
      for (const fkey of Object.keys(updatedFields)) {
        if (fkey.startsWith(`${keyBase}.`)) updatedFields[fkey] = "main";
      }
      // Also set any fields not yet explicitly decided (they default to "incoming") to "main".
      const EVENT_SUBS = ["date", "place", "addr", "value", "note", "agency", "type", "cause"] as const;
      for (const sub of EVENT_SUBS) {
        const fkey = `${keyBase}.${sub}`;
        if (mergeHighlight?.has(fkey)) updatedFields[fkey] = "main";
      }
      if (mergeIncomingSources?.has(`${keyBase}.sources`)) updatedFields[`${keyBase}.sources`] = "main";
      onUpdateDecision(key, { ...dec, fields: updatedFields });
      break;
    }
  }

  /**
   * Mark specific event sub-fields (e.g. "date", "value") as resolved to
   * "main" once they've been directly edited/committed in Edit mode. Without
   * this, `mergeHighlight` keeps treating the field as a still-pending incoming
   * suggestion — on the next render its input would be re-initialized from the
   * original incoming text, silently reverting the user's own edit and losing
   * the dirty/bold indicator for it.
   *
   * `keyBase` is the *volatile* merge key (e.g. "RESI.1") used to look up the
   * incoming value and to record the decision's per-field choice. `forcedId` is
   * a *stable* per-event identity (the raw event node's `nodeId`) used to
   * persist the dirty/bold marker in `resolvedSessionFields` — these must be
   * kept separate because `keyBase` is reassigned to a different event whenever
   * same-tag events or their pairing reshuffle (notably when an incoming-only
   * "extra" row is materialized into a real main event), which would
   * otherwise force the bold marker onto the wrong row.
   */
  function resolveMergeFields(keyBase: string, forcedId: string, subs: string[]) {
    if (!subs.length) return;
    // Only sub-fields that actually carry an incoming value become bold.
    const incomingSubs = subs.filter((sub) => mergeHighlight.has(`${keyBase}.${sub}`));
    if (incomingSubs.length) {
      setResolvedSessionFields((prev) => {
        const next = new Set(prev);
        for (const sub of incomingSubs) next.add(`${forcedId}.${sub}`);
        return next;
      });
    }
    if (!decisions || !person || !onUpdateDecision) return;
    for (const [key, dec] of decisions) {
      const parts = key.split(":");
      if (parts.length !== 3 || parts[0] !== "individual" || parts[1] !== person.id) continue;
      if (dec.status !== "confirmed") continue;
      const updatedFields = { ...dec.fields };
      let changed = false;
      for (const sub of incomingSubs) {
        const fkey = `${keyBase}.${sub}`;
        if (updatedFields[fkey] !== "main") {
          updatedFields[fkey] = "main";
          changed = true;
        }
      }
      if (changed) onUpdateDecision(key, { ...dec, fields: updatedFields });
      break;
    }
  }

  /**
   * Flag a family event slot's type as session-dirty right after a
   * type-change commit moves an event into it. Unlike individual event rows
   * (kept mounted across a retag, so their own "is this dirty" tracking
   * survives), family rows are re-keyed by node identity on retag (see the
   * `FamilyEventRow` call sites) so stale field state can't linger — but that
   * remount also means the freshly-mounted row's own dirty tracking can't
   * tell a synthetic vs. genuine match, so it's tracked here instead, reusing
   * `resolvedSessionFields`'s existing per-person reset.
   */
  function markFamilyTagRetagged(keyBase: string, newTag: string) {
    const key = `${keyBase}.${newTag}.tag`;
    setResolvedSessionFields((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
  }

  const { folderName, canReferenceFiles, resolveDroppedHandle, openFolder } = useMediaFolder();
  const { openPerson } = usePhotoViewer();
  const [photoPickerOpen, setPhotoPickerOpen] = useState(false);
  // Follow the main's photo house-style (inline OBJE/FILE vs. shared top-level
  // OBJE + pointer); ties / no photos fall back to shared.
  const mediaMode = useMemo(() => detectMediaMode(dataset.records), [dataset.records]);
  const [photoDragOver, setPhotoDragOver] = useState(false);

  const commit: Commit = (mutate, extraPatches) => {
    if (!person) return;
    const before = cloneRaw(person.raw);
    mutate(person);
    const after = cloneRaw(person.raw);
    if (JSON.stringify(before) === JSON.stringify(after) && !extraPatches?.length) return;
    rebuildIndividual(dataset, person);
    onPushEdit([{ type: "individual", id: person.id, before, after }, ...(extraPatches ?? [])], selectedId);
    onDirty("individual", person.id);
    setTick((v) => v + 1);
  };

  const commitFamily: FamilyCommit = (fam, mutate, extraPatches) => {
    const before = cloneRaw(fam.raw);
    mutate(fam);
    const after = cloneRaw(fam.raw);
    if (JSON.stringify(before) === JSON.stringify(after) && !extraPatches?.length) return;
    rebuildFamily(dataset, fam);
    onPushEdit([{ type: "family", id: fam.id, before, after }, ...(extraPatches ?? [])], selectedId);
    onDirty("family", fam.id);
    setTick((v) => v + 1);
  };

  // ── Photos (OBJE) ──────────────────────────────────────────────────────────

  /** Pop a benign (non-destructive) acknowledgement dialog. */
  function infoDialog(message: string) {
    setPendingConfirm({ message, confirmLabel: t("confirm.ok"), danger: false, action: () => {} });
  }

  /** Attach a photo by folder-relative path, following the main's media mode:
   *  an inline OBJE/FILE block, or a pointer to a shared top-level OBJE. In
   *  shared mode an `existingXref` (or a record with the same file) is reused,
   *  else a new top-level OBJE is created and captured as a record patch. */
  function addPhotoToPerson(file: string, existingXref?: string) {
    if (!person) return;
    if (mediaMode === "inline") {
      commit((indi) => { attachInlineMedia(indi, file); });
      return;
    }
    const extraPatches: RecordPatch[] = [];
    let objeXref = existingXref ?? findSharedMediaByFile(dataset.records, file)?.xref;
    if (!objeXref) {
      const rec = createMediaRecord(dataset.records, file);
      objeXref = rec.xref!;
      extraPatches.push({ type: "record", id: rec.xref!, before: null, after: cloneRaw(rec) });
    }
    commit((indi) => attachMediaPointer(indi, objeXref!), extraPatches);
  }

  /** Edit a photo's metadata (title/date/place/description). An inline OBJE is
   *  edited on the person record (normal commit); a shared top-level OBJE is
   *  edited in place and captured as a `record` patch for undo, with the person
   *  marked dirty so the change surfaces in the save preview. */
  function editPersonMedia(objeIndex: number, fields: PhotoEditFields) {
    if (!person) return;
    const objeChild = childrenByTag(person.raw, "OBJE")[objeIndex];
    if (!objeChild) return;
    const ptr = objeChild.value?.trim();
    const sharedXref = ptr && isPointer(ptr) ? ptr : undefined;
    if (sharedXref) {
      const rec = dataset.records.find((r) => r.tag === "OBJE" && r.xref === sharedXref);
      if (!rec) return;
      const before = cloneRaw(rec);
      setMediaInfo(rec, fields);
      const after = cloneRaw(rec);
      if (JSON.stringify(before) === JSON.stringify(after)) return;
      bumpSourceCacheVersion(dataset.records);
      rebuildIndividual(dataset, person);
      onPushEdit([{ type: "record", id: sharedXref, before, after }], selectedId);
      onDirty("individual", person.id);
      setTick((v) => v + 1);
    } else {
      commit((indi) => {
        const child = childrenByTag(indi.raw, "OBJE")[objeIndex];
        if (child) setMediaInfo(child, fields);
      });
    }
  }

  /** Referenced-by + edit context handed to the photo viewer/tray in Edit mode. */
  const photoRefCtx = { dataset, onNavigate: navigate, onEditMedia: editPersonMedia };

  /** After adding a single photo, open it in the viewer so its metadata can be
   *  filled in straight away. */
  function openLastPhoto() {
    if (person) openPerson(person.raw, dataset.records, Number.MAX_SAFE_INTEGER, photoRefCtx, true);
  }

  /** The "Add photo" entry point: ensure a media folder is chosen, then open
   *  the picker (which lists the folder's images — works in every browser that
   *  can load a folder). Dragging files in from outside is the Chrome/Edge-only
   *  path handled separately. */
  function handleAddPhoto() {
    if (!folderName) {
      setPendingConfirm({
        message: t("photo.selectFolderPrompt"),
        confirmLabel: t("photo.chooseFolder"),
        danger: false,
        action: () => { void openFolder(); },
      });
      return;
    }
    setPhotoPickerOpen(true);
  }

  /** Remove the person's `objeIndex`th photo. Mirrors `commitRemoveSource`:
   *  snapshots the shared OBJE first so undo can restore it if the delete
   *  pruned it as now-unreferenced. */
  function deletePhoto(objeIndex: number) {
    if (!person) return;
    const objeChild = childrenByTag(person.raw, "OBJE")[objeIndex];
    const ptr = objeChild?.value?.trim();
    const sharedXref = ptr && isPointer(ptr) ? ptr : undefined;
    const sharedNode = sharedXref ? dataset.records.find((r) => r.tag === "OBJE" && r.xref === sharedXref) : undefined;
    const sharedBefore = sharedNode ? cloneRaw(sharedNode) : undefined;

    const before = cloneRaw(person.raw);
    removeIndividualMediaAtIndex(dataset, person, objeIndex);
    const after = cloneRaw(person.raw);

    const extraPatches: RecordPatch[] = [];
    if (sharedXref && sharedBefore && !dataset.records.some((r) => r.xref === sharedXref)) {
      extraPatches.push({ type: "record", id: sharedXref, before: sharedBefore, after: null });
    }
    rebuildIndividual(dataset, person);
    onPushEdit([{ type: "individual", id: person.id, before, after }, ...extraPatches], selectedId);
    onDirty("individual", person.id);
    setTick((v) => v + 1);
  }

  function handleDeletePhoto(objeIndex: number) {
    setPendingConfirm({
      message: t("photo.deleteConfirm"),
      confirmLabel: t("confirm.delete"),
      action: () => deletePhoto(objeIndex),
    });
  }

  /** Reference dropped image files that live inside the chosen media folder.
   *  DataTransferItems are invalidated after the first `await`, so every
   *  handle is requested synchronously up front, then resolved. */
  function handlePhotoDrop(e: React.DragEvent) {
    if (!e.dataTransfer.types.includes("Files")) return; // internal reorder drag
    e.preventDefault();
    setPhotoDragOver(false);
    const handlePromises: Promise<FileSystemHandle | null>[] = [];
    let fileCount = 0;
    for (const item of Array.from(e.dataTransfer.items)) {
      if (item.kind !== "file") continue;
      fileCount++;
      const get = (item as unknown as { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> }).getAsFileSystemHandle;
      if (get) handlePromises.push(get.call(item));
    }
    if (fileCount === 0) return;
    void resolveDroppedPhotos(handlePromises, fileCount);
  }

  async function resolveDroppedPhotos(handlePromises: Promise<FileSystemHandle | null>[], fileCount: number) {
    if (!folderName) { infoDialog(t("photo.selectFolderPrompt")); return; }
    if (!canReferenceFiles || handlePromises.length < fileCount) { infoDialog(t("photo.importUnsupported")); return; }
    let anyOutside = false;
    let added = 0;
    for (const promise of handlePromises) {
      const handle = await promise;
      if (!handle || handle.kind !== "file" || !IMAGE_NAME_RE.test(handle.name)) continue;
      const rel = await resolveDroppedHandle(handle);
      if (rel) { addPhotoToPerson(rel); added++; }
      else anyOutside = true;
    }
    if (added === 1) openLastPhoto();
    if (anyOutside) infoDialog(t("photo.outsideFolder"));
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
  function resolveSourceFields(fields: AddSourceResult): { sourceXref: string; page?: string; extraPatches: RecordPatch[] } {
    const extraPatches: RecordPatch[] = [];
    if (fields.url) {
      const match = findExistingSource(dataset.records, fields.url);
      if (match) {
        if (!match.objeXref) {
          const sourceNode = dataset.records.find((r) => r.tag === "SOUR" && r.xref === match.sourceXref)!;
          const before = cloneRaw(sourceNode);
          const obje = addObjeToSource(dataset.records, match.sourceXref, fields.url);
          extraPatches.push({ type: "record", id: match.sourceXref, before, after: cloneRaw(sourceNode) });
          extraPatches.push({ type: "record", id: obje.xref!, before: null, after: cloneRaw(obje) });
        }
        return { sourceXref: match.sourceXref, page: fields.page ?? match.page, extraPatches };
      }
    }
    const sourceNode = createSourceRecord(dataset.records, fields as NewSourceFields);
    extraPatches.push({ type: "record", id: sourceNode.xref!, before: null, after: cloneRaw(sourceNode) });
    const objeChild = firstChild(sourceNode, "OBJE");
    if (objeChild?.value) {
      const objeNode = dataset.records.find((r) => r.tag === "OBJE" && r.xref === objeChild.value);
      if (objeNode) extraPatches.push({ type: "record", id: objeNode.xref!, before: null, after: cloneRaw(objeNode) });
    }
    return { sourceXref: sourceNode.xref!, page: fields.page, extraPatches };
  }

  function handleAddSource(fields: AddSourceResult) {
    if (!sourceDialogTarget || sourceDialogTarget.kind === "edit" || sourceDialogTarget.kind === "edit-link" || !person) return;
    const { sourceXref, page, extraPatches } = resolveSourceFields(fields);
    if (sourceDialogTarget.kind === "individual") {
      commit((indi) => attachSourceCitation(indi.raw, sourceXref, page, INDI_CHILD_ORDER), extraPatches);
    } else if (sourceDialogTarget.kind === "family") {
      commitFamily(sourceDialogTarget.fam, (f) => attachSourceCitation(f.raw, sourceXref, page, FAM_CHILD_ORDER), extraPatches);
    } else {
      sourceDialogTarget.commitField({ addSource: { sourceXref, page } }, extraPatches);
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
  const openEditSource: OpenEditSource = (node, index, owner) => {
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
        filingNumber: childText(sourceNode, "FILN"),
        note: childText(sourceNode, "NOTE"),
        url: resolved?.url,
        objeXref: resolved?.objeXref,
        page,
      },
    });
  };

  /** Commits an Edit Source dialog save: applies `updateSourceCitation`,
   * then diffs every top-level `SOUR`/`OBJE` record for undo-safe patches —
   * simpler than tracking exactly which ones a shared-record edit touched. */
  function commitEditSource(node: GedNode, index: number, owner: RemoveSourceOwner, fields: EditSourceFields) {
    const isSourceOrObje = (r: GedNode) => r.tag === "SOUR" || r.tag === "OBJE";
    const before = new Map(dataset.records.filter((r) => isSourceOrObje(r) && r.xref).map((r) => [r.xref!, cloneRaw(r)]));

    const ownerRaw = owner.kind === "individual" ? owner.indi.raw : owner.fam.raw;
    const ownerBefore = cloneRaw(ownerRaw);
    updateSourceCitation(dataset.records, node, index, fields);
    const ownerAfter = cloneRaw(ownerRaw);

    const after = new Map(dataset.records.filter((r) => isSourceOrObje(r) && r.xref).map((r) => [r.xref!, r]));
    const extraPatches: RecordPatch[] = [];
    for (const xref of new Set([...before.keys(), ...after.keys()])) {
      const b = before.get(xref) ?? null;
      const a = after.get(xref);
      const aClone = a ? cloneRaw(a) : null;
      if (JSON.stringify(b) !== JSON.stringify(aClone)) extraPatches.push({ type: "record", id: xref, before: b, after: aClone });
    }

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
            saved.title || saved.author || saved.periodical || saved.publisher || saved.agency || saved.filingNumber || saved.note,
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

  function addRelative(kind: "father" | "mother" | "partner" | "child", fam?: Family) {
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

    onDirty("individual", person.id);
    onDirty("individual", added.id);
    focusNextName.current = true;
    navigate(added.id);
  }

  function connectRelative(kind: "father" | "mother" | "partner" | "child", existingId: string, fam?: Family) {
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
    onDirty("individual", person.id);
    onDirty("individual", existingId);
    if (fam) onDirty("family", fam.id);
    setPickingSlot(null);
    setTick((v) => v + 1);
  }

  function personName(id: string | undefined): string {
    if (!id) return "";
    const indi = dataset.individuals.get(id);
    return indi ? formatName(indi) : id;
  }

  // Member ids of a family, for snapshotting before a detach/delete — pruning a
  // family that drops below two members also unlinks its sole surviving member.
  function familyMemberIds(fam: Family): string[] {
    return [fam.husband, fam.wife, ...fam.children].filter(Boolean) as string[];
  }

  function handleDetachSpouseRole(fam: Family, role: "HUSB" | "WIFE", confirmMsg: string) {
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
        setTick((v) => v + 1);
      },
    });
  }

  function handleDetachChild(fam: Family, childId: string, confirmMsg: string) {
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
        setTick((v) => v + 1);
      },
    });
  }

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
  const { placeSuggestions, placeToAddrs, placeCanonical, addrCanonical } = useMemo(
    () => buildPlaceSuggestions(dataset),
    [dataset],
  );
  const decisionStatusById = useMemo(() => decisionStatusByMainId(decisions), [decisions]);

  if (!person) {
    return (
      <div className="section open edit-view">
        <div className="section-body">
          <p className="gm-file main gm-data" title={`${t("tree.main")}: ${fileName}`}>{fileName}</p>
          <p className="muted">{t("edit.empty")}</p>
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

  const lifespan = lifespanOf(person);
  const startInfo = settings.showKinship && startId ? kinshipInfo(dataset, startId, selectedId!, t) : undefined;
  const startPersonName = startId
    ? formatName(dataset.individuals.get(startId)!)
    : undefined;
  const kinship = startInfo?.label;
  const kinshipLineage = lineageClass(startInfo?.lineage);
  const kinshipTooltip = startInfo && startPersonName
    ? kinshipTooltipText(startInfo, startPersonName, t)
    : undefined;

  function cardKinship(id: string | undefined): { kinship?: string; kinshipTooltip?: string; kinshipLineage?: string } {
    if (!settings.showKinship || !startId || !id) return {};
    const info = kinshipInfo(dataset, startId, id, t);
    if (!info) return {};
    return {
      kinship: info.label,
      kinshipLineage: lineageClass(info.lineage),
      kinshipTooltip: startPersonName ? kinshipTooltipText(info, startPersonName, t) : undefined,
    };
  }

  // Status chips for a relative card: its merge decision (C/D/R) and/or an "M"
  // chip when its main record has unsaved edits — mirroring the tree nodes.
  function cardDecision(id: string | undefined): { decisionStatus?: Exclude<MatchDecisionStatus, "undecided">; decisionLetter?: string; decisionTooltip?: string; modified?: boolean; modifiedLetter?: string; modifiedTooltip?: string } {
    const modified = !!id && changedPersonIds.has(id);
    const modifiedProps = modified ? { modified, modifiedLetter: t("edit.tree.modified").charAt(0), modifiedTooltip: t("edit.tree.modified") } : {};
    const status = id ? decisionStatusById.get(id) : undefined;
    if (!status) return modifiedProps;
    const tooltip = t(`status.${status}`);
    return { decisionStatus: status, decisionLetter: tooltip.charAt(0), decisionTooltip: tooltip, ...modifiedProps };
  }

  return (
    <div className="section open edit-view">
      <div className="section-body" ref={editBodyRef}>
        <div className="edit-parents">
          {(parentFamilies.length ? parentFamilies : [undefined]).map((fam, i) => {
            const fatherName = personName(fam?.husband);
            const motherName = personName(fam?.wife);
            const fatherPickerOpen = pickingSlot?.kind === "father" && pickingSlot.fam === fam;
            const motherPickerOpen = pickingSlot?.kind === "mother" && pickingSlot.fam === fam;
            return (
              <div className="edit-parent-group" key={fam?.id ?? `empty-${i}`}>
                {fatherPickerOpen && !fam?.husband ? (
                  <RelativePickerCard
                    roleLabel={t("field.father")}
                    individuals={dataset.individuals}
                    excludeId={person.id}
                    onPickExisting={(id) => connectRelative("father", id, fam)}
                    onAddNew={() => { setPickingSlot(null); addRelative("father", fam); }}
                    onCancel={() => setPickingSlot(null)}
                    t={t}
                  />
                ) : (
                  <PersonCard
                    individual={fam?.husband ? dataset.individuals.get(fam.husband) : undefined}
                    roleLabel={t("field.father")}
                    placeholder={t("edit.addFather")}
                    onSelect={navigate}
                    onAdd={() => setPickingSlot({ kind: "father", fam })}
                    onRemove={fam?.husband ? () => handleDetachSpouseRole(fam, "HUSB", t("edit.detachRoleConfirm", { name: fatherName, role: t("field.father") })) : undefined}
                    removeTooltip={fam?.husband ? t("edit.detachRoleTooltip", { name: fatherName, role: t("field.father") }) : undefined}
                    {...cardKinship(fam?.husband)}
                    {...cardDecision(fam?.husband)}
                    records={dataset.records}
                    refCtx={{ dataset, onNavigate: navigate }}
                  />
                )}
                <div className="edit-connector-h" />
                {motherPickerOpen && !fam?.wife ? (
                  <RelativePickerCard
                    roleLabel={t("field.mother")}
                    individuals={dataset.individuals}
                    excludeId={person.id}
                    onPickExisting={(id) => connectRelative("mother", id, fam)}
                    onAddNew={() => { setPickingSlot(null); addRelative("mother", fam); }}
                    onCancel={() => setPickingSlot(null)}
                    t={t}
                  />
                ) : (
                  <PersonCard
                    individual={fam?.wife ? dataset.individuals.get(fam.wife) : undefined}
                    roleLabel={t("field.mother")}
                    placeholder={t("edit.addMother")}
                    onSelect={navigate}
                    onAdd={() => setPickingSlot({ kind: "mother", fam })}
                    onRemove={fam?.wife ? () => handleDetachSpouseRole(fam, "WIFE", t("edit.detachRoleConfirm", { name: motherName, role: t("field.mother") })) : undefined}
                    removeTooltip={fam?.wife ? t("edit.detachRoleTooltip", { name: motherName, role: t("field.mother") }) : undefined}
                    {...cardKinship(fam?.wife)}
                    {...cardDecision(fam?.wife)}
                    records={dataset.records}
                    refCtx={{ dataset, onNavigate: navigate }}
                  />
                )}
                {(() => {
                  // Read-only glimpse of the parents' couple events (marriage,
                  // divorce, …) — editable on either parent's own page.
                  const couple = fam?.events.filter(
                    (ev) => (ev.tag === "MARR" || FAMILY_HIDDEN_EVENT_TAGS.includes(ev.tag)) && (ev.date || ev.place),
                  ) ?? [];
                  if (!couple.length) return null;
                  return (
                    <div className="edit-parent-fam-events">
                      {couple.map((ev, j) => (
                        <span
                          key={`${ev.tag}-${j}`}
                          title={`${t(`event.${ev.tag}`)}: ${[ev.date?.raw, ev.place?.raw].filter(Boolean).join(", ")}`}
                        >
                          {ev.tag === "MARR" ? MARRIAGE_SYMBOL : t(`event.${ev.tag}`)}{" "}
                          <span className="gm-data">
                            {[ev.date?.raw, ev.place ? ev.place.parts[0] || ev.place.raw : undefined].filter(Boolean).join(" · ")}
                          </span>
                        </span>
                      ))}
                    </div>
                  );
                })()}
              </div>
            );
          })}
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
          className={`edit-person ${photoDragOver ? "photo-drop-active" : ""}`}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            setPhotoDragOver(true);
          }}
          onDragLeave={(e) => { if (e.currentTarget === e.target) setPhotoDragOver(false); }}
          onDrop={handlePhotoDrop}
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
          <PersonPhotos
            // person.raw is mutated in place, so remount on each edit/undo to
            // re-read the OBJE children (resolved files are blob-cached).
            key={`photos-${person.id}-${tick}-${undoVersion}`}
            raw={person.raw}
            records={dataset.records}
            refCtx={photoRefCtx}
            editable={{ onAdd: handleAddPhoto, onDelete: handleDeletePhoto, onReorder: (from, to) => commit((indi) => reorderIndividualMedia(indi, from, to)) }}
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
            showAddNote={!notesAdded && !(person.notes ?? []).length}
            onAddNote={() => setNotesAdded(true)}
            showAddPhoto={collectPhotoRefs(person.raw, dataset.records).length === 0}
            onAddPhoto={handleAddPhoto}
            marriedNameTag={marriedNameTag}
            leadingControl={<SexToggle key={`sex-${person.id}`} person={person} t={t} commit={commit} />}
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
          {((person.notes ?? []).length > 0 || notesAdded) && (
            <div className="edit-record-section">
              <NotesEditor
                key={`notes-${person.id}-${undoVersion}`}
                notes={person.notes ?? []}
                addOnMount={notesAdded && !(person.notes ?? []).length}
                sectionLabel={t("field.notes")}
                t={t}
                onCommit={(notes) => commit((indi) => setNotes(indi, notes))}
              />
            </div>
          )}
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
            mergeGen={mergeGenRef.current}
          />
        </div>

        <div className="edit-families">
          {(spouseFamilies.length ? spouseFamilies : [undefined]).map((fam, i) => {
            const partnerId = fam && (fam.husband === person.id ? fam.wife : fam.husband);
            const partnerRole = fam && (fam.husband === person.id ? "WIFE" : "HUSB");
            const partnerName = personName(partnerId ?? undefined);
            const famMergeKeyBase = fam ? familyKeyBaseById.get(fam.id) : undefined;
            const shownFamilyTags = FAMILY_HIDDEN_EVENT_TAGS.filter(
              (tag) => fam?.events.some((e) => e.tag === tag) || familyEventHasMergeData(famMergeKeyBase, tag, mergeHighlight, mergeIncomingSources),
            );
            const emptyFamilyTags = FAMILY_HIDDEN_EVENT_TAGS.filter(
              (tag) => !shownFamilyTags.includes(tag),
            );
            const partnerPickerOpen = pickingSlot?.kind === "partner" && pickingSlot.fam === fam;
            const childPickerOpen = pickingSlot?.kind === "child" && pickingSlot.fam === fam;
            return (
              <div className="edit-family" key={fam?.id ?? `empty-${i}`}>
                <div className="edit-family-header">
                  <div className="person-card-role">{t("field.partners")}</div>
                  <div className="edit-family-card-row">
                    {partnerPickerOpen && !partnerId ? (
                      <RelativePickerCard
                        individuals={dataset.individuals}
                        excludeId={person.id}
                        onPickExisting={(id) => connectRelative("partner", id, fam)}
                        onAddNew={() => { setPickingSlot(null); addRelative("partner", fam); }}
                        onCancel={() => setPickingSlot(null)}
                        t={t}
                      />
                    ) : (
                      <PersonCard
                        individual={partnerId ? dataset.individuals.get(partnerId) : undefined}
                        placeholder={t("edit.addPartner")}
                        onSelect={navigate}
                        onAdd={() => setPickingSlot({ kind: "partner", fam })}
                        onRemove={fam && partnerId && partnerRole ? () => handleDetachSpouseRole(fam, partnerRole, t("edit.detachPartnerConfirm", { name: partnerName })) : undefined}
                        removeTooltip={fam && partnerId ? t("edit.detachPartnerTooltip", { name: partnerName }) : undefined}
                        {...cardKinship(partnerId)}
                        {...cardDecision(partnerId)}
                        records={dataset.records}
                        refCtx={{ dataset, onNavigate: navigate }}
                      />
                    )}
                    {fam && (
                      <AddEventSelect
                        tags={emptyFamilyTags}
                        label={t("edit.addFamilyEvent")}
                        tooltip={t("edit.addFamilyEventTooltip")}
                        t={t}
                        onAdd={(tag) => { commitFamily(fam, (f) => addFamilyEventNode(f, tag)); setPendingFocusFamEventKey(`${fam.id}-${tag}`); }}
                      />
                    )}
                    {fam && (
                      <button
                        type="button"
                        className="edit-name-chip edit-name-chip-add"
                        title={t("edit.addNoteTooltip")}
                        onClick={() => setFamNoteAdd((prev) => ({ ...prev, [fam.id]: (prev[fam.id] ?? 0) + 1 }))}
                      >
                        + {t("edit.addNote")}
                      </button>
                    )}
                    {fam && !(fam.links ?? []).length && !(fam.sources ?? []).length && (
                      <button
                        type="button"
                        className="edit-name-chip edit-name-chip-add"
                        title={t("edit.addLink")}
                        onClick={() => setSourceDialogTarget({ kind: "family", fam })}
                      >
                        + {t("edit.addLink")}
                      </button>
                    )}
                  </div>
                </div>
                {fam && (() => {
                  const marrNode = firstChild(fam.raw, "MARR");
                  return (
                    <FamilyEventRow
                      key={`${fam.id}-MARR-${marrNode ? nodeId(marrNode) : "empty"}-${undoVersion}-${mergeGenRef.current}`}
                      fam={fam}
                      tag="MARR"
                      t={t}
                      commit={commitFamily}
                      openEditSource={openEditSource}
                      onOpenSourceDialog={setSourceDialogTarget}
                      onRemove={marrNode ? () => commitFamily(fam, (f) => removeFamilyEvent(f, "MARR")) : undefined}
                      onRetag={(newTag) => markFamilyTagRetagged(famMergeKeyBase ?? `fam.${fam.id}`, newTag)}
                      placeSuggestions={placeSuggestions}
                      placeToAddrs={placeToAddrs}
                      placeCanonical={placeCanonical}
                      addrCanonical={addrCanonical}
                      mergeHighlight={mergeHighlight}
                      mergeIncomingSources={mergeIncomingSources}
                      famMergeKeyBase={famMergeKeyBase}
                      resolvedSessionFields={resolvedSessionFields}
                    />
                  );
                })()}
                {fam && shownFamilyTags.map((tag) => {
                  const eventNode = firstChild(fam.raw, tag);
                  const hasRealEvent = eventNode !== undefined;
                  return (
                    <FamilyEventRow
                      // Re-keyed on the underlying node's identity (not just `undoVersion`)
                      // so that retagging this event away (via the type-change dropdown)
                      // unmounts this row instead of leaving its local field state (date,
                      // place, …) stale once `ev` silently becomes undefined underneath it.
                      key={`${fam.id}-${tag}-${eventNode ? nodeId(eventNode) : "empty"}-${undoVersion}-${mergeGenRef.current}`}
                      fam={fam}
                      tag={tag}
                      t={t}
                      commit={commitFamily}
                      openEditSource={openEditSource}
                      onOpenSourceDialog={setSourceDialogTarget}
                      autoFocusDate={pendingFocusFamEventKey === `${fam.id}-${tag}`}
                      onRemove={hasRealEvent ? () => commitFamily(fam, (f) => removeFamilyEvent(f, tag)) : () => dismissExtraEvent(`${famMergeKeyBase ?? `fam.${fam.id}`}.${tag}`)}
                      onRetag={(newTag) => markFamilyTagRetagged(famMergeKeyBase ?? `fam.${fam.id}`, newTag)}
                      placeSuggestions={placeSuggestions}
                      placeToAddrs={placeToAddrs}
                      placeCanonical={placeCanonical}
                      addrCanonical={addrCanonical}
                      mergeHighlight={mergeHighlight}
                      mergeIncomingSources={mergeIncomingSources}
                      famMergeKeyBase={famMergeKeyBase}
                      resolvedSessionFields={resolvedSessionFields}
                    />
                  );
                })}
                <div className="edit-children-wrap">
                  <div className="person-card-role">{t("field.children")}</div>
                  <div className="edit-children">
                    {fam?.children.map((childId) => {
                      const childName = personName(childId);
                      return (
                        <PersonCard
                          key={childId}
                          individual={dataset.individuals.get(childId)}
                          placeholder={t("edit.unknown")}
                          onSelect={navigate}
                          onRemove={() => handleDetachChild(fam, childId, t("edit.detachChildConfirm", { name: childName }))}
                          removeTooltip={t("edit.detachChildTooltip", { name: childName })}
                          {...cardKinship(childId)}
                          {...cardDecision(childId)}
                          records={dataset.records}
                          refCtx={{ dataset, onNavigate: navigate }}
                        />
                      );
                    })}
                    {childPickerOpen ? (
                      <RelativePickerCard
                        individuals={dataset.individuals}
                        excludeId={person.id}
                        onPickExisting={(id) => connectRelative("child", id, fam)}
                        onAddNew={() => { setPickingSlot(null); addRelative("child", fam); }}
                        onCancel={() => setPickingSlot(null)}
                        t={t}
                      />
                    ) : (
                      <PersonCard placeholder={t("edit.addChild")} onAdd={() => setPickingSlot({ kind: "child", fam })} />
                    )}
                  </div>
                </div>
                {fam && ((fam.links ?? []).length > 0 || (fam.sources ?? []).length > 0) && (
                  <div className="edit-record-section">
                    <LinksEditor
                      key={`flinks-${fam.id}-${undoVersion}`}
                      links={fam.links ?? []}
                      sources={fam.sources ?? []}
                      sectionLabel={t("field.sources")}
                      t={t}
                      onCommit={(links) => commitFamily(fam, (f) => setFamilyLinks(f, links))}
                      onAddSource={() => setSourceDialogTarget({ kind: "family", fam })}
                      onEditSource={(idx) => openEditSource(fam.raw, idx, { kind: "family", fam })}
                      onOpenSourceDialog={setSourceDialogTarget}
                      onAttachSource={(sourceXref, page, extraPatches, links) =>
                        commitFamily(fam, (f) => { attachSourceCitation(f.raw, sourceXref, page, FAM_CHILD_ORDER); setFamilyLinks(f, links); }, extraPatches)
                      }
                    />
                  </div>
                )}
                {fam && (
                  <div className="edit-record-section">
                    <NotesEditor
                      key={`fnotes-${fam.id}-${undoVersion}`}
                      notes={fam.notes ?? []}
                      addTrigger={famNoteAdd[fam.id]}
                      t={t}
                      onCommit={(notes) => commitFamily(fam, (f) => setFamilyNotes(f, notes))}
                    />
                  </div>
                )}
              </div>
            );
          })}
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
      <AddPhotoDialog
        isOpen={photoPickerOpen}
        onClose={() => setPhotoPickerOpen(false)}
        onAdd={(photos) => {
          for (const p of photos) addPhotoToPerson(p.path, p.existingXref);
          if (photos.length === 1) openLastPhoto();
        }}
        dataset={dataset}
        t={t}
      />
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
  );
}
