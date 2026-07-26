import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { childrenByTag } from "../../gedcom/node";
import type { Dataset, GedNode, Individual, SourceCitation } from "../../gedcom/types";
import type { Translate } from "../../locales/i18n";
import { materializeEventSources } from "../../merge/merge";
import { familyMergeKeyBases, individualFieldRows, lifespanAnchors, orderedEventTags, zoneSortKey } from "../../review/fields";
import { defaultChoice, findConfirmedDecision, type CandidateDecision } from "../../review/types";
import { cloneRaw, type RecordPatch } from "../historyTypes";
import { useStableHandler } from "./useStableHandler";

/** The merge overlay's state when the selected person has no confirmed match. */
const EMPTY_MERGE_DATA = Object.freeze({
  /** Field key -> incoming value for all fields the merge will add/change. */
  mergeHighlight: new Map<string, string>(),
  /** Field key -> incoming links the merge will add (record-level "links" row). */
  mergeIncomingLinks: new Map<string, string[]>(),
  /** Field key -> incoming source citations the merge will add (per-event "<tag>.sources" rows). */
  mergeIncomingSources: new Map<string, SourceCitation[]>(),
  /** main person.events overall index -> field key base aligned with orderedEventTags. */
  mainMergeKeyBases: new Map<number, string>(),
  /** main person.events overall index -> the incoming event it's paired with, as
   * `${tag}:${compareIdx}` - see `CandidateDecision.rejectedEvents`. Lets deleting a
   * paired main event also reject its incoming counterpart, so it isn't silently
   * re-added on save. */
  mainMergeCompareKeys: new Map<number, string>(),
  /** main person.events overall index -> sort key from incoming date, when main has no date. */
  mainMergeSortKeys: new Map<number, number>(),
  /** Incoming-only events with no main counterpart (BIRT excluded - always shown). */
  extraMergeEvents: [] as { tag: string; keyBase: string; sortKey: number; compareIdx: number }[],
  /** main family id -> the `fam.<id>` key base used for that family's rows
   * in `mergeHighlight`/`mergeIncomingSources` (see `familyMergeKeyBases`). */
  familyMergeKeyBases: new Map<string, string>(),
  /** Whether the current person still has a confirmed merge decision. */
  hasMergeDecision: false,
});

interface Options {
  /** The person Edit is showing; undefined clears the overlay. */
  person: Individual | undefined;
  /** Re-selection resets the per-person session marks. */
  selectedId: string | undefined;
  dataset: Dataset;
  compareDataset: Dataset | undefined;
  decisions: Map<string, CandidateDecision> | undefined;
  onUpdateDecision: ((key: string, next: CandidateDecision) => void) | undefined;
  /** Bumped on every committed edit, so displayed merge values stay current. */
  tick: number;
  t: Translate;
}

/**
 * Everything Edit mode needs to overlay a confirmed merge onto the person on
 * screen: which fields the merge would add or change, which incoming events
 * have no main counterpart, and the handlers that resolve or reject them.
 *
 * Extracted from EditView so the merge overlay is one unit rather than ~290
 * lines interleaved with the media and source-dialog code. Every write path
 * goes through `confirmedFor`, and `mergeData` resolves the decision the same
 * way, so the preview and the handlers can never target different incoming
 * records (the bug fixed in a238d34).
 */
export function useMergeOverlay({
  person, selectedId, dataset, compareDataset, decisions, onUpdateDecision, tick, t,
}: Options) {
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
    if (!decisions || !compareDataset || !person) return EMPTY_MERGE_DATA;
    // Same selection rule as every write path below (see `confirmedFor`), so
    // the preview and the handlers can never target different incoming records.
    const found = findConfirmedDecision(decisions, person.id, (id) => compareDataset.individuals.get(id));
    if (found) {
      const dec = found.decision;
      const incoming = compareDataset.individuals.get(found.compareId);
      if (!incoming) return EMPTY_MERGE_DATA;
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
    return EMPTY_MERGE_DATA;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decisions, compareDataset, person, dataset, t, tick]); // tick is a cache-bust counter — not used directly but must invalidate the memo

  // Only the pieces the handlers below read; the rest is spread to the caller.
  const { mergeHighlight, mergeIncomingSources, hasMergeDecision } = mergeData;

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
   * The confirmed decision the merge UI on this screen is acting on. Every
   * write path below goes through this, and `mergeData` above resolves it the
   * same way — so what the preview shows and what the handlers mutate are
   * always the same decision entry, even when a main id happens to carry more
   * than one (see `findConfirmedDecision`).
   */
  const confirmedFor = useStableHandler(() =>
    person
      ? findConfirmedDecision(decisions, person.id, (id) => compareDataset?.individuals.get(id))
      : undefined,
  );

  /**
   * Reject an incoming individual event outright — called when the user
   * deletes its paired main event, deletes/dismisses an unmatched "extra"
   * suggestion row, or edits an extra row's field (materializing a new main
   * event from it). Persists into the confirmed decision's `rejectedEvents`
   * (see `CandidateDecision`) so the event is treated as absent everywhere —
   * the live preview here and the merge engine on Save — for the rest of the
   * session, regardless of how main/incoming pairing reshuffles afterward.
   */
  const rejectIncomingEvent = useStableHandler((tag: string, compareIdx: number) => {
    if (!onUpdateDecision || compareIdx < 0) return;
    const found = confirmedFor();
    if (!found) return;
    const { key, decision: dec } = found;
    const eventKey = `${tag}:${compareIdx}`;
    if (dec.rejectedEvents?.includes(eventKey)) return;
    onUpdateDecision(key, { ...dec, rejectedEvents: [...(dec.rejectedEvents ?? []), eventKey] });
  });

  /**
   * Copy an "extra" incoming-only event's `SOUR` citations into `eventNode`
   * — the main event a direct field edit just materialized for it. Must
   * run before that event gets `rejectIncomingEvent`'d, since afterward its
   * sources are gone from comparison everywhere, including the merge engine
   * on Save. Returns undo patches for any `SOUR`/`REPO` records it imported.
   */
  const materializeMergeEventSources = useStableHandler((eventNode: GedNode, tag: string, compareIdx: number): RecordPatch[] => {
    if (!compareDataset || compareIdx < 0) return [];
    const found = confirmedFor();
    if (!found) return [];
    const incoming = compareDataset.individuals.get(found.compareId);
    if (!incoming) return [];
    const incEvent = childrenByTag(incoming.raw, tag)[compareIdx];
    if (!incEvent) return [];
    const imported = materializeEventSources(dataset, compareDataset, eventNode, incEvent);
    return imported.map((r) => ({ type: "record" as const, id: r.xref!, before: null, after: cloneRaw(r) }));
  });

  const dismissExtraEvent = useStableHandler((keyBase: string) => {
    if (!onUpdateDecision) return;
    const found = confirmedFor();
    if (!found) return;
    const { key, decision: dec } = found;
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
  });

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
  const resolveMergeFields = useStableHandler((keyBase: string, forcedId: string, subs: string[]) => {
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
    if (!onUpdateDecision) return;
    const found = confirmedFor();
    if (!found) return;
    const { key, decision: dec } = found;
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
  });

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
  const markFamilyTagRetagged = useStableHandler((keyBase: string, newTag: string) => {
    const key = `${keyBase}.${newTag}.tag`;
    setResolvedSessionFields((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
  });
  return {
    ...mergeData,
    /** Bumped only when `decisions` itself changes - see the ref's comment. */
    mergeGen: mergeGenRef.current,
    resolvedSessionFields,
    materializedEventIds,
    markMaterializedEvent,
    rejectIncomingEvent,
    materializeMergeEventSources,
    dismissExtraEvent,
    resolveMergeFields,
    markFamilyTagRetagged,
  };
}

