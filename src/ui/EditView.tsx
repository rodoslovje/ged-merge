import React, { forwardRef, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type RecordPatch, type PendingEditApply, cloneRaw } from "./historyTypes";
import { useTranslation } from "react-i18next";
import type { Dataset, Family, GedEvent, GedNode, Individual, Sex, SourceCitation } from "../gedcom/types";
import type { Translate } from "../locales/i18n";
import { datesTooltipOf, lifespanOf } from "../gedcom/lifespan";
import { ADDITIONAL_NAME_TYPES, defaultHomeId, displayName, lifespanLabel, nameTypeLabel, primaryName } from "../match/relatives";
import { kinshipLabel } from "../match/kinship";
import { INDI_EVENT_TAGS } from "../gedcom/builder";
import { clampBeforeDeathZone, dateToSortKey, familyMergeKeyBases, individualFieldRows, minDeathZoneKey, orderedEventTags } from "../review/fields";
import { materializeEventSources } from "../merge/merge";
import { decisionKey, decisionStatusByMasterId, defaultChoice, type CandidateDecision, type MatchDecisionStatus } from "../review/types";
import {
  addAdditionalName,
  addChild,
  addEventField,
  addEventNode,
  addFamilyEventNode,
  addObjeToSource,
  addParent,
  addPartner,
  attachSourceCitation,
  bumpSourceCacheVersion,
  changeEventTagAtIndex,
  changeFamilyEventTag,
  connectExistingChild,
  connectExistingParent,
  connectExistingPartner,
  createSourceRecord,
  detachChildFromFamily,
  detachSpouseRole,
  getMediaAndSourceCtx,
  INDI_CHILD_ORDER,
  insertRecord,
  rebuildFamily,
  rebuildIndividual,
  removeAdditionalName,
  removeEventAtIndex,
  removeFamilyEvent,
  removeIndividual,
  removeSourceCitationAtIndex,
  setAdditionalName,
  setEventField,
  setEventFieldAtIndex,
  setFamilyEventField,

  setFamilyNotes,
  setIndividualLinks,
  setName,
  setNickname,
  setNotes,
  setSex,
  updateSourceCitation,
  type EditSourceFields,
  type EventFieldUpdate,
  type NewSourceFields,
} from "../gedcom/edit";
import { childText, findExistingSource, resolveSourceCitation } from "../gedcom/source";
import { sexClass } from "./sex";
import { HomePersonSelector } from "./HomePersonSelector";
import { PersonCard } from "./PersonCard";
import { SourceRefs } from "./SourceRef";
import { AddSourceDialog, type AddSourceResult } from "./AddSourceDialog";
import { linkHref } from "./FieldValue";
import { linkKey } from "../normalize/links";

// Assign a monotonically increasing integer to each GedNode object so React
// keys remain stable across insertions and removals of sibling events.
const _nodeIds = new WeakMap<object, number>();
let _nextNodeId = 0;
function nodeId(node: object): number {
  if (!_nodeIds.has(node)) _nodeIds.set(node, _nextNodeId++);
  return _nodeIds.get(node)!;
}


interface Props {
  dataset: Dataset;
  fileName: string;
  /** Seeds the initial selection (the Merge-mode home person, if set). */
  homeId?: string;
  /** Called to change (or clear) the home person. */
  changeHome: (id: string | undefined) => void;
  /** Called whenever the dataset is mutated so the parent can track which records changed. */
  onDirty: (type: "individual" | "family", id: string) => void;
  /** Open the edit tree rooted on the currently selected person. */
  onShowTree: (id: string) => void;
  /** Navigate to this person when it changes (used by the save dialog person links). */
  navigateToId?: string;
  /** Called whenever the currently-shown person changes, so the parent can
   * jump Merge to that same person's match candidate when switching modes
   * (tab click or the "m" shortcut), instead of leaving Merge on whatever it
   * had selected before. */
  onPersonChange?: (id: string) => void;
  /** Returns the compare id of the given person's best (highest-ranked) match
   * candidate, if any — lets the name row show Confirm/Reject/Defer buttons
   * for that pair without switching to Merge mode. */
  matchCompareIdFor?: (id: string) => string | undefined;
  /** Master ids in the same (filtered) order as Merge's own Left/Right/Prev/Next —
   * lets Edit's Left/Right step through that same match list. `undefined` when
   * there's no incoming file loaded, in which case Left/Right do nothing. */
  matchOrder?: string[];
  /** Merge decisions — used to preview incoming values for confirmed matches. */
  decisions?: Map<string, CandidateDecision>;
  /** The incoming dataset — needed to resolve confirmed match incoming values. */
  compareDataset?: Dataset;
  /** Called when an extra merge event is dismissed — sets its fields to "master" in the decision.
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

/** Event tags that carry a direct text value on the tag line (e.g. `1 OCCU Farmer`). */
const VALUE_EVENT_TAGS = new Set(["OCCU", "EDUC", "RETI"]);

/** Groups for the "Add event" dropdown — BIRT is always shown so it's excluded. */
const INDIVIDUAL_EVENT_GROUPS = [
  { labelKey: "eventGroup.earlyLife", tags: ["BAPM", "CHR", "CONF", "ADOP", "FCOM"] },
  { labelKey: "eventGroup.career",    tags: ["OCCU", "EDUC", "RETI"] },
  { labelKey: "eventGroup.residence", tags: ["RESI", "EMIG", "IMMI", "NATU", "CENS"] },
  { labelKey: "eventGroup.estate",    tags: ["WILL", "PROB"] },
  { labelKey: "eventGroup.death",     tags: ["DEAT", "BURI", "CREM"] },
] as const;

/** Tags a master individual event's type can be changed to/from (matches
 * `INDIVIDUAL_EVENT_GROUPS`) — BIRT and the freeform `EVEN` tag are excluded. */
const ASSIGNABLE_EVENT_TAGS: Set<string> = new Set(INDIVIDUAL_EVENT_GROUPS.flatMap((g) => g.tags));

/** Family events that are hidden until explicitly added (marriage is always shown). */
const FAMILY_HIDDEN_EVENT_TAGS = ["ENGA", "SEPA", "DIV"];

/** Family event tags the type-change dropdown can switch between. */
const FAMILY_EVENT_TAGS = ["MARR", "ENGA", "SEPA", "DIV"];

/** Tags `tag`'s type-change dropdown may switch to: every `FAMILY_EVENT_TAGS`
 * tag not already used by a different event on `fam` (switching into one
 * already in use would silently shadow it, since each family event tag maps
 * to exactly one row), plus `tag` itself. */
function familyTagChoices(fam: Family, tag: string): string[] {
  return FAMILY_EVENT_TAGS.filter((tg) => tg === tag || !fam.events.some((e) => e.tag === tg));
}

/** Whether a confirmed merge has incoming data for a normally-hidden family
 * event (`<famMergeKeyBase>.<tag>.*`), so the row should show even though the
 * family doesn't have that event yet. */
function familyEventHasMergeData(
  famMergeKeyBase: string | undefined,
  tag: string,
  mergeHighlight: Map<string, string>,
  mergeIncomingSources: Map<string, SourceCitation[]>,
): boolean {
  if (!famMergeKeyBase) return false;
  const base = `${famMergeKeyBase}.${tag}`;
  const EVENT_SUBS = ["date", "place", "addr", "note", "agency"] as const;
  if (EVENT_SUBS.some((s) => mergeHighlight.has(`${base}.${s}`))) return true;
  return (mergeIncomingSources.get(`${base}.sources`)?.length ?? 0) > 0;
}

/** A mutation applied to the selected person's raw record, then rebuilt and
 * re-rendered. `extraPatches` carries undo/redo entries for any other
 * top-level record the mutation touched (e.g. a `SOUR`/`OBJE` created or
 * modified by "Add Source"). */
type Commit = (mutate: (indi: Individual) => void, extraPatches?: RecordPatch[]) => void;

/** A mutation applied to a family's raw record, then rebuilt and
 * re-rendered — see `Commit` for `extraPatches`. */
type FamilyCommit = (fam: Family, mutate: (fam: Family) => void, extraPatches?: RecordPatch[]) => void;

/** Where a confirmed "Add Source" citation should attach: the selected
 * person's own record, or a specific event (via its already-bound
 * `commitField`, so the dialog doesn't need to know which row it is). Or,
 * for "Edit Source", the existing citation being edited. Or, for a legacy
 * plain link (Links have been merged into Sources in the UI), its three
 * possible outcomes — built by whichever component owns that link's local
 * `links` array, since only it knows how to commit a plain rename/removal. */
type SourceDialogTarget =
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
type RemoveSourceOwner = { kind: "individual"; indi: Individual } | { kind: "family"; fam: Family };
/** Removes the `index`th `SOUR` citation from `node` and commits it (with
 * undo-safe patches for any pruned `SOUR`/`OBJE`) — see `commitRemoveSource`. */
type CommitRemoveSource = (node: GedNode, index: number, owner: RemoveSourceOwner) => void;
/** Opens the Edit Source dialog for the `index`th `SOUR` citation on `node` —
 * see `openEditSource`. Threaded down to event rows the same way
 * `CommitRemoveSource` used to be, now that removal lives inside that dialog. */
type OpenEditSource = (node: GedNode, index: number, owner: RemoveSourceOwner) => void;

interface PlaceSuggestions {
  placeSuggestions: string[];
  /** Canonical place key → sorted unique address strings seen at that place. */
  placeToAddrs: Map<string, string[]>;
  placeCanonical: Map<string, string>;
  addrCanonical: Map<string, string>;
}

function placeKey(raw: string): string {
  return raw.trim().split(",").map((p) => p.trim().toLowerCase()).join("|");
}

/** Collect all unique PLAC and ADDR values from a dataset and build canonical
 * maps (most-frequent casing wins) for normalize-on-blur. */
function buildPlaceSuggestions(dataset: Dataset): PlaceSuggestions {
  const placeForms = new Map<string, Map<string, number>>();
  const addrForms = new Map<string, Map<string, number>>();
  // placeKey → addrRaw → count
  const placeAddrForms = new Map<string, Map<string, number>>();

  function addValue(forms: Map<string, Map<string, number>>, raw: string) {
    const r = raw.trim();
    if (!r) return;
    const key = placeKey(r);
    const m = forms.get(key) ?? new Map<string, number>();
    m.set(r, (m.get(r) ?? 0) + 1);
    forms.set(key, m);
  }

  function addEventValues(placeRaw: string | undefined, addrRaw: string | undefined) {
    if (placeRaw) addValue(placeForms, placeRaw);
    if (addrRaw) addValue(addrForms, addrRaw);
    if (placeRaw && addrRaw) {
      const pk = placeKey(placeRaw);
      const ar = addrRaw.trim();
      if (ar) {
        const m = placeAddrForms.get(pk) ?? new Map<string, number>();
        m.set(ar, (m.get(ar) ?? 0) + 1);
        placeAddrForms.set(pk, m);
      }
    }
  }

  for (const indi of dataset.individuals.values()) {
    for (const ev of indi.events) addEventValues(ev.place?.raw, ev.address?.raw);
  }
  for (const fam of dataset.families.values()) {
    for (const ev of fam.events) addEventValues(ev.place?.raw, ev.address?.raw);
  }

  function build(forms: Map<string, Map<string, number>>): { suggestions: string[]; canonical: Map<string, string> } {
    const canonical = new Map<string, string>();
    const suggestions: string[] = [];
    for (const [key, m] of forms) {
      let best = "";
      let bestCount = 0;
      for (const [form, count] of m) {
        if (count > bestCount) { best = form; bestCount = count; }
      }
      canonical.set(key, best);
      suggestions.push(best);
    }
    suggestions.sort();
    return { suggestions, canonical };
  }

  const place = build(placeForms);
  const addr = build(addrForms);

  const placeToAddrs = new Map<string, string[]>();
  for (const [pk, m] of placeAddrForms) {
    placeToAddrs.set(pk, [...m.keys()].sort());
  }

  return {
    placeSuggestions: place.suggestions,
    placeToAddrs,
    placeCanonical: place.canonical,
    addrCanonical: addr.canonical,
  };
}

/** Width (in `ch`) that fits `value` (or, while empty, `placeholder`)
 * without the input growing/shrinking awkwardly as the user types — used to
 * keep name fields compact instead of stretching to fill the row. */
function fieldWidth(value: string, placeholder: string, minLen = 3): string {
  const len = value.length > 0 ? value.length : placeholder.length;
  return `${Math.max(len, minLen) + 3}ch`;
}

/** Edit mode's person view: parents on top, the selected person in the
 * center, partners + children on the bottom. The center panel is editable;
 * relatives navigate on click. */
export function EditView({ dataset, fileName, homeId, changeHome, onDirty, onShowTree, navigateToId, onPersonChange, matchCompareIdFor, matchOrder, decisions, compareDataset, onUpdateDecision, onPushEdit, onPatchApplied, pendingApply, onApplied, active }: Props) {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState<string | undefined>(
    () => homeId ?? defaultHomeId(dataset) ?? dataset.individuals.keys().next().value,
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
        else if (patch.type === "record") bumpSourceCacheVersion(dataset.records);
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

  // T shortcut, Left/Right record navigation, Up/Down scrolling, and C/R/D
  // decision shortcuts (mirroring Merge mode's). Kept as a ref-fed closure
  // (rather than effect deps) so the listener doesn't need to be torn down
  // and re-added on every render/edit.
  const statusShortcuts = Object.fromEntries(
    MATCH_STATUSES.map((s) => [t(`status.${s}`).charAt(0).toLowerCase(), s]),
  ) as Record<string, MatchDecisionStatus>;
  const shortcutRef = useRef({ selectedId, onShowTree, matchOrder, navigate, matchDecKey, toggleMatchStatus, statusShortcuts });
  shortcutRef.current = { selectedId, onShowTree, matchOrder, navigate, matchDecKey, toggleMatchStatus, statusShortcuts };
  // The scrollable person panel — Up/Down scroll this instead of navigating
  // when it actually has overflow to scroll.
  const editBodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active) return;
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const { selectedId: id, onShowTree: show, matchOrder: order, navigate: nav, matchDecKey: decKey, toggleMatchStatus: toggle, statusShortcuts: shortcuts } = shortcutRef.current;
      const key = e.key.toLowerCase();
      if (key === "t") {
        if (id) { e.preventDefault(); show(id); }
        return;
      }
      const statusHit = shortcuts[key];
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
    if (navigateToId) navigate(navigateToId);
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
      /** master person.events overall index → field key base aligned with orderedEventTags. */
      masterMergeKeyBases: new Map<number, string>(),
      /** master person.events overall index → the incoming event it's paired with, as
       * `${tag}:${compareIdx}` — see `CandidateDecision.rejectedEvents`. Lets deleting a
       * paired master event also reject its incoming counterpart, so it isn't silently
       * re-added on save. */
      masterMergeCompareKeys: new Map<number, string>(),
      /** master person.events overall index → sort key from incoming date, when master has no date. */
      masterMergeSortKeys: new Map<number, number>(),
      /** Incoming-only events with no master counterpart (BIRT excluded — always shown). */
      extraMergeEvents: [] as { tag: string; keyBase: string; sortKey: number; compareIdx: number }[],
      /** master family id → the `fam.<id>` key base used for that family's rows
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
        if (row.state === "agree" || row.state === "master-only") continue;
        const choice = dec.fields[row.key] ?? defaultChoice(row);
        if (choice === "master") continue;
        if (row.incoming) mergeHighlight.set(row.key, row.incoming);
        if (row.incomingLinks?.length) mergeIncomingLinks.set(row.key, row.incomingLinks);
        if (row.incomingSources?.length) mergeIncomingSources.set(row.key, row.incomingSources);
      }

      // Map master overall event index → the key base that orderedEventTags assigned to it.
      // This handles multi-instance keys (e.g. "RESI.0") that arise when incoming has more
      // events of the same tag, or when a same-tag pair scores too low to be merged.
      const mByTagIndices = new Map<string, number[]>();
      person.events.forEach((ev, i) => {
        const arr = mByTagIndices.get(ev.tag) ?? [];
        arr.push(i);
        mByTagIndices.set(ev.tag, arr);
      });
      const masterMergeKeyBases = new Map<number, string>();
      const masterMergeCompareKeys = new Map<number, string>();
      const masterMergeSortKeys = new Map<number, number>();
      const extraMergeEvents: { tag: string; keyBase: string; sortKey: number; compareIdx: number }[] = [];
      const EVENT_SUBS = ["date", "place", "addr", "value", "note", "agency"] as const;

      // Index incoming events by tag for sort key lookup.
      const cByTag = new Map<string, typeof incoming.events>();
      incoming.events.forEach((ev) => {
        const arr = cByTag.get(ev.tag) ?? [];
        arr.push(ev);
        cByTag.set(ev.tag, arr);
      });

      for (const inst of orderedEventTags(person, incoming)) {
        const keyBase = inst.multi ? `${inst.tag}.${inst.keyIdx}` : inst.tag;
        if (inst.masterIdx >= 0) {
          const overallIdx = mByTagIndices.get(inst.tag)?.[inst.masterIdx];
          if (overallIdx !== undefined) {
            masterMergeKeyBases.set(overallIdx, keyBase);
            if (inst.compareIdx >= 0 && !rejectedEvents?.has(`${inst.tag}:${inst.compareIdx}`)) {
              masterMergeCompareKeys.set(overallIdx, `${inst.tag}:${inst.compareIdx}`);
            }
            // When master has no date, use incoming date for sort so the row stays in
            // the right chronological position (e.g. after committing only a place).
            if (!person.events[overallIdx]?.date && inst.compareIdx >= 0) {
              const sk = dateToSortKey(cByTag.get(inst.tag)?.[inst.compareIdx]?.date);
              if (sk !== 0) masterMergeSortKeys.set(overallIdx, sk);
            }
          }
        } else if (inst.tag !== "BIRT") {
          // Incoming-only event — show only if there is merge data for it.
          // BIRT is always shown in its own row so exclude it from extras.
          if (EVENT_SUBS.some((s) => mergeHighlight.has(`${keyBase}.${s}`)) || mergeIncomingSources.has(`${keyBase}.sources`)) {
            const incomingEv = inst.compareIdx >= 0 ? cByTag.get(inst.tag)?.[inst.compareIdx] : undefined;
            if (incomingEv) {
              extraMergeEvents.push({ tag: inst.tag, keyBase, sortKey: dateToSortKey(incomingEv.date), compareIdx: inst.compareIdx });
            }
          }
        }
      }

      const familyKeyBases = familyMergeKeyBases(person, incoming, dataset, compareDataset);

      return { mergeHighlight, mergeIncomingLinks, mergeIncomingSources, masterMergeKeyBases, masterMergeCompareKeys, masterMergeSortKeys, extraMergeEvents, familyMergeKeyBases: familyKeyBases, hasMergeDecision: true };
    }
    return empty;
  }, [decisions, compareDataset, person, dataset, t, tick]);

  const { mergeHighlight, mergeIncomingLinks, mergeIncomingSources, masterMergeKeyBases, masterMergeCompareKeys, masterMergeSortKeys, extraMergeEvents, familyMergeKeyBases: familyKeyBaseById, hasMergeDecision } = mergeData;

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
   * deletes its paired master event, deletes/dismisses an unmatched "extra"
   * suggestion row, or edits an extra row's field (materializing a new master
   * event from it). Persists into the confirmed decision's `rejectedEvents`
   * (see `CandidateDecision`) so the event is treated as absent everywhere —
   * the live preview here and the merge engine on Save — for the rest of the
   * session, regardless of how master/incoming pairing reshuffles afterward.
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
   * — the master event a direct field edit just materialized for it. Must
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
      const incEvent = incoming.raw.children.filter((c) => c.tag === tag)[compareIdx];
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
        if (fkey.startsWith(`${keyBase}.`)) updatedFields[fkey] = "master";
      }
      // Also set any fields not yet explicitly decided (they default to "incoming") to "master".
      const EVENT_SUBS = ["date", "place", "addr", "value", "note", "agency"] as const;
      for (const sub of EVENT_SUBS) {
        const fkey = `${keyBase}.${sub}`;
        if (mergeHighlight?.has(fkey)) updatedFields[fkey] = "master";
      }
      if (mergeIncomingSources?.has(`${keyBase}.sources`)) updatedFields[`${keyBase}.sources`] = "master";
      onUpdateDecision(key, { ...dec, fields: updatedFields });
      break;
    }
  }

  /**
   * Mark specific event sub-fields (e.g. "date", "value") as resolved to
   * "master" once they've been directly edited/committed in Edit mode. Without
   * this, `mergeHighlight` keeps treating the field as a still-pending incoming
   * suggestion — on the next render its input would be re-initialized from the
   * original incoming text, silently reverting the user's own edit and losing
   * the dirty/bold indicator for it.
   */
  function resolveMergeFields(keyBase: string, subs: string[]) {
    if (!subs.length) return;
    const touched = subs.map((sub) => `${keyBase}.${sub}`).filter((fkey) => mergeHighlight.has(fkey));
    if (touched.length) {
      setResolvedSessionFields((prev) => {
        const next = new Set(prev);
        for (const fkey of touched) next.add(fkey);
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
      for (const fkey of touched) {
        if (updatedFields[fkey] !== "master") {
          updatedFields[fkey] = "master";
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
    const objeChild = sourceNode.children.find((c) => c.tag === "OBJE");
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
    const sourceXref = node.children.filter((c) => c.tag === "SOUR")[index]?.value?.trim();
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
    const citation = node.children.filter((c) => c.tag === "SOUR")[index];
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
    return indi ? (primaryName(indi)?.full ?? id) : id;
  }

  function handleDetachSpouseRole(fam: Family, role: "HUSB" | "WIFE", confirmMsg: string) {
    if (!window.confirm(confirmMsg)) return;
    const indiId = role === "HUSB" ? fam.husband : fam.wife;
    const beforeFam = cloneRaw(fam.raw);
    const indi = indiId ? dataset.individuals.get(indiId) : undefined;
    const beforeIndi = indi ? cloneRaw(indi.raw) : null;
    detachSpouseRole(dataset, fam, role);
    const patches: RecordPatch[] = [
      { type: "family", id: fam.id, before: beforeFam, after: cloneRaw(fam.raw) },
    ];
    if (indiId && beforeIndi) {
      const updated = dataset.individuals.get(indiId);
      patches.push({ type: "individual", id: indiId, before: beforeIndi, after: updated ? cloneRaw(updated.raw) : null });
    }
    onPushEdit(patches);
    onDirty("family", fam.id);
    if (indiId) onDirty("individual", indiId);
    setTick((v) => v + 1);
  }

  function handleDetachChild(fam: Family, childId: string, confirmMsg: string) {
    if (!window.confirm(confirmMsg)) return;
    const beforeFam = cloneRaw(fam.raw);
    const child = dataset.individuals.get(childId);
    const beforeChild = child ? cloneRaw(child.raw) : null;
    detachChildFromFamily(dataset, fam, childId);
    const patches: RecordPatch[] = [
      { type: "family", id: fam.id, before: beforeFam, after: cloneRaw(fam.raw) },
    ];
    if (beforeChild) {
      const updated = dataset.individuals.get(childId);
      patches.push({ type: "individual", id: childId, before: beforeChild, after: updated ? cloneRaw(updated.raw) : null });
    }
    onPushEdit(patches);
    onDirty("family", fam.id);
    onDirty("individual", childId);
    setTick((v) => v + 1);
  }

  function handleDeletePerson() {
    if (!person) return;
    const name = primaryName(person)?.full ?? person.id;
    if (!window.confirm(t("edit.deletePersonConfirm", { name }))) return;
    const personId = person.id;
    const affectedFamilyIds = [...person.spouseOf, ...person.childOf];

    const beforePerson = cloneRaw(person.raw);
    const familyBefores = new Map<string, import("../gedcom/types").GedNode>();
    for (const famId of affectedFamilyIds) {
      const fam = dataset.families.get(famId);
      if (fam) familyBefores.set(famId, cloneRaw(fam.raw));
    }

    removeIndividual(dataset, person);

    const patches: RecordPatch[] = [
      { type: "individual", id: personId, before: beforePerson, after: null },
    ];
    for (const [famId, before] of familyBefores) {
      const fam = dataset.families.get(famId);
      patches.push({ type: "family", id: famId, before, after: fam ? cloneRaw(fam.raw) : null });
    }

    const nextId =
      history.filter((id) => id !== personId).pop() ??
      dataset.individuals.keys().next().value;

    onPushEdit(patches, personId, nextId);

    onDirty("individual", personId);
    affectedFamilyIds.forEach((fid) => onDirty("family", fid));
    setHistory((prev) => prev.filter((id) => id !== personId));
    setNotesAdded(false);
    setSelectedId(nextId);
    if (personId === homeId) changeHome(nextId);
    setTick((v) => v + 1);
  }

  // These two hooks must run unconditionally (Rules of Hooks) — they're
  // computed here, above the `!person` early return below, even though
  // both are only consumed once `person` is known to exist. The second one
  // builds decision status (confirmed/rejected/deferred) for relatives shown
  // on the father/mother/partner/child cards, mirroring the candidate list's
  // status chip; a "confirmed" decision wins over any other stale decision
  // recorded against the same master id.
  const { placeSuggestions, placeToAddrs, placeCanonical, addrCanonical } = useMemo(
    () => buildPlaceSuggestions(dataset),
    [dataset],
  );
  const decisionStatusById = useMemo(() => decisionStatusByMasterId(decisions), [decisions]);

  if (!person) {
    return (
      <div className="section open edit-view">
        <div className="section-body">
          <p className="gm-file master gm-data">{fileName}</p>
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
  const kinship = homeId
    ? kinshipLabel(dataset, homeId, selectedId!, t)
    : undefined;
  const homePersonName = homeId
    ? displayName(primaryName(dataset.individuals.get(homeId)!))
    : undefined;
  const kinshipTooltip = kinship && homePersonName
    ? t("kinship.tooltip", { kinship, name: homePersonName })
    : undefined;

  function cardKinship(id: string | undefined): { kinship?: string; kinshipTooltip?: string } {
    if (!homeId || !id) return {};
    const k = kinshipLabel(dataset, homeId, id, t);
    return {
      kinship: k,
      kinshipTooltip: k && homePersonName ? t("kinship.tooltip", { kinship: k, name: homePersonName }) : undefined,
    };
  }

  function cardDecision(id: string | undefined): { decisionStatus?: Exclude<MatchDecisionStatus, "undecided">; decisionLetter?: string; decisionTooltip?: string } {
    const status = id ? decisionStatusById.get(id) : undefined;
    if (!status) return {};
    const tooltip = t(`status.${status}`);
    return { decisionStatus: status, decisionLetter: tooltip.charAt(0), decisionTooltip: tooltip };
  }

  return (
    <div className="section open edit-view">
      <div className="section-body" ref={editBodyRef}>
        <div className="edit-toolbar">
          <button className="tree-open-btn" onClick={goBack} disabled={history.length === 0}>
            ← {t("edit.back")}
          </button>
          <HomePersonSelector
            individuals={dataset.individuals}
            homeId={selectedId}
            onChange={navigate}
            placeholder={t("edit.selectPerson")}
            tooltip={t("edit.selectPerson")}
            icon="search"
          />
          <div className="toolbar-end">
            <button
              className="tree-open-btn"
              onClick={() => selectedId && onShowTree(selectedId)}
              title={t("edit.tree.tooltip")}
            >
              {t("edit.tree.button")}
            </button>
          </div>
        </div>

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
                  />
                )}
              </div>
            );
          })}
        </div>

        <div className="edit-connector-v" />

        <div className="edit-person">
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
          />
          <SexToggle key={`sex-${person.id}`} person={person} t={t} commit={commit} onDelete={handleDeletePerson} kinship={kinship} kinshipTooltip={kinshipTooltip} />
          <OtherNamesEditor
            key={`names-${person.id}-${undoVersion}`}
            person={person}
            t={t}
            commit={commit}
            emptyEventGroups={INDIVIDUAL_EVENT_GROUPS as unknown as { labelKey: string; tags: string[] }[]}
            onAddEvent={(tag) => {
              commit((indi) => addEventNode(indi, tag));
              // addEventNode inserts as the last child with this tag, so find it now.
              const sameTag = person.raw.children.filter((c) => c.tag === tag);
              if (sameTag.length) setPendingFocusEventNodeId(nodeId(sameTag[sameTag.length - 1]));
            }}
            showAddLink={!(person.links ?? []).length && !(person.sources ?? []).length && !mergeIncomingLinks.get("links")?.length}
            onAddLink={() => setSourceDialogTarget({ kind: "individual" })}
            showAddNote={!notesAdded && !(person.notes ?? []).length}
            onAddNote={() => setNotesAdded(true)}
          />
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
            masterMergeKeyBases={masterMergeKeyBases}
            masterMergeCompareKeys={masterMergeCompareKeys}
            masterMergeSortKeys={masterMergeSortKeys}
            extraMergeEvents={extraMergeEvents}
            onRejectIncomingEvent={rejectIncomingEvent}
            onMaterializeIncomingSources={materializeMergeEventSources}
            onResolveMergeField={resolveMergeFields}
            resolvedSessionFields={resolvedSessionFields}
            pendingFocusNodeId={pendingFocusEventNodeId}
            undoVersion={undoVersion}
            mergeGen={mergeGenRef.current}
          />
          {((person.links ?? []).length > 0 || (person.sources ?? []).length > 0 || (mergeIncomingLinks.get("links")?.length ?? 0) > 0) && (
            <div className="edit-record-section">
              <LinksEditor
                key={`rlinks-${person.id}-${undoVersion}`}
                links={person.links ?? []}
                sources={person.sources ?? []}
                incomingLinks={mergeIncomingLinks.get("links")}
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
                  </div>
                </div>
                {fam && (() => {
                  const marrNode = fam.raw.children.find((c) => c.tag === "MARR");
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
                  const eventNode = fam.raw.children.find((c) => c.tag === tag);
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
    </div>
  );
}

/** Inline picker that lets the user either search for an existing person or add a new one. */
function RelativePickerCard({
  roleLabel,
  individuals,
  excludeId,
  onPickExisting,
  onAddNew,
  onCancel,
  t,
}: {
  roleLabel?: string;
  individuals: Map<string, Individual>;
  excludeId: string;
  onPickExisting: (id: string) => void;
  onAddNew: () => void;
  onCancel: () => void;
  t: Translate;
}) {
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) onCancel();
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [onCancel]);

  const options = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...individuals.values()]
      .filter((i) => i.id !== excludeId)
      .map((i) => ({ id: i.id, text: lifespanLabel(i) }))
      .sort((a, b) => a.text.localeCompare(b.text))
      .filter((o) => !q || o.text.toLowerCase().includes(q))
      .slice(0, 10);
  }, [individuals, excludeId, query]);

  useEffect(() => { setActiveIdx(0); }, [query]);

  const totalItems = options.length + 1; // options + "Add new"

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") { onCancel(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx((i) => Math.min(i + 1, totalItems - 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)); }
    if (e.key === "Enter") {
      e.preventDefault();
      if (activeIdx === 0) onAddNew();
      else onPickExisting(options[activeIdx - 1].id);
    }
  }

  return (
    <div className="person-card-wrap" ref={containerRef}>
      {roleLabel && <div className="person-card-role">{roleLabel}</div>}
      <div className="relative-picker">
        <input
          ref={inputRef}
          className="relative-picker-input"
          placeholder={t("edit.searchPerson")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <ul className="relative-picker-list">
          <li>
            <button
              className={`relative-picker-option relative-picker-new${activeIdx === 0 ? " highlighted" : ""}`}
              onMouseEnter={() => setActiveIdx(0)}
              onMouseDown={(e) => { e.preventDefault(); onAddNew(); }}
            >
              + {t("edit.addNewPerson")}
            </button>
          </li>
          {options.map((o, i) => (
            <li key={o.id}>
              <button
                className={`relative-picker-option${i + 1 === activeIdx ? " highlighted" : ""}`}
                onMouseEnter={() => setActiveIdx(i + 1)}
                onMouseDown={(e) => { e.preventDefault(); onPickExisting(o.id); }}
              >
                {o.text}
              </button>
            </li>
          ))}
          {options.length === 0 && query.trim() && (
            <li className="relative-picker-empty muted">{t("home.noMatches")}</li>
          )}
        </ul>
      </div>
    </div>
  );
}

/** Input with an × button at the right edge to clear its value.
 * The clear button only appears when the field is non-empty.
 * `wrapStyle` is applied to the wrapper div (e.g. to set a ch-based width). */
const ClearableInput = forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement> & {
    onClear: () => void;
    wrapStyle?: React.CSSProperties;
    wrapClassName?: string;
  }
>(function ClearableInput({ value, onClear, wrapStyle, wrapClassName, className, ...rest }, ref) {
  return (
    <div
      className={`clearable-wrap${wrapClassName ? ` ${wrapClassName}` : ""}`}
      style={wrapStyle}
    >
      <input ref={ref} className={className} value={value} {...rest} />
      {value ? (
        <button
          type="button"
          className="input-clear"
          tabIndex={-1}
          title={rest.title ? `${rest.title ? "Clear " + rest.title.toLowerCase() : "Clear"}` : "Clear"}
          onMouseDown={(e) => {
            e.preventDefault(); // keep input focused so onBlur fires with the cleared value
            onClear();
          }}
        >
          ×
        </button>
      ) : null}
    </div>
  );
});

/** Multi-line counterpart to {@link ClearableInput}, for fields (e.g. event
 * notes) that may carry several lines of text, matching how the Compare panel
 * renders a multi-line value as stacked lines. */
const ClearableTextarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
    onClear: () => void;
    wrapStyle?: React.CSSProperties;
    wrapClassName?: string;
  }
>(function ClearableTextarea({ value, onClear, wrapStyle, wrapClassName, className, ...rest }, ref) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null);

  // Grow the textarea to fit its content — one line tall when short, taller
  // as it wraps or gains lines — so editing reads like the multi-line text
  // the Compare panel renders, instead of scrolling inside a fixed box.
  //
  // A ResizeObserver (not just a `[value]` effect) because this row can
  // mount while its ancestor is the inactive Edit/Merge mode layer (both are
  // always mounted; the inactive one is hidden, not unmounted, to preserve
  // state across tab switches — see App.tsx). `scrollHeight` of anything
  // under `display: none` reads 0, so a mount-time-only measurement bakes in
  // a collapsed height that never gets recomputed once the tab becomes
  // visible, since `value` doesn't change again on its own. The observer
  // re-measures whenever the element's actual box appears/changes.
  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const resize = () => {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    };
    resize();
    // Deferred via rAF: resize() itself changes the observed box, and
    // calling it straight from the observer callback (synchronously, in the
    // same notification cycle) is what trips the browser's "ResizeObserver
    // loop completed with undelivered notifications" warning.
    const ro = new ResizeObserver(() => requestAnimationFrame(resize));
    ro.observe(el);
    return () => ro.disconnect();
  }, [value]);

  return (
    <div
      className={`clearable-wrap clearable-wrap--textarea${wrapClassName ? ` ${wrapClassName}` : ""}`}
      style={wrapStyle}
    >
      <textarea
        ref={(el) => {
          innerRef.current = el;
          if (typeof ref === "function") ref(el);
          else if (ref) ref.current = el;
        }}
        className={className}
        value={value}
        {...rest}
      />
      {value ? (
        <button
          type="button"
          className="input-clear"
          tabIndex={-1}
          title={rest.title ? `${rest.title ? "Clear " + rest.title.toLowerCase() : "Clear"}` : "Clear"}
          onMouseDown={(e) => {
            e.preventDefault(); // keep textarea focused so onBlur fires with the cleared value
            onClear();
          }}
        >
          ×
        </button>
      ) : null}
    </div>
  );
});

/** Canonical lookup: given raw user input, return the canonical casing form if
 * it matches an existing entry in the map, otherwise return the input trimmed. */
function applyCanonical(raw: string, canonical: Map<string, string>): string {
  const key = raw.trim().split(",").map((p) => p.trim().toLowerCase()).join("|");
  return canonical.get(key) ?? raw.trim();
}

/** A text input with dropdown autocomplete from a pre-built suggestion list.
 * When the user selects a suggestion or blurs, the canonical form is applied. */
function PlaceAutocomplete({
  value,
  suggestions,
  canonical,
  isDirty,
  isMerge,
  className,
  wrapClassName,
  placeholder,
  title,
  onChange,
  onCommit,
  onClear,
}: {
  value: string;
  suggestions: string[];
  canonical: Map<string, string>;
  isDirty: boolean;
  isMerge?: boolean;
  className?: string;
  wrapClassName?: string;
  placeholder?: string;
  title?: string;
  onChange: (value: string) => void;
  onCommit: (value: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = value.trim().toLowerCase();
    if (!q) return [];
    return suggestions.filter((s) => s.toLowerCase().includes(q)).slice(0, 8);
  }, [value, suggestions]);

  const showDropdown = open && filtered.length > 0;

  function selectSuggestion(suggestion: string) {
    onChange(suggestion);
    onCommit(suggestion);
    setOpen(false);
    setHighlighted(-1);
  }

  function handleBlur(e: React.FocusEvent) {
    if (containerRef.current?.contains(e.relatedTarget as Node)) return;
    setOpen(false);
    setHighlighted(-1);
    const norm = applyCanonical(value, canonical);
    if (norm !== value) onChange(norm);
    onCommit(norm);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHighlighted((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter" && highlighted >= 0 && showDropdown) {
      e.preventDefault();
      selectSuggestion(filtered[highlighted]);
    } else if (e.key === "Escape") {
      setOpen(false);
      setHighlighted(-1);
    }
  }

  return (
    <div ref={containerRef} className={`place-autocomplete-wrap${wrapClassName ? ` ${wrapClassName}` : ""}`} onBlur={handleBlur}>
      <ClearableInput
        className={`${isMerge ? "edit-input--merge " : isDirty ? "edit-input--dirty " : ""}${className ?? ""}`}
        value={value}
        placeholder={placeholder}
        title={title}
        onChange={(e) => { onChange(e.target.value); setOpen(true); setHighlighted(-1); }}
        onFocus={() => { if (value.trim()) setOpen(true); }}
        onKeyDown={handleKeyDown}
        onBlur={() => {}}
        onClear={() => { onClear(); setOpen(false); }}
      />
      {showDropdown && (
        <ul className="place-suggestions" role="listbox">
          {filtered.map((s, i) => (
            <li
              key={s}
              role="option"
              aria-selected={i === highlighted}
              className={i === highlighted ? "place-suggestion place-suggestion--hi" : "place-suggestion"}
              onMouseDown={(e) => { e.preventDefault(); selectSuggestion(s); }}
            >
              {s}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Editable given/surname fields for the primary name, plus the lifespan. */
function NameEditor({
  person,
  t,
  lifespan,
  commit,
  focusOnMount,
  onMounted,
  mergeHighlight,
  hasMatch,
  matchStatus,
  onToggleMatchStatus,
}: {
  person: Individual;
  t: Translate;
  lifespan?: string;
  commit: Commit;
  focusOnMount?: boolean;
  onMounted?: () => void;
  mergeHighlight?: Map<string, string>;
  /** True when this person has an incoming match candidate. */
  hasMatch?: boolean;
  matchStatus?: MatchDecisionStatus;
  onToggleMatchStatus?: (status: MatchDecisionStatus) => void;
}) {
  const primary = primaryName(person);
  // Stable merge values from first render (component is keyed per person)
  const givenMergeInit = useRef(mergeHighlight?.get("given"));
  const surnameMergeInit = useRef(mergeHighlight?.get("surname"));
  const [given, setGiven] = useState(givenMergeInit.current ?? primary?.given ?? "");
  const [surname, setSurname] = useState(surnameMergeInit.current ?? primary?.surname ?? "");
  const givenRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focusOnMount) givenRef.current?.focus();
    onMounted?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function commitName(nextGiven: string, nextSurname: string) {
    commit((indi) => setName(indi, { given: nextGiven, surname: nextSurname }));
  }

  const givenIsMerge = givenMergeInit.current !== undefined && given === givenMergeInit.current;
  const surnameIsMerge = surnameMergeInit.current !== undefined && surname === surnameMergeInit.current;

  return (
    <div className="edit-name-row" title={datesTooltipOf(person)}>
      <ClearableInput
        ref={givenRef}
        className={`edit-input edit-name-input ${sexClass(person.sex)}${givenIsMerge ? " edit-input--merge" : ""}`}
        wrapStyle={{ width: fieldWidth(given, t("field.given")) }}
        value={given}
        placeholder={t("field.given")}
        title={t("field.given")}
        onChange={(e) => setGiven(e.target.value)}
        onBlur={() => commitName(given, surname)}
        onClear={() => { setGiven(""); commitName("", surname); }}
      />
      <ClearableInput
        className={`edit-input edit-name-input ${sexClass(person.sex)}${surnameIsMerge ? " edit-input--merge" : ""}`}
        wrapStyle={{ width: fieldWidth(surname, t("field.surname")) }}
        value={surname}
        placeholder={t("field.surname")}
        title={t("field.surname")}
        onChange={(e) => setSurname(e.target.value)}
        onBlur={() => commitName(given, surname)}
        onClear={() => { setSurname(""); commitName(given, ""); }}
      />
      {lifespan && <span className="person-years gm-data">{lifespan}</span>}
      {matchStatus && matchStatus !== "undecided" && (
        <span className={`status-chip ${matchStatus}`} title={t(`status.${matchStatus}`)}>
          {t(`status.${matchStatus}`).charAt(0)}
        </span>
      )}
      {hasMatch && (
        <div className="decision-bar edit-name-decisions">
          {MATCH_STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              className={matchStatus === s ? `decision ${s} active` : "decision"}
              title={t(`status.${s}`)}
              onClick={() => onToggleMatchStatus?.(s)}
            >
              {t(`status.${s}`)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const MATCH_STATUSES: Exclude<MatchDecisionStatus, "undecided">[] = ["confirmed", "rejected", "deferred"];

const SEX_OPTIONS: Sex[] = ["M", "F", "U"];

/** M/F/U toggle for the individual's `SEX` line. */
const SEX_GLYPHS: Record<string, string> = { M: "♂", F: "♀", U: "?" };

function SexToggle({ person, t, commit, onDelete, kinship, kinshipTooltip }: { person: Individual; t: Translate; commit: Commit; onDelete: () => void; kinship?: string; kinshipTooltip?: string }) {
  return (
    <div className="edit-sex-row">
      {kinship && <span className="person-kinship" title={kinshipTooltip}>{kinship}</span>}
      <select
        className={`sex-select ${sexClass(person.sex)}`}
        value={person.sex}
        onChange={(e) => commit((indi) => setSex(indi, e.target.value as Sex))}
      >
        {SEX_OPTIONS.map((s) => (
          <option key={s} value={s}>
            {SEX_GLYPHS[s]} {t(`sex.${s}`)}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="edit-delete-btn"
        title={t("edit.deletePersonTooltip")}
        onClick={onDelete}
      >
        🗑
      </button>
    </div>
  );
}

/** Nickname plus any further `NAME` records (married/maiden/aka/…), shown as
 * chips that turn into editable fields on click, plus a single "+ Add name"
 * button and an "+ Add event" dropdown to append events from the same row. */
function OtherNamesEditor({
  person,
  t,
  commit,
  emptyEventGroups,
  onAddEvent,
  showAddLink,
  onAddLink,
  showAddNote,
  onAddNote,
}: {
  person: Individual;
  t: Translate;
  commit: Commit;
  emptyEventGroups: { labelKey: string; tags: string[] }[];
  onAddEvent: (tag: string) => void;
  showAddLink: boolean;
  onAddLink: () => void;
  showAddNote: boolean;
  onAddNote: () => void;
}) {
  const [editing, setEditing] = useState<"nick" | number | null>(null);
  const primary = primaryName(person);
  const extraNames = person.names.slice(1);
  const hasNamesContent = editing !== null || !!primary?.nickname || extraNames.length > 0;

  const addNameBtn = (
    <button
      type="button"
      className="edit-name-chip edit-name-chip-add"
      title={t("edit.addNameTooltip")}
      onClick={() => {
        commit((indi) => addAdditionalName(indi, "aka"));
        setEditing(extraNames.length);
      }}
    >
      + {t("edit.addName")}
    </button>
  );

  return (
    <div className="edit-other-names">
      {/* Names row — only shown when there are names or editing */}
      {hasNamesContent && (
        <div className="edit-other-names-row">
          {editing === "nick" ? (
            <NicknameEditor person={person} t={t} commit={commit} onDone={() => setEditing(null)} />
          ) : primary?.nickname ? (
            <span className="edit-name-chip-wrap">
              <button type="button" className="edit-name-chip" onClick={() => setEditing("nick")}>
                {primary.nickname}
                <span className="muted"> ({nameTypeLabel("nick", t)})</span>
              </button>
              <button
                type="button"
                className="edit-link-remove"
                title={t("edit.removeName")}
                onClick={() => commit((indi) => setNickname(indi, ""))}
              >
                ×
              </button>
            </span>
          ) : null}
          {extraNames.map((n, i) =>
            editing === i ? (
              <NameVariantEditor key={i} person={person} index={i} t={t} commit={commit} onDone={() => setEditing(null)} />
            ) : (
              <span className="edit-name-chip-wrap" key={i}>
                <button type="button" className="edit-name-chip" onClick={() => setEditing(i)}>
                  {displayName(n)}
                  {n.type && <span className="muted"> ({nameTypeLabel(n.type, t)})</span>}
                </button>
                <button
                  type="button"
                  className="edit-link-remove"
                  title={t("edit.removeName")}
                  onClick={() => commit((indi) => removeAdditionalName(indi, i))}
                >
                  ×
                </button>
              </span>
            ),
          )}
          {addNameBtn}
        </div>
      )}
      {/* Action chips row — always present */}
      <div className="edit-other-names-row edit-other-names-actions">
        <AddEventSelect
          groups={emptyEventGroups}
          label={t("edit.addEvent")}
          tooltip={t("edit.addEventTooltip")}
          t={t}
          onAdd={onAddEvent}
          className="edit-name-chip edit-name-chip-add add-chip-select"
        />
        {showAddLink && (
          <button
            type="button"
            className="edit-name-chip edit-name-chip-add"
            title={t("edit.addLinkTooltip")}
            onClick={onAddLink}
          >
            + {t("edit.addLink")}
          </button>
        )}
        {showAddNote && (
          <button
            type="button"
            className="edit-name-chip edit-name-chip-add"
            title={t("edit.addNoteTooltip")}
            onClick={onAddNote}
          >
            + {t("edit.addNote")}
          </button>
        )}
        {!hasNamesContent && addNameBtn}
      </div>
    </div>
  );
}

/** Inline-editable nickname (the primary name's `NICK` sub-tag). */
function NicknameEditor({
  person,
  t,
  commit,
  onDone,
}: {
  person: Individual;
  t: Translate;
  commit: Commit;
  onDone: () => void;
}) {
  const [value, setValue] = useState(primaryName(person)?.nickname ?? "");

  return (
    <span className="edit-name-chip edit-name-chip-editing">
      <ClearableInput
        className="edit-input edit-name-variant-input"
        wrapStyle={{ width: fieldWidth(value, t("nametype.nick")) }}
        value={value}
        placeholder={t("nametype.nick")}
        title={t("nametype.nick")}
        autoFocus
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => commit((indi) => setNickname(indi, value))}
        onClear={() => { setValue(""); commit((indi) => setNickname(indi, "")); }}
      />
      <button
        type="button"
        className="edit-link-remove"
        title={t("edit.removeName")}
        onClick={() => {
          commit((indi) => setNickname(indi, ""));
          setValue("");
          onDone();
        }}
      >
        ×
      </button>
    </span>
  );
}

/** Inline-editable given/surname/type for an additional `NAME` record
 * (married/maiden/aka/…) — see `setAdditionalName` for indexing. */
function NameVariantEditor({
  person,
  index,
  t,
  commit,
  onDone,
}: {
  person: Individual;
  index: number;
  t: Translate;
  commit: Commit;
  onDone: () => void;
}) {
  const name = person.names[index + 1];
  const [given, setGiven] = useState(name?.given ?? "");
  const [surname, setSurname] = useState(name?.surname ?? "");

  function commitFields(nextGiven: string, nextSurname: string) {
    commit((indi) => setAdditionalName(indi, index, { given: nextGiven, surname: nextSurname }));
  }

  const ref = useRef<HTMLSpanElement>(null);

  return (
    <span
      ref={ref}
      className="edit-name-chip edit-name-chip-editing"
      onBlur={(e) => { if (!ref.current?.contains(e.relatedTarget as Node)) onDone(); }}
    >
      <ClearableInput
        className="edit-input edit-name-variant-input"
        wrapStyle={{ width: fieldWidth(given, t("field.given"), 12) }}
        value={given}
        placeholder={t("field.given")}
        title={t("field.given")}
        autoFocus
        onChange={(e) => setGiven(e.target.value)}
        onBlur={() => commitFields(given, surname)}
        onClear={() => { setGiven(""); commitFields("", surname); }}
      />
      <ClearableInput
        className="edit-input edit-name-variant-input"
        wrapStyle={{ width: fieldWidth(surname, t("field.surname"), 12) }}
        value={surname}
        placeholder={t("field.surname")}
        title={t("field.surname")}
        onChange={(e) => setSurname(e.target.value)}
        onBlur={() => commitFields(given, surname)}
        onClear={() => { setSurname(""); commitFields(given, ""); }}
      />
      <select
        className="edit-input edit-name-type-select"
        value={name?.type ?? "aka"}
        title={t("field.nameType")}
        onChange={(e) => commit((indi) => setAdditionalName(indi, index, { type: e.target.value }))}
      >
        {ADDITIONAL_NAME_TYPES.map((opt) => (
          <option key={opt} value={opt}>
            {nameTypeLabel(opt, t)}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="edit-link-remove"
        title={t("edit.removeName")}
        onClick={() => {
          commit((indi) => removeAdditionalName(indi, index));
          onDone();
        }}
      >
        ×
      </button>
    </span>
  );
}

/** Display order for extra merge events (tags not yet in master) and secondary event sort key. */
const EXTRA_EVENT_ORDER = [
  "BAPM", "CHR", "CONF", "ADOP", "FCOM",
  "OCCU", "EDUC", "RETI",
  "RESI", "EMIG", "IMMI", "NATU", "CENS",
  "WILL", "PROB",
  "DEAT", "BURI", "CREM",
];

/** Events grid: BIRT always first (creates on commit), then all other events
 * in person.events order — multiple occurrences of the same tag are supported.
 * When mergeHighlight is set, merge-highlighted fields are shown and extra incoming-only
 * events are appended at the end. */
function EventList({
  person,
  t,
  commit,
  openEditSource,
  onOpenSourceDialog,
  placeSuggestions,
  placeToAddrs,
  placeCanonical,
  addrCanonical,
  mergeHighlight,
  mergeIncomingSources,
  masterMergeKeyBases,
  masterMergeCompareKeys,
  masterMergeSortKeys,
  extraMergeEvents,
  onRejectIncomingEvent,
  onMaterializeIncomingSources,
  onResolveMergeField,
  resolvedSessionFields,
  pendingFocusNodeId,
  undoVersion,
  mergeGen,
}: {
  person: Individual;
  t: Translate;
  commit: Commit;
  openEditSource: OpenEditSource;
  onOpenSourceDialog: (target: SourceDialogTarget) => void;
  placeSuggestions: string[];
  placeToAddrs: Map<string, string[]>;
  placeCanonical: Map<string, string>;
  addrCanonical: Map<string, string>;
  mergeHighlight?: Map<string, string>;
  /** Field key (e.g. "BIRT.sources") → incoming source citations the merge will add. */
  mergeIncomingSources?: Map<string, SourceCitation[]>;
  /** master person.events[i] → field key base aligned with orderedEventTags. */
  masterMergeKeyBases?: Map<number, string>;
  /** master person.events[i] → the incoming event it's paired with, as `${tag}:${compareIdx}`. */
  masterMergeCompareKeys?: Map<number, string>;
  /** master person.events[i] → sort key from incoming date, when master has no date. */
  masterMergeSortKeys?: Map<number, number>;
  /** Incoming-only events, each carrying a date-based sort key for interleaving. */
  extraMergeEvents?: { tag: string; keyBase: string; sortKey: number; compareIdx: number }[];
  /** Called to permanently reject an incoming event — dismissing/deleting an
   * "extra" suggestion row, deleting a master row paired with one, or editing
   * an extra row's field (materializing a new master event from it) — so it's
   * treated as absent for the rest of the session, on Save too (see
   * `rejectIncomingEvent`). */
  onRejectIncomingEvent?: (tag: string, compareIdx: number) => void;
  /** Called when an "extra" row's direct field edit is about to materialize a
   * new master event, to copy that incoming event's `SOUR` citations onto the
   * just-created node before it's rejected (see `onRejectIncomingEvent`) and
   * its sources become unreachable. Returns undo patches for any imported
   * top-level `SOUR`/`REPO` records. */
  onMaterializeIncomingSources?: (eventNode: GedNode, tag: string, compareIdx: number) => RecordPatch[];
  /** Called after a direct field edit, to resolve the touched merge sub-fields
   * (e.g. "date", "value") to "master" so they stop being treated as pending
   * incoming suggestions. */
  onResolveMergeField?: (keyBase: string, subs: string[]) => void;
  /** Sub-field keys (e.g. "OCCU.value") resolved from a merge suggestion via a
   * direct edit earlier this session — kept dirty/bold despite the row's
   * one-time remount from "extra" to "master" kind. */
  resolvedSessionFields?: Set<string>;
  pendingFocusNodeId?: number | null;
  undoVersion?: number;
  /** Bumped whenever the confirmed-match merge preview recomputes; folded into
   * row keys so a row already mounted before a match was confirmed remounts
   * and picks up the now-available incoming values (see `mergeGenRef`). */
  mergeGen?: number;
}) {
  const birtEv = person.events.find((e) => e.tag === "BIRT");

  /** Merge sub-field keys (e.g. "date", "addr") touched by `update`, for `onResolveMergeField`. */
  function subsOf(update: EventFieldUpdate): string[] {
    const subs: string[] = [];
    if (update.date !== undefined) subs.push("date");
    if (update.value !== undefined) subs.push("value");
    if (update.place !== undefined) subs.push("place");
    if (update.address !== undefined) subs.push("addr");
    if (update.note !== undefined) subs.push("note");
    if (update.agency !== undefined) subs.push("agency");
    return subs;
  }

  // Fallback key bases when no merge is active (master-only count-based naming).
  const tagCount = new Map<string, number>();
  person.events.forEach((ev) => tagCount.set(ev.tag, (tagCount.get(ev.tag) ?? 0) + 1));
  const tagIdx = new Map<string, number>();
  const eventKeyBases: string[] = person.events.map((ev) => {
    const idx = tagIdx.get(ev.tag) ?? 0;
    tagIdx.set(ev.tag, idx + 1);
    return (tagCount.get(ev.tag) ?? 0) > 1 ? `${ev.tag}.${idx}` : ev.tag;
  });
  const birtOriginalIdx = person.events.findIndex((e) => e.tag === "BIRT");
  const birtMergeKeyBase = birtOriginalIdx >= 0
    ? (masterMergeKeyBases?.get(birtOriginalIdx) ?? eventKeyBases[birtOriginalIdx])
    : "BIRT";

  // Unified sorted list: master non-BIRT events interleaved with incoming-only extra events.
  type MasterRow  = { kind: "master"; ev: GedEvent; i: number; mergeKeyBase: string; compareKey?: string; stableKey: number };
  type ExtraRow   = { kind: "extra";  tag: string; keyBase: string; compareIdx: number };
  type AnyRow     = (MasterRow | ExtraRow) & { sortKey: number; tagPos: number };

  // Raw event nodes in the same order as person.events — used for stable WeakMap keys.
  const rawEventNodes = person.raw.children.filter((c) => INDI_EVENT_TAGS.has(c.tag));

  // Earliest known death/burial/cremation date, so an imprecise life-zone date
  // (e.g. a year-only OCCU) never sorts after it — see `clampBeforeDeathZone`.
  const minDeathKey = minDeathZoneKey(person.events);

  const allRows: AnyRow[] = [
    ...person.events
      .map((ev, i) => ({ ev, i }))
      .filter(({ ev }) => ev.tag !== "BIRT")
      .map(({ ev, i }): AnyRow => ({
        kind: "master",
        ev, i,
        mergeKeyBase: masterMergeKeyBases?.get(i) ?? eventKeyBases[i],
        compareKey: masterMergeCompareKeys?.get(i),
        stableKey: nodeId(rawEventNodes[i] ?? ev),
        sortKey: clampBeforeDeathZone(ev.tag, masterMergeSortKeys?.get(i) ?? dateToSortKey(ev.date), minDeathKey),
        tagPos: EXTRA_EVENT_ORDER.indexOf(ev.tag),
      })),
    ...(extraMergeEvents ?? [])
      .map(({ tag, keyBase, sortKey, compareIdx }): AnyRow => ({
        kind: "extra",
        tag, keyBase, compareIdx,
        sortKey: clampBeforeDeathZone(tag, sortKey, minDeathKey),
        tagPos: EXTRA_EVENT_ORDER.indexOf(tag),
      })),
  ];
  allRows.sort((a, b) => {
    if (a.sortKey !== b.sortKey) return a.sortKey - b.sortKey;
    const pa = a.tagPos === -1 ? 999 : a.tagPos;
    const pb = b.tagPos === -1 ? 999 : b.tagPos;
    return pa - pb;
  });

  return (
    <div className="edit-events">
      <div className="edit-event-head">
        <span />
        <span>{t("event.colDate")}</span>
        <span>{t("event.colPlace")}</span>
        <span>{t("event.colAddr")}</span>
        <span />
      </div>
      <EventFieldsRow
        key={`${person.id}-BIRT-${undoVersion ?? 0}-${mergeGen ?? 0}`}
        ev={birtEv}
        label={t("event.BIRT")}
        tag="BIRT"
        t={t}
        commitField={(update, extraPatches) => {
          commit((indi) => setEventField(indi, "BIRT", update), extraPatches);
          onResolveMergeField?.(birtMergeKeyBase, subsOf(update));
        }}
        onRemove={birtOriginalIdx >= 0 ? () => commit((indi) => removeEventAtIndex(indi, birtOriginalIdx)) : undefined}
        onAddSource={() => onOpenSourceDialog({ kind: "event", commitField: (update, extraPatches) => commit((indi) => setEventField(indi, "BIRT", update), extraPatches) })}
        onEditSource={birtOriginalIdx >= 0 ? (idx) => openEditSource(rawEventNodes[birtOriginalIdx], idx, { kind: "individual", indi: person }) : undefined}
        onOpenSourceDialog={onOpenSourceDialog}
        placeSuggestions={placeSuggestions}
        placeToAddrs={placeToAddrs}
        placeCanonical={placeCanonical}
        addrCanonical={addrCanonical}
        mergeHighlight={mergeHighlight}
        mergeIncomingSources={mergeIncomingSources}
        mergeKeyBase={birtMergeKeyBase}
        resolvedSessionFields={resolvedSessionFields}
      />
      {allRows.map((row) =>
        row.kind === "master" ? (
          <EventFieldsRow
            key={`ev-${row.stableKey}-${mergeGen ?? 0}`}
            ev={row.ev}
            label={t(`event.${row.ev.tag}`)}
            tag={row.ev.tag}
            t={t}
            commitField={(update, extraPatches) => {
              commit((indi) => setEventFieldAtIndex(indi, row.i, update), extraPatches);
              onResolveMergeField?.(row.mergeKeyBase, subsOf(update));
            }}
            onChangeTag={ASSIGNABLE_EVENT_TAGS.has(row.ev.tag) ? (newTag) => commit((indi) => changeEventTagAtIndex(indi, row.i, newTag)) : undefined}
            tagGroups={ASSIGNABLE_EVENT_TAGS.has(row.ev.tag) ? INDIVIDUAL_EVENT_GROUPS : undefined}
            onRemove={() => {
              commit((indi) => removeEventAtIndex(indi, row.i));
              if (row.compareKey) {
                const [ctag, cidx] = row.compareKey.split(":");
                onRejectIncomingEvent?.(ctag, Number(cidx));
              }
            }}
            onAddSource={() => onOpenSourceDialog({ kind: "event", commitField: (update, extraPatches) => commit((indi) => setEventFieldAtIndex(indi, row.i, update), extraPatches) })}
            onEditSource={(idx) => openEditSource(rawEventNodes[row.i], idx, { kind: "individual", indi: person })}
            onOpenSourceDialog={onOpenSourceDialog}
            autoFocusDate={row.stableKey === pendingFocusNodeId}
            placeSuggestions={placeSuggestions}
            placeToAddrs={placeToAddrs}
            placeCanonical={placeCanonical}
            addrCanonical={addrCanonical}
            mergeHighlight={mergeHighlight}
            mergeIncomingSources={mergeIncomingSources}
            mergeKeyBase={row.mergeKeyBase}
            resolvedSessionFields={resolvedSessionFields}
          />
        ) : (
          <EventFieldsRow
            key={`${person.id}-merge-${row.keyBase}-${mergeGen ?? 0}`}
            ev={undefined}
            label={t(`event.${row.tag}`)}
            tag={row.tag}
            t={t}
            commitField={(update, extraPatches) => {
              const patches = [...(extraPatches ?? [])];
              commit((indi) => {
                const eventNode = addEventField(indi, row.tag, update);
                if (eventNode) patches.push(...(onMaterializeIncomingSources?.(eventNode, row.tag, row.compareIdx) ?? []));
              }, patches);
              onResolveMergeField?.(row.keyBase, subsOf(update));
              onRejectIncomingEvent?.(row.tag, row.compareIdx);
            }}
            onRemove={() => onRejectIncomingEvent?.(row.tag, row.compareIdx)}
            onAddSource={() => onOpenSourceDialog({ kind: "event", commitField: (update, extraPatches) => commit((indi) => addEventField(indi, row.tag, update), extraPatches) })}
            onOpenSourceDialog={onOpenSourceDialog}
            placeSuggestions={placeSuggestions}
            placeToAddrs={placeToAddrs}
            placeCanonical={placeCanonical}
            addrCanonical={addrCanonical}
            mergeHighlight={mergeHighlight}
            mergeIncomingSources={mergeIncomingSources}
            mergeKeyBase={row.keyBase}
            resolvedSessionFields={resolvedSessionFields}
          />
        ),
      )}
    </div>
  );
}

/** Any family event row (MARR, DIV, ENGA, SEPA, …) by tag. */
function FamilyEventRow({
  fam, tag, t, commit, openEditSource, onOpenSourceDialog, onRemove, onRetag, autoFocusDate,
  placeSuggestions, placeToAddrs, placeCanonical, addrCanonical,
  mergeHighlight, mergeIncomingSources, famMergeKeyBase, resolvedSessionFields,
}: {
  fam: Family; tag: string; t: Translate; commit: FamilyCommit;
  openEditSource: OpenEditSource;
  onOpenSourceDialog: (target: SourceDialogTarget) => void;
  onRemove?: () => void;
  /** Called (with the new tag) right after a type-change commit, so the
   * caller can flag the now-occupied slot as session-dirty — see
   * `resolvedSessionFields`. */
  onRetag?: (newTag: string) => void;
  autoFocusDate?: boolean;
  placeSuggestions: string[];
  placeToAddrs: Map<string, string[]>;
  placeCanonical: Map<string, string>;
  addrCanonical: Map<string, string>;
  mergeHighlight?: Map<string, string>;
  mergeIncomingSources?: Map<string, SourceCitation[]>;
  /** `fam.<id>` key base resolved against the incoming pairing (see
   * `familyMergeKeyBases`); falls back to this family's own id when there's
   * no active merge preview, which is harmless since `mergeHighlight` would
   * then be empty anyway. */
  famMergeKeyBase?: string;
  resolvedSessionFields?: Set<string>;
}) {
  const ev = fam.events.find((e) => e.tag === tag);
  const label = t(`event.${tag}`);
  const eventNode = fam.raw.children.find((c) => c.tag === tag);
  const tagChoices = familyTagChoices(fam, tag);

  return (
    <EventFieldsRow
      ev={ev}
      label={label}
      tag={tag}
      t={t}
      commitField={(update, extraPatches) => commit(fam, (f) => setFamilyEventField(f, tag, update), extraPatches)}
      onRemove={onRemove}
      onChangeTag={tagChoices.length > 1 ? (newTag) => {
        commit(fam, (f) => changeFamilyEventTag(f, tag, newTag));
        onRetag?.(newTag);
      } : undefined}
      tagGroups={tagChoices.length > 1 ? [{ tags: tagChoices }] : undefined}
      onAddSource={() => onOpenSourceDialog({ kind: "event", commitField: (update, extraPatches) => commit(fam, (f) => setFamilyEventField(f, tag, update), extraPatches) })}
      onEditSource={eventNode ? (idx) => openEditSource(eventNode, idx, { kind: "family", fam }) : undefined}
      onOpenSourceDialog={onOpenSourceDialog}
      autoFocusDate={autoFocusDate}
      placeSuggestions={placeSuggestions}
      placeToAddrs={placeToAddrs}
      placeCanonical={placeCanonical}
      addrCanonical={addrCanonical}
      mergeHighlight={mergeHighlight}
      mergeIncomingSources={mergeIncomingSources}
      mergeKeyBase={`${famMergeKeyBase ?? `fam.${fam.id}`}.${tag}`}
      resolvedSessionFields={resolvedSessionFields}
    />
  );
}

/** Dropdown chip that adds an event tag from a list of available tags.
 * Resets to the placeholder after selection. */
function AddEventSelect({
  tags,
  groups,
  label,
  tooltip,
  t,
  onAdd,
  className = "add-chip add-chip-select",
}: {
  tags?: string[];
  groups?: { labelKey: string; tags: string[] }[];
  label: string;
  tooltip?: string;
  t: Translate;
  onAdd: (tag: string) => void;
  className?: string;
}) {
  const [value, setValue] = useState("");
  const hasAny = tags?.length || groups?.some((g) => g.tags.length);
  if (!hasAny) return null;
  return (
    <label className={className} title={tooltip}>
      + {label}
      <select
        className="add-chip-select-inner"
        value={value}
        onChange={(e) => {
          const tag = e.target.value;
          setValue("");
          if (tag) onAdd(tag);
        }}
      >
        <option value="" />
        {groups
          ? groups.map((g) => (
              <optgroup key={g.labelKey} label={t(g.labelKey)}>
                {g.tags.map((tag) => (
                  <option key={tag} value={tag}>{t(`event.${tag}`)}</option>
                ))}
              </optgroup>
            ))
          : tags?.map((tag) => (
              <option key={tag} value={tag}>{t(`event.${tag}`)}</option>
            ))}
      </select>
    </label>
  );
}

function useField(initial: string, mergeInitial?: string) {
  const effectiveInitial = mergeInitial ?? initial;
  const [value, setValue] = useState(effectiveInitial);
  const init = useRef(effectiveInitial);
  return {
    value,
    /** The value this field mounted with (its real saved value, or — for an
     * unapplied merge suggestion — the incoming value shown but not yet
     * written). Lets a caller tell "nothing happened here" apart from "this
     * is merely still showing its starting value". */
    initial: init.current,
    /** True when the current value still equals the unedited merge-incoming value. */
    isMerge: mergeInitial !== undefined && value === mergeInitial,
    isDirty: value !== init.current,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setValue(e.target.value),
    set: setValue,
    clear: () => setValue(""),
  };
}

/** Editable date/place/address/links for a single event (individual or
 * family), e.g. `1 BIRT` or `1 MARR`. */
function EventFieldsRow({
  ev,
  label,
  tag,
  t,
  commitField,
  onRemove,
  onChangeTag,
  tagGroups,
  onAddSource,
  onEditSource,
  onOpenSourceDialog,
  autoFocusDate,
  placeSuggestions,
  placeToAddrs,
  placeCanonical,
  addrCanonical,
  mergeHighlight,
  mergeIncomingSources,
  mergeKeyBase,
  resolvedSessionFields,
}: {
  ev: GedEvent | undefined;
  label: string;
  tag?: string;
  t: Translate;
  commitField: (update: EventFieldUpdate, extraPatches?: RecordPatch[]) => void;
  onRemove?: () => void;
  /** When set (together with `tagGroups`), the type label becomes a dropdown
   * so the user can change this event's tag in place (e.g. turn an
   * Occupation into an Education event). */
  onChangeTag?: (newTag: string) => void;
  /** Options for the type-change dropdown — grouped under an `<optgroup>`
   * when `labelKey` is given (individual events), or shown as a flat list
   * otherwise (family events, which have too few tags to need grouping). */
  tagGroups?: readonly { labelKey?: string; tags: readonly string[] }[];
  onAddSource: () => void;
  onEditSource?: (index: number) => void;
  onOpenSourceDialog: (target: SourceDialogTarget) => void;
  autoFocusDate?: boolean;
  placeSuggestions: string[];
  placeToAddrs: Map<string, string[]>;
  placeCanonical: Map<string, string>;
  addrCanonical: Map<string, string>;
  mergeHighlight?: Map<string, string>;
  /** Field key (e.g. "BIRT.sources") → incoming source citations the merge will add. */
  mergeIncomingSources?: Map<string, SourceCitation[]>;
  mergeKeyBase?: string;
  resolvedSessionFields?: Set<string>;
}) {
  const showValue = tag !== undefined && VALUE_EVENT_TAGS.has(tag);

  // Compute merge values before hooks so they can be used as initial state.
  const kBase = mergeKeyBase ?? tag ?? "";
  const dateMergeVal = mergeHighlight?.get(`${kBase}.date`);
  const valueMergeVal = showValue ? mergeHighlight?.get(`${kBase}.value`) : undefined;
  const placeMergeVal = mergeHighlight?.get(`${kBase}.place`);
  const addrMergeVal = mergeHighlight?.get(`${kBase}.addr`);
  const noteMergeVal = mergeHighlight?.get(`${kBase}.note`);
  const agencyMergeVal = mergeHighlight?.get(`${kBase}.agency`);
  const sourcesMergeVal = mergeIncomingSources?.get(`${kBase}.sources`);

  // A field just materialized from a merge suggestion via a direct edit keeps
  // showing dirty/bold across the row's one-time "extra"→"master" remount.
  const dateForced = resolvedSessionFields?.has(`${kBase}.date`) ?? false;
  const valueForced = resolvedSessionFields?.has(`${kBase}.value`) ?? false;
  const placeForced = resolvedSessionFields?.has(`${kBase}.place`) ?? false;
  const addrForced = resolvedSessionFields?.has(`${kBase}.addr`) ?? false;
  const noteForced = resolvedSessionFields?.has(`${kBase}.note`) ?? false;
  const agencyForced = resolvedSessionFields?.has(`${kBase}.agency`) ?? false;
  // Family rows remount on a real retag (see the `FamilyEventRow` call
  // sites), so the freshly-mounted row can't tell a real retag from this
  // tag having always been here — `markFamilyTagRetagged` flags it instead.
  const tagForced = resolvedSessionFields?.has(`${kBase}.tag`) ?? false;

  const valueField = useField(ev?.value ?? "", valueMergeVal);
  const dateField = useField(ev?.date?.raw ?? "", dateMergeVal);
  const placeField = useField(ev?.place?.raw ?? "", placeMergeVal);
  const addrField = useField(ev?.address?.raw ?? "", addrMergeVal);
  const noteField = useField(ev?.note ?? "", noteMergeVal);
  const agencyField = useField(ev?.agency ?? "", agencyMergeVal);
  // The row stays mounted (same stable key) when its tag changes via
  // `onChangeTag`, so — unlike `useField` — track dirtiness against the tag
  // this row mounted with, not against `ev`'s own value (there's no GedEvent
  // field to compare against).
  const initialTagRef = useRef(tag);
  const tagDirty = tag !== undefined && tag !== initialTagRef.current;
  const [links, setLinks] = useState<string[]>(ev?.links ?? []);
  // Note/Agency(non-title events)/Sources start tucked behind the expand
  // toggle to keep the row compact, but auto-expand if any of them already
  // has content so existing data is never hidden on load.
  const [expanded, setExpanded] = useState(
    () =>
      Boolean(noteField.initial) ||
      (!showValue && Boolean(agencyField.initial)) ||
      (ev?.sources?.length ?? 0) > 0 ||
      (sourcesMergeVal?.length ?? 0) > 0 ||
      links.length > 0,
  );

  function fieldCls(base: string, isMerge: boolean, isDirty: boolean) {
    if (isMerge) return `${base} edit-input--merge`;
    if (isDirty) return `${base} edit-input--dirty`;
    return base;
  }

  function commitLinks(next: string[]) {
    setLinks(next);
    commitField({ links: next.map((l) => l.trim()).filter(Boolean) });
  }

  /** Links have been merged into Sources in the UI: clicking a legacy link's
   * icon opens the same Edit Source dialog, prefilled with just its URL. */
  function openEditLink(index: number) {
    onOpenSourceDialog({
      kind: "edit-link",
      url: links[index],
      commitRename: (url) => commitLinks(links.map((l, i) => (i === index ? url : l))),
      commitRemove: () => commitLinks(links.filter((_, i) => i !== index)),
      commitPromote: (sourceXref, page, extraPatches) => {
        const remaining = links.filter((_, i) => i !== index);
        setLinks(remaining);
        commitField({ links: remaining, addSource: { sourceXref, page } }, extraPatches);
      },
    });
  }

  /**
   * Commit all of this row's current field values together, not just the one
   * that changed. When the row is still an unapplied merge suggestion (`ev`
   * undefined), every field's *displayed* text is its incoming-merge value
   * even though none of it has been written to the record yet — committing
   * only the touched field would silently drop the other still-shown values
   * the moment the event node first comes into existence.
   *
   * Every field's blur (and the place/addr autocomplete's blur-commit) routes
   * through here unconditionally, including a field the user never touched —
   * e.g. tabbing out of a freshly-added event's empty date field to type into
   * its value field instead. If nothing in the row actually differs from what
   * it mounted with, skip the commit: for a still-empty new event, committing
   * here would `applyEventNodeUpdate`-prune it as empty before the user gets a
   * chance to fill in the field they clicked into.
   */
  function commitAll(override: Partial<EventFieldUpdate>) {
    const merged: EventFieldUpdate = {
      date: dateField.value,
      value: valueField.value,
      place: placeField.value,
      address: addrField.value,
      note: noteField.value,
      agency: agencyField.value,
      ...override,
    };
    const unchanged =
      (merged.date ?? "") === dateField.initial &&
      (merged.value ?? "") === valueField.initial &&
      (merged.place ?? "") === placeField.initial &&
      (merged.address ?? "") === addrField.initial &&
      (merged.note ?? "") === noteField.initial &&
      (merged.agency ?? "") === agencyField.initial;
    if (unchanged) return;
    commitField(merged);
  }

  function agencyInput(wrapClassName: string) {
    return (
      <ClearableInput
        wrapClassName={wrapClassName}
        className={fieldCls("edit-input edit-event-agency", agencyField.isMerge, agencyField.isDirty || agencyForced)}
        value={agencyField.value}
        placeholder={t("event.agency", { event: label })}
        title={t("event.agency", { event: label })}
        onChange={agencyField.onChange}
        onBlur={() => commitAll({})}
        onClear={() => { agencyField.clear(); commitAll({ agency: "" }); }}
      />
    );
  }

  return (
    <div className={showValue ? "edit-event edit-event--has-value" : "edit-event"}>
      <div
        className={fieldCls(
          onChangeTag && tag && tagGroups ? "edit-event-label edit-event-label--select" : "edit-event-label",
          false,
          tagDirty || tagForced,
        )}
      >
        {label}
        {onChangeTag && tag && tagGroups && (
          <>
            <span className="edit-event-type-caret" aria-hidden="true">▾</span>
            <select
              className="edit-event-type-select"
              value={tag}
              title={t("edit.changeEventType")}
              onChange={(e) => { if (e.target.value !== tag) onChangeTag(e.target.value); }}
            >
              {tagGroups.map((g, gi) =>
                g.labelKey ? (
                  <optgroup key={g.labelKey} label={t(g.labelKey)}>
                    {g.tags.map((tg) => (
                      <option key={tg} value={tg}>{t(`event.${tg}`)}</option>
                    ))}
                  </optgroup>
                ) : (
                  g.tags.map((tg) => (
                    <option key={`${gi}-${tg}`} value={tg}>{t(`event.${tg}`)}</option>
                  ))
                ),
              )}
            </select>
          </>
        )}
      </div>
      <ClearableInput
        wrapClassName="edit-event-date-cell"
        className={fieldCls("edit-input edit-event-date", dateField.isMerge, dateField.isDirty || dateForced)}
        value={dateField.value}
        placeholder={t("event.date", { event: label })}
        title={t("event.date", { event: label })}
        autoFocus={autoFocusDate}
        onChange={dateField.onChange}
        onBlur={() => commitAll({})}
        onClear={() => { dateField.clear(); commitAll({ date: "" }); }}
      />
      {showValue && (
        <ClearableInput
          wrapClassName="edit-event-value-cell"
          className={fieldCls("edit-input edit-event-value", valueField.isMerge, valueField.isDirty || valueForced)}
          value={valueField.value}
          placeholder={label}
          title={label}
          onChange={valueField.onChange}
          onBlur={() => commitAll({})}
          onClear={() => { valueField.clear(); commitAll({ value: "" }); }}
        />
      )}
      {/* Tab order follows DOM order, not visual position: for title events
       * Agency sits visually right after the title (see CSS), so it must
       * also come right after it here, ahead of Place/Address. */}
      {showValue && agencyInput("edit-event-agency-wrap")}
      <PlaceAutocomplete
        value={placeField.value}
        suggestions={placeSuggestions}
        canonical={placeCanonical}
        isDirty={placeField.isDirty || placeForced}
        isMerge={placeField.isMerge}
        className="edit-input edit-event-place"
        wrapClassName="edit-event-place-cell"
        placeholder={t("event.place", { event: label })}
        title={t("event.place", { event: label })}
        onChange={placeField.set}
        onCommit={(val) => commitAll({ place: val })}
        onClear={() => { placeField.clear(); commitAll({ place: "" }); }}
      />
      <PlaceAutocomplete
        value={addrField.value}
        suggestions={placeToAddrs.get(placeKey(placeField.value)) ?? []}
        canonical={addrCanonical}
        isDirty={addrField.isDirty || addrForced}
        isMerge={addrField.isMerge}
        className="edit-input edit-event-addr"
        wrapClassName="edit-event-addr-cell"
        placeholder={t("event.addr", { event: label })}
        title={t("event.addr", { event: label })}
        onChange={addrField.set}
        onCommit={(val) => commitAll({ address: val })}
        onClear={() => { addrField.clear(); commitAll({ address: "" }); }}
      />
      <button
        type="button"
        className="edit-event-toggle"
        aria-expanded={expanded}
        title={expanded ? t("edit.collapseEvent") : t("edit.expandEvent")}
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? "▾" : "▸"}
      </button>
      {expanded && (
        <>
          <div className="edit-event-extra-sources">
            {ev?.sources?.length || sourcesMergeVal?.length ? (
              <SourceRefs t={t} masterSources={ev?.sources} incomingSources={sourcesMergeVal} onEdit={onEditSource} />
            ) : null}
            {links.map((link, i) => (
              <button
                key={i}
                type="button"
                className="link-icon edit-link-icon"
                title={link}
                onClick={() => openEditLink(i)}
              >
                🔗
              </button>
            ))}
            <button
              type="button"
              className="edit-link-add"
              title={t("event.addSource", { event: label })}
              onClick={onAddSource}
            >
              + {t("edit.addLink")}
            </button>
          </div>
          <ClearableTextarea
            wrapClassName="edit-event-extra-note"
            className={fieldCls("edit-input edit-event-note", noteField.isMerge, noteField.isDirty || noteForced)}
            value={noteField.value}
            placeholder={t("event.note", { event: label })}
            title={t("event.note", { event: label })}
            rows={1}
            onChange={noteField.onChange}
            onBlur={() => commitAll({})}
            onClear={() => { noteField.clear(); commitAll({ note: "" }); }}
          />
          {!showValue && agencyInput("edit-event-extra-agency")}
          {onRemove && (
            <button
              type="button"
              className="edit-event-remove edit-event-extra-remove"
              title={t("edit.removeEvent")}
              onClick={onRemove}
            >
              ×
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** Multi-line notes attached to a person or family record. */
function NotesEditor({
  notes: initialNotes,
  addOnMount,
  addTrigger,
  sectionLabel,
  t,
  onCommit,
}: {
  notes: string[];
  addOnMount?: boolean;
  addTrigger?: number;
  sectionLabel?: string;
  t: Translate;
  onCommit: (notes: string[]) => void;
}) {
  const [notes, setNotes] = useState(() => addOnMount ? [...initialNotes, ""] : initialNotes);
  const prevTrigger = useRef(addTrigger ?? 0);
  const focusNewRef = useRef<number | null>(addOnMount ? initialNotes.length : null);
  const textareaRefs = useRef<(HTMLTextAreaElement | null)[]>([]);

  useEffect(() => {
    if ((addTrigger ?? 0) > prevTrigger.current) {
      setNotes((prev) => { focusNewRef.current = prev.length; return [...prev, ""]; });
    }
    prevTrigger.current = addTrigger ?? 0;
  }, [addTrigger]);

  useEffect(() => {
    if (focusNewRef.current !== null) {
      textareaRefs.current[focusNewRef.current]?.focus();
      focusNewRef.current = null;
    }
  });

  function commitNotes(next: string[]) {
    setNotes(next);
    onCommit(next.map((n) => n.trim()).filter(Boolean));
  }

  return (
    <div className="edit-notes">
      {sectionLabel && (
        <div className="edit-record-label-row">
          <span className="edit-record-label">{sectionLabel}</span>
          <button
            type="button"
            className="edit-name-chip edit-name-chip-add"
            title={t("edit.addNoteTooltip")}
            onClick={() => setNotes((prev) => { focusNewRef.current = prev.length; return [...prev, ""]; })}
          >
            + {t("edit.addNote")}
          </button>
        </div>
      )}
      {notes.map((note, i) => (
        <div className="edit-note-row" key={i}>
          <textarea
            ref={(el) => { textareaRefs.current[i] = el; }}
            className={`edit-input edit-note-input${note.trim() ? " edit-input--dirty" : ""}`}
            value={note}
            placeholder={t("field.notes")}
            rows={2}
            onChange={(e) => setNotes((prev) => prev.map((n, idx) => (idx === i ? e.target.value : n)))}
            onBlur={() => commitNotes(notes)}
          />
          <button
            type="button"
            className="edit-link-remove"
            title={t("edit.removeNote")}
            onClick={() => commitNotes(notes.filter((_, idx) => idx !== i))}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/** A list of single-line link inputs, each removable. When `sectionLabel` is
 * provided it renders its own header row with the label and an add button. */
function LinksEditor({
  links: initialLinks,
  sources,
  incomingLinks,
  sectionLabel,
  t,
  onCommit,
  onAddSource,
  onEditSource,
  onOpenSourceDialog,
  onAttachSource,
}: {
  links: string[];
  /** Real `SOUR` citations added via "Add Source" — shown as icons alongside the legacy links. */
  sources?: SourceCitation[];
  /** Links a confirmed merge will add that aren't in `links` yet — previewed
   * read-only with an incoming-themed background until the merge is saved. */
  incomingLinks?: string[];
  sectionLabel?: string;
  t: Translate;
  onCommit: (links: string[]) => void;
  onAddSource: () => void;
  onEditSource: (index: number) => void;
  onOpenSourceDialog: (target: SourceDialogTarget) => void;
  /** Attaches an already-resolved `SOUR` citation and replaces the link list
   * in one commit — used when a legacy link is promoted to a real citation. */
  onAttachSource: (sourceXref: string, page: string | undefined, extraPatches: RecordPatch[], links: string[]) => void;
}) {
  const [links, setLinks] = useState(initialLinks);
  const existingKeys = new Set(links.map(linkKey));
  const previewLinks = (incomingLinks ?? []).filter((url) => !existingKeys.has(linkKey(url)));

  function commitLinks(next: string[]) {
    setLinks(next);
    onCommit(next.map((l) => l.trim()).filter(Boolean));
  }

  /** Links have been merged into Sources in the UI: clicking a legacy link's
   * icon opens the same Edit Source dialog, prefilled with just its URL. */
  function openEditLink(index: number) {
    onOpenSourceDialog({
      kind: "edit-link",
      url: links[index],
      commitRename: (url) => commitLinks(links.map((l, i) => (i === index ? url : l))),
      commitRemove: () => commitLinks(links.filter((_, i) => i !== index)),
      commitPromote: (sourceXref, page, extraPatches) => {
        const remaining = links.filter((_, i) => i !== index);
        setLinks(remaining);
        onAttachSource(sourceXref, page, extraPatches, remaining);
      },
    });
  }

  return (
    <div className="edit-links">
      {sectionLabel && (
        <div className="edit-record-label-row">
          <span className="edit-record-label">{sectionLabel}</span>
          {sources && sources.length > 0 && <SourceRefs t={t} masterSources={sources} onEdit={onEditSource} />}
          <button
            type="button"
            className="edit-name-chip edit-name-chip-add"
            title={t("edit.addLinkTooltip")}
            onClick={onAddSource}
          >
            + {t("edit.addLink")}
          </button>
        </div>
      )}
      {links.map((link, i) => (
        <button
          key={i}
          type="button"
          className="link-icon edit-link-icon"
          title={link}
          onClick={() => openEditLink(i)}
        >
          🔗
        </button>
      ))}
      {previewLinks.map((url, i) => (
        <a
          key={`merge-${i}`}
          href={linkHref(url)}
          target="_blank"
          rel="noopener noreferrer"
          className="link-icon link-new"
          title={url}
        >
          🔗
        </a>
      ))}
    </div>
  );
}
