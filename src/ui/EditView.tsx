import React, { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { type RecordPatch, type PendingEditApply, cloneRaw } from "./historyTypes";
import { useTranslation } from "react-i18next";
import type { Dataset, Family, GedEvent, Individual, Sex } from "../gedcom/types";
import type { Translate } from "../locales/i18n";
import { datesTooltipOf, lifespanOf } from "../gedcom/lifespan";
import { ADDITIONAL_NAME_TYPES, defaultHomeId, displayName, lifespanLabel, nameTypeLabel, primaryName } from "../match/relatives";
import { kinshipLabel } from "../match/kinship";
import { INDI_EVENT_TAGS } from "../gedcom/builder";
import { dateToSortKey, individualFieldRows, orderedEventTags } from "../review/fields";
import { defaultChoice, type CandidateDecision } from "../review/types";
import {
  addAdditionalName,
  addChild,
  addEventNode,
  addFamilyEventNode,
  addParent,
  addPartner,
  connectExistingChild,
  connectExistingParent,
  connectExistingPartner,
  detachChildFromFamily,
  detachSpouseRole,
  insertRecord,
  rebuildFamily,
  rebuildIndividual,
  removeAdditionalName,
  removeEventAtIndex,
  removeFamilyEvent,
  removeIndividual,
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
  type EventFieldUpdate,
} from "../gedcom/edit";
import { sexClass } from "./sex";
import { HomePersonSelector } from "./HomePersonSelector";
import { PersonCard } from "./PersonCard";

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
  /** When set, shows a Merge button to switch to merge mode. Called with the current person's ID. */
  onMerge?: (currentPersonId: string) => void;
  /** Returns true when the given person ID has a match in the merge list. */
  canMerge?: (id: string) => boolean;
  /** Merge decisions — used to preview incoming values for confirmed matches. */
  decisions?: Map<string, CandidateDecision>;
  /** The incoming dataset — needed to resolve confirmed match incoming values. */
  compareDataset?: Dataset;
  /** Called when an extra merge event is dismissed — sets its fields to "master" in the decision. */
  onUpdateDecision?: (next: CandidateDecision) => void;
  /** Called with each edit's patches so the parent can push to the unified undo stack. */
  onPushEdit: (patches: RecordPatch[], navigateTo?: string, redoNavigateTo?: string) => void;
  /** Called after undo/redo patches are applied so the parent can update dirty tracking. */
  onPatchApplied?: (patches: RecordPatch[], direction: "undo" | "redo") => void;
  /** When non-null, apply these patches and then call onApplied. */
  pendingApply: PendingEditApply | null;
  /** Called after pendingApply has been processed. */
  onApplied: () => void;
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

/** Family events that are hidden until explicitly added (marriage is always shown). */
const FAMILY_HIDDEN_EVENT_TAGS = ["ENGA", "SEPA", "DIV"];

/** A mutation applied to the selected person's raw record, then rebuilt and
 * re-rendered. */
type Commit = (mutate: (indi: Individual) => void) => void;

/** A mutation applied to a family's raw record, then rebuilt and
 * re-rendered. */
type FamilyCommit = (fam: Family, mutate: (fam: Family) => void) => void;

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
  return `${Math.max(len, minLen) + 2}ch`;
}

/** Edit mode's person view: parents on top, the selected person in the
 * center, partners + children on the bottom. The center panel is editable;
 * relatives navigate on click. */
export function EditView({ dataset, fileName, homeId, changeHome, onDirty, onShowTree, navigateToId, onMerge, canMerge, decisions, compareDataset, onUpdateDecision, onPushEdit, onPatchApplied, pendingApply, onApplied }: Props) {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState<string | undefined>(
    () => homeId ?? defaultHomeId(dataset) ?? dataset.individuals.keys().next().value,
  );
  const [history, setHistory] = useState<string[]>([]);
  // Bumped after every edit to force a re-render — the dataset is mutated
  // in place, so React has no other signal that `person` changed.
  const [tick, setTick] = useState(0);
  const focusNextName = useRef(false);
  // Whether the user has clicked "+ Add link" or "+ Add note" for the current person.
  const [linksAdded, setLinksAdded] = useState(false);
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
        else dataset.families.delete(patch.id);
      }
    }
    // Second pass: restore or re-add records.
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
      } else {
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
    setLinksAdded(false);
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

  // T shortcut: open tree for the current person.
  const treeShortcutRef = useRef({ selectedId, onShowTree });
  treeShortcutRef.current = { selectedId, onShowTree };

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() === "t") {
        const { selectedId: id, onShowTree: show } = treeShortcutRef.current;
        if (id) { e.preventDefault(); show(id); }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function navigate(id: string) {
    if (!id || id === selectedId) return;
    if (selectedId) setHistory((h) => [...h, selectedId]);
    setLinksAdded(false);
    setNotesAdded(false);
    setPickingSlot(null);
    setSelectedId(id);
  }

  useEffect(() => {
    if (navigateToId) navigate(navigateToId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigateToId]);

  function goBack() {
    setHistory((h) => {
      if (h.length === 0) return h;
      setSelectedId(h[h.length - 1]);
      return h.slice(0, -1);
    });
  }

  const person = selectedId ? dataset.individuals.get(selectedId) : undefined;

  /** Merge preview data for the currently selected person's confirmed match. */
  const mergeData = useMemo(() => {
    const empty = {
      mergeHighlight: new Map<string, string>(),
      /** master person.events overall index → field key base aligned with orderedEventTags. */
      masterMergeKeyBases: new Map<number, string>(),
      /** master person.events overall index → sort key from incoming date, when master has no date. */
      masterMergeSortKeys: new Map<number, number>(),
      /** Incoming-only events with no master counterpart (BIRT excluded — always shown). */
      extraMergeEvents: [] as { tag: string; keyBase: string; sortKey: number }[],
    };
    if (!decisions || !compareDataset || !person) return empty;
    for (const [key, dec] of decisions) {
      if (dec.status !== "confirmed") continue;
      const parts = key.split(":");
      if (parts.length !== 3 || parts[0] !== "individual" || parts[1] !== person.id) continue;
      const incoming = compareDataset.individuals.get(parts[2]);
      if (!incoming) continue;

      // Field key → incoming value for all fields the merge will add/change.
      const rows = individualFieldRows(t, person, incoming, dataset, compareDataset);
      const mergeHighlight = new Map<string, string>();
      for (const row of rows) {
        if (row.isGroupHeader || !row.incoming) continue;
        if (row.state === "agree" || row.state === "master-only") continue;
        const choice = dec.fields[row.key] ?? defaultChoice(row);
        if (choice !== "master") mergeHighlight.set(row.key, row.incoming);
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
      const masterMergeSortKeys = new Map<number, number>();
      const extraMergeEvents: { tag: string; keyBase: string; sortKey: number }[] = [];
      const EVENT_SUBS = ["date", "place", "addr", "value"] as const;

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
          if (EVENT_SUBS.some((s) => mergeHighlight.has(`${keyBase}.${s}`))) {
            const incomingEv = inst.compareIdx >= 0 ? cByTag.get(inst.tag)?.[inst.compareIdx] : undefined;
            extraMergeEvents.push({ tag: inst.tag, keyBase, sortKey: dateToSortKey(incomingEv?.date) });
          }
        }
      }

      return { mergeHighlight, masterMergeKeyBases, masterMergeSortKeys, extraMergeEvents };
    }
    return empty;
  }, [decisions, compareDataset, person, dataset, t, tick]);

  const { mergeHighlight, masterMergeKeyBases, masterMergeSortKeys, extraMergeEvents } = mergeData;

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
      const EVENT_SUBS = ["date", "place", "addr", "value"] as const;
      for (const sub of EVENT_SUBS) {
        const fkey = `${keyBase}.${sub}`;
        if (mergeHighlight?.has(fkey)) updatedFields[fkey] = "master";
      }
      onUpdateDecision({ ...dec, fields: updatedFields });
      break;
    }
  }

  const commit: Commit = (mutate) => {
    if (!person) return;
    const before = cloneRaw(person.raw);
    mutate(person);
    const after = cloneRaw(person.raw);
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    rebuildIndividual(dataset, person);
    onPushEdit([{ type: "individual", id: person.id, before, after }], selectedId);
    onDirty("individual", person.id);
    setTick((v) => v + 1);
  };

  const commitFamily: FamilyCommit = (fam, mutate) => {
    const before = cloneRaw(fam.raw);
    mutate(fam);
    const after = cloneRaw(fam.raw);
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    rebuildFamily(dataset, fam);
    onPushEdit([{ type: "family", id: fam.id, before, after }], selectedId);
    onDirty("family", fam.id);
    setTick((v) => v + 1);
  };

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
    setLinksAdded(false);
    setNotesAdded(false);
    setSelectedId(nextId);
    if (personId === homeId) changeHome(nextId);
    setTick((v) => v + 1);
  }

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

  const { placeSuggestions, placeToAddrs, placeCanonical, addrCanonical } = useMemo(
    () => buildPlaceSuggestions(dataset),
    [dataset],
  );

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

  return (
    <div className="section open edit-view">
      <div className="section-body">
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
          <HomePersonSelector
            individuals={dataset.individuals}
            homeId={homeId}
            onChange={changeHome}
            onClear={() => changeHome(undefined)}
          />
          <div className="toolbar-end">
            <button
              className="tree-open-btn"
              onClick={() => selectedId && onShowTree(selectedId)}
              title={t("edit.tree.tooltip")}
            >
              {t("edit.tree.button")}
            </button>
            {onMerge && selectedId && canMerge?.(selectedId) && (
              <button
                className="tree-open-btn"
                onClick={() => onMerge(selectedId)}
                title={t("edit.mergeTooltip")}
              >
                {t("edit.mergeButton")}
              </button>
            )}
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
            showAddLink={!linksAdded && !(person.links ?? []).length}
            onAddLink={() => setLinksAdded(true)}
            showAddNote={!notesAdded && !(person.notes ?? []).length}
            onAddNote={() => setNotesAdded(true)}
          />
          <EventList
            key={person.id}
            person={person}
            t={t}
            commit={commit}
            placeSuggestions={placeSuggestions}
            placeToAddrs={placeToAddrs}
            placeCanonical={placeCanonical}
            addrCanonical={addrCanonical}
            mergeHighlight={mergeHighlight}
            masterMergeKeyBases={masterMergeKeyBases}
            masterMergeSortKeys={masterMergeSortKeys}
            extraMergeEvents={extraMergeEvents}
            onDismissExtraEvent={dismissExtraEvent}
            pendingFocusNodeId={pendingFocusEventNodeId}
            undoVersion={undoVersion}
          />
          {((person.links ?? []).length > 0 || linksAdded) && (
            <div className="edit-record-section">
              <LinksEditor
                key={`rlinks-${person.id}-${undoVersion}`}
                links={person.links ?? []}
                addOnMount={linksAdded && !(person.links ?? []).length}
                sectionLabel={t("field.links")}
                label={t("field.links")}
                t={t}
                onCommit={(links) => commit((indi) => setIndividualLinks(indi, links))}
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
            const shownFamilyTags = FAMILY_HIDDEN_EVENT_TAGS.filter(
              (tag) => fam?.events.some((e) => e.tag === tag),
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
                      />
                    )}
                    {fam && (
                      <AddEventSelect
                        tags={emptyFamilyTags}
                        label={t("edit.addFamilyEvent")}
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
                {fam && <FamilyEventRow key={`${fam.id}-MARR-${undoVersion}`} fam={fam} tag="MARR" t={t} commit={commitFamily} onRemove={fam.events.some((e) => e.tag === "MARR") ? () => commitFamily(fam, (f) => removeFamilyEvent(f, "MARR")) : undefined} placeSuggestions={placeSuggestions} placeToAddrs={placeToAddrs} placeCanonical={placeCanonical} addrCanonical={addrCanonical} />}
                {fam && shownFamilyTags.map((tag) => (
                  <FamilyEventRow key={`${fam.id}-${tag}-${undoVersion}`} fam={fam} tag={tag} t={t} commit={commitFamily} autoFocusDate={pendingFocusFamEventKey === `${fam.id}-${tag}`} onRemove={() => commitFamily(fam, (f) => removeFamilyEvent(f, tag))} placeSuggestions={placeSuggestions} placeToAddrs={placeToAddrs} placeCanonical={placeCanonical} addrCanonical={addrCanonical} />
                ))}
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
    <div ref={containerRef} className="place-autocomplete-wrap" onBlur={handleBlur}>
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
}: {
  person: Individual;
  t: Translate;
  lifespan?: string;
  commit: Commit;
  focusOnMount?: boolean;
  onMounted?: () => void;
  mergeHighlight?: Map<string, string>;
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
    </div>
  );
}

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
            <button type="button" className="edit-name-chip" onClick={() => setEditing("nick")}>
              {primary.nickname}
              <span className="muted"> ({nameTypeLabel("nick", t)})</span>
            </button>
          ) : null}
          {extraNames.map((n, i) =>
            editing === i ? (
              <NameVariantEditor key={i} person={person} index={i} t={t} commit={commit} onDone={() => setEditing(null)} />
            ) : (
              <button type="button" className="edit-name-chip" key={i} onClick={() => setEditing(i)}>
                {displayName(n)}
                {n.type && <span className="muted"> ({nameTypeLabel(n.type, t)})</span>}
              </button>
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
  placeSuggestions,
  placeToAddrs,
  placeCanonical,
  addrCanonical,
  mergeHighlight,
  masterMergeKeyBases,
  masterMergeSortKeys,
  extraMergeEvents,
  onDismissExtraEvent,
  pendingFocusNodeId,
  undoVersion,
}: {
  person: Individual;
  t: Translate;
  commit: Commit;
  placeSuggestions: string[];
  placeToAddrs: Map<string, string[]>;
  placeCanonical: Map<string, string>;
  addrCanonical: Map<string, string>;
  mergeHighlight?: Map<string, string>;
  /** master person.events[i] → field key base aligned with orderedEventTags. */
  masterMergeKeyBases?: Map<number, string>;
  /** master person.events[i] → sort key from incoming date, when master has no date. */
  masterMergeSortKeys?: Map<number, number>;
  /** Incoming-only events, each carrying a date-based sort key for interleaving. */
  extraMergeEvents?: { tag: string; keyBase: string; sortKey: number }[];
  /** Called when an extra merge event is dismissed, to update the merge decision. */
  onDismissExtraEvent?: (keyBase: string) => void;
  pendingFocusNodeId?: number | null;
  undoVersion?: number;
}) {
  const birtEv = person.events.find((e) => e.tag === "BIRT");

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
  type MasterRow  = { kind: "master"; ev: GedEvent; i: number; mergeKeyBase: string; stableKey: number };
  type ExtraRow   = { kind: "extra";  tag: string; keyBase: string };
  type AnyRow     = (MasterRow | ExtraRow) & { sortKey: number; tagPos: number };

  // Raw event nodes in the same order as person.events — used for stable WeakMap keys.
  const rawEventNodes = person.raw.children.filter((c) => INDI_EVENT_TAGS.has(c.tag));

  const allRows: AnyRow[] = [
    ...person.events
      .map((ev, i) => ({ ev, i }))
      .filter(({ ev }) => ev.tag !== "BIRT")
      .map(({ ev, i }): AnyRow => ({
        kind: "master",
        ev, i,
        mergeKeyBase: masterMergeKeyBases?.get(i) ?? eventKeyBases[i],
        stableKey: nodeId(rawEventNodes[i] ?? ev),
        sortKey: masterMergeSortKeys?.get(i) ?? dateToSortKey(ev.date),
        tagPos: EXTRA_EVENT_ORDER.indexOf(ev.tag),
      })),
    ...(extraMergeEvents ?? [])
      .map(({ tag, keyBase, sortKey }): AnyRow => ({
        kind: "extra",
        tag, keyBase,
        sortKey,
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
        <span>{t("event.colLink")}</span>
      </div>
      <EventFieldsRow
        key={`${person.id}-BIRT-${undoVersion ?? 0}`}
        ev={birtEv}
        label={t("event.BIRT")}
        tag="BIRT"
        t={t}
        commitField={(update) => commit((indi) => setEventField(indi, "BIRT", update))}
        onRemove={birtOriginalIdx >= 0 ? () => commit((indi) => removeEventAtIndex(indi, birtOriginalIdx)) : undefined}
        placeSuggestions={placeSuggestions}
        placeToAddrs={placeToAddrs}
        placeCanonical={placeCanonical}
        addrCanonical={addrCanonical}
        mergeHighlight={mergeHighlight}
        mergeKeyBase={birtMergeKeyBase}
      />
      {allRows.map((row) =>
        row.kind === "master" ? (
          <EventFieldsRow
            key={`ev-${row.stableKey}`}
            ev={row.ev}
            label={t(`event.${row.ev.tag}`)}
            tag={row.ev.tag}
            t={t}
            commitField={(update) => commit((indi) => setEventFieldAtIndex(indi, row.i, update))}
            onRemove={() => commit((indi) => removeEventAtIndex(indi, row.i))}
            autoFocusDate={row.stableKey === pendingFocusNodeId}
            placeSuggestions={placeSuggestions}
            placeToAddrs={placeToAddrs}
            placeCanonical={placeCanonical}
            addrCanonical={addrCanonical}
            mergeHighlight={mergeHighlight}
            mergeKeyBase={row.mergeKeyBase}
          />
        ) : (
          <EventFieldsRow
            key={`${person.id}-merge-${row.keyBase}`}
            ev={undefined}
            label={t(`event.${row.tag}`)}
            tag={row.tag}
            t={t}
            commitField={(update) => commit((indi) => setEventField(indi, row.tag, update))}
            onRemove={() => onDismissExtraEvent?.(row.keyBase)}
            placeSuggestions={placeSuggestions}
            placeToAddrs={placeToAddrs}
            placeCanonical={placeCanonical}
            addrCanonical={addrCanonical}
            mergeHighlight={mergeHighlight}
            mergeKeyBase={row.keyBase}
          />
        ),
      )}
    </div>
  );
}

/** Any family event row (MARR, DIV, ENGA, SEPA, …) by tag. */
function FamilyEventRow({
  fam, tag, t, commit, onRemove, autoFocusDate,
  placeSuggestions, placeToAddrs, placeCanonical, addrCanonical,
}: {
  fam: Family; tag: string; t: Translate; commit: FamilyCommit;
  onRemove?: () => void;
  autoFocusDate?: boolean;
  placeSuggestions: string[];
  placeToAddrs: Map<string, string[]>;
  placeCanonical: Map<string, string>;
  addrCanonical: Map<string, string>;
}) {
  const ev = fam.events.find((e) => e.tag === tag);
  const label = t(`event.${tag}`);

  return (
    <EventFieldsRow
      ev={ev}
      label={label}
      tag={tag}
      t={t}
      commitField={(update) => commit(fam, (f) => setFamilyEventField(f, tag, update))}
      onRemove={onRemove}
      autoFocusDate={autoFocusDate}
      placeSuggestions={placeSuggestions}
      placeToAddrs={placeToAddrs}
      placeCanonical={placeCanonical}
      addrCanonical={addrCanonical}
    />
  );
}

/** Dropdown chip that adds an event tag from a list of available tags.
 * Resets to the placeholder after selection. */
function AddEventSelect({
  tags,
  groups,
  label,
  t,
  onAdd,
  className = "add-chip add-chip-select",
}: {
  tags?: string[];
  groups?: { labelKey: string; tags: string[] }[];
  label: string;
  t: Translate;
  onAdd: (tag: string) => void;
  className?: string;
}) {
  const [value, setValue] = useState("");
  const hasAny = tags?.length || groups?.some((g) => g.tags.length);
  if (!hasAny) return null;
  return (
    <label className={className}>
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
    /** True when the current value still equals the unedited merge-incoming value. */
    isMerge: mergeInitial !== undefined && value === mergeInitial,
    isDirty: value !== init.current,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setValue(e.target.value),
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
  autoFocusDate,
  placeSuggestions,
  placeToAddrs,
  placeCanonical,
  addrCanonical,
  mergeHighlight,
  mergeKeyBase,
}: {
  ev: GedEvent | undefined;
  label: string;
  tag?: string;
  t: Translate;
  commitField: (update: EventFieldUpdate) => void;
  onRemove?: () => void;
  autoFocusDate?: boolean;
  placeSuggestions: string[];
  placeToAddrs: Map<string, string[]>;
  placeCanonical: Map<string, string>;
  addrCanonical: Map<string, string>;
  mergeHighlight?: Map<string, string>;
  mergeKeyBase?: string;
}) {
  const showValue = tag !== undefined && VALUE_EVENT_TAGS.has(tag);

  // Compute merge values before hooks so they can be used as initial state.
  const kBase = mergeKeyBase ?? tag ?? "";
  const dateMergeVal = mergeHighlight?.get(`${kBase}.date`);
  const valueMergeVal = showValue ? mergeHighlight?.get(`${kBase}.value`) : undefined;
  const placeMergeVal = mergeHighlight?.get(`${kBase}.place`);
  const addrMergeVal = mergeHighlight?.get(`${kBase}.addr`);
  const noteMergeVal = mergeHighlight?.get(`${kBase}.note`);

  const valueField = useField(ev?.value ?? "", valueMergeVal);
  const dateField = useField(ev?.date?.raw ?? "", dateMergeVal);
  const placeField = useField(ev?.place?.raw ?? "", placeMergeVal);
  const addrField = useField(ev?.address?.raw ?? "", addrMergeVal);
  const noteField = useField(ev?.note ?? "", noteMergeVal);
  const [links, setLinks] = useState<string[]>(ev?.links ?? []);
  const linkFocusRef = useRef<number | null>(null);
  const linkInputRefs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    if (linkFocusRef.current !== null) {
      linkInputRefs.current[linkFocusRef.current]?.focus();
      linkFocusRef.current = null;
    }
  });

  function fieldCls(base: string, isMerge: boolean, isDirty: boolean) {
    if (isMerge) return `${base} edit-input--merge`;
    if (isDirty) return `${base} edit-input--dirty`;
    return base;
  }

  function commitLinks(next: string[]) {
    setLinks(next);
    commitField({ links: next.map((l) => l.trim()).filter(Boolean) });
  }

  return (
    <div className={showValue ? "edit-event edit-event--has-value" : "edit-event"}>
      <div className="edit-event-label">{label}</div>
      <ClearableInput
        className={fieldCls("edit-input edit-event-date", dateField.isMerge, dateField.isDirty)}
        value={dateField.value}
        placeholder={t("event.date", { event: label })}
        title={t("event.date", { event: label })}
        autoFocus={autoFocusDate}
        onChange={dateField.onChange}
        onBlur={() => commitField({ date: dateField.value })}
        onClear={() => { dateField.clear(); commitField({ date: "" }); }}
      />
      {showValue && (
        <ClearableInput
          className={fieldCls("edit-input edit-event-value", valueField.isMerge, valueField.isDirty)}
          value={valueField.value}
          placeholder={label}
          title={label}
          onChange={valueField.onChange}
          onBlur={() => commitField({ value: valueField.value })}
          onClear={() => { valueField.clear(); commitField({ value: "" }); }}
        />
      )}
      <PlaceAutocomplete
        value={placeField.value}
        suggestions={placeSuggestions}
        canonical={placeCanonical}
        isDirty={placeField.isDirty}
        isMerge={placeField.isMerge}
        className="edit-input edit-event-place"
        placeholder={t("event.place", { event: label })}
        title={t("event.place", { event: label })}
        onChange={placeField.set}
        onCommit={(val) => commitField({ place: val })}
        onClear={() => { placeField.clear(); commitField({ place: "" }); }}
      />
      <PlaceAutocomplete
        value={addrField.value}
        suggestions={placeToAddrs.get(placeKey(placeField.value)) ?? []}
        canonical={addrCanonical}
        isDirty={addrField.isDirty}
        isMerge={addrField.isMerge}
        className="edit-input edit-event-addr"
        placeholder={t("event.addr", { event: label })}
        title={t("event.addr", { event: label })}
        onChange={addrField.set}
        onCommit={(val) => commitField({ address: val })}
        onClear={() => { addrField.clear(); commitField({ address: "" }); }}
      />
      {(noteField.value || noteField.isMerge) && (
        <ClearableInput
          className={fieldCls("edit-input edit-event-note", noteField.isMerge, noteField.isDirty)}
          value={noteField.value}
          placeholder={t("event.note", { event: label })}
          title={t("event.note", { event: label })}
          onChange={noteField.onChange}
          onBlur={() => commitField({ note: noteField.value })}
          onClear={() => { noteField.clear(); commitField({ note: "" }); }}
        />
      )}
      <div className="edit-event-actions">
        <button
          type="button"
          className="edit-link-add"
          onClick={() => setLinks((prev) => { linkFocusRef.current = prev.length; return [...prev, ""]; })}
        >
          + {t("edit.addLink")}
        </button>
        {onRemove && (
          <button
            type="button"
            className="edit-event-remove"
            title={t("edit.removeEvent")}
            onClick={onRemove}
          >
            ×
          </button>
        )}
      </div>
      {links.map((link, i) => (
        <div className="edit-event-link-row" key={i}>
          {link.trim() && (
            <a
              className="edit-link-open"
              href={link.trim()}
              target="_blank"
              rel="noopener noreferrer"
              title={t("edit.openLink")}
            >
              ↗
            </a>
          )}
          <div className="edit-link-input-wrap">
            <input
              ref={(el) => { linkInputRefs.current[i] = el; }}
              className={`edit-input edit-link-input${link.trim() ? " edit-input--dirty" : ""}`}
              value={link}
              placeholder={t("event.link", { event: label })}
              title={t("event.link", { event: label })}
              onChange={(e) => setLinks((prev) => prev.map((l, idx) => (idx === i ? e.target.value : l)))}
              onBlur={() => commitLinks(links)}
            />
            <button
              type="button"
              className="edit-link-remove"
              title={t("edit.removeLink")}
              onClick={() => commitLinks(links.filter((_, idx) => idx !== i))}
            >
              ×
            </button>
          </div>
        </div>
      ))}
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
  addOnMount,
  sectionLabel,
  label,
  t,
  onCommit,
}: {
  links: string[];
  addOnMount?: boolean;
  sectionLabel?: string;
  label: string;
  t: Translate;
  onCommit: (links: string[]) => void;
}) {
  const [links, setLinks] = useState(() => addOnMount ? [...initialLinks, ""] : initialLinks);
  const focusNewRef = useRef<number | null>(addOnMount ? initialLinks.length : null);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    if (focusNewRef.current !== null) {
      inputRefs.current[focusNewRef.current]?.focus();
      focusNewRef.current = null;
    }
  });

  function commitLinks(next: string[]) {
    setLinks(next);
    onCommit(next.map((l) => l.trim()).filter(Boolean));
  }

  return (
    <div className="edit-links">
      {sectionLabel && (
        <div className="edit-record-label-row">
          <span className="edit-record-label">{sectionLabel}</span>
          <button
            type="button"
            className="edit-name-chip edit-name-chip-add"
            title={t("edit.addLinkTooltip")}
            onClick={() => setLinks((prev) => { focusNewRef.current = prev.length; return [...prev, ""]; })}
          >
            + {t("edit.addLink")}
          </button>
        </div>
      )}
      {links.map((link, i) => (
        <div className="edit-link-row" key={i}>
          {link.trim() && (
            <a
              className="edit-link-open"
              href={link.trim()}
              target="_blank"
              rel="noopener noreferrer"
              title={t("edit.openLink")}
            >
              ↗
            </a>
          )}
          <div className="edit-link-input-wrap">
            <input
              ref={(el) => { inputRefs.current[i] = el; }}
              className={`edit-input edit-link-input${link.trim() ? " edit-input--dirty" : ""}`}
              value={link}
              placeholder={t("event.link", { event: label })}
              title={t("event.link", { event: label })}
              onChange={(e) => setLinks((prev) => prev.map((l, idx) => (idx === i ? e.target.value : l)))}
              onBlur={() => commitLinks(links)}
            />
            <button
              type="button"
              className="edit-link-remove"
              title={t("edit.removeLink")}
              onClick={() => commitLinks(links.filter((_, idx) => idx !== i))}
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
