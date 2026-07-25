import type { Individual, GedEvent, GedNode, SourceCitation, GeoCoord } from "../../gedcom/types";
import type { Translate } from "../../locales/i18n";
import type { RecordPatch } from "../historyTypes";
import type { EventFieldUpdate } from "../../gedcom/edit";
import { addEventField, removeEventAtIndex, setEventField, setEventFieldAtIndex, changeEventTagAtIndex } from "../../gedcom/edit";
import { INDI_EVENT_TAGS } from "../../gedcom/eventTags";
import { birthDateOf } from "../../gedcom/lifespan";
import { ageBetween, fullAgeBetween } from "../../gedcom/age";
import { lifespanAnchors, zoneSortKey } from "../../review/fields";
import { useSettings } from "../SettingsContext";
import { EventFieldsRow } from "./EventFieldsRow";
import { memo } from "react";
import { nodeId } from "./nodeId";
import { EXTRA_EVENT_ORDER, INDIVIDUAL_EVENT_GROUPS, ASSIGNABLE_EVENT_TAGS } from "./editConstants";
import type { Commit, OpenEditSource, SourceDialogTarget } from "./types";

/** Events grid: BIRT always first (creates on commit), then all other events
 * in person.events order — multiple occurrences of the same tag are supported.
 * When mergeHighlight is set, merge-highlighted fields are shown and extra incoming-only
 * events are appended at the end.
 *
 * Memoized: `person` is replaced by `rebuildIndividual` on each of their own
 * edits, so its identity is the change signal — a family-side commit (same
 * `tick` bump in EditView) leaves every prop identical and skips the whole
 * grid rebuild + sort. Requires all function props to be identity-stable
 * (EditView's `useStableHandler`). */
export const EventList = memo(function EventList({
  person,
  t,
  commit,
  openEditSource,
  onOpenSourceDialog,
  placeSuggestions,
  placeToAddrs,
  placeCanonical,
  addrCanonical,
  placeCoords,
  pairCoords,
  mergeHighlight,
  mergeIncomingSources,
  mainMergeKeyBases,
  mainMergeCompareKeys,
  mainMergeSortKeys,
  extraMergeEvents,
  onRejectIncomingEvent,
  onMaterializeIncomingSources,
  onResolveMergeField,
  resolvedSessionFields,
  materializedEventIds,
  onMaterializeEventNode,
  pendingFocusNodeId,
  undoVersion,
  mergeGen,
  birthParentAges,
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
  /** Coordinate the file already uses for a place (settlement-level). */
  placeCoords: Map<string, GeoCoord>;
  /** Coordinate for a specific place+address pair (the house). */
  pairCoords: Map<string, GeoCoord>;
  mergeHighlight?: Map<string, string>;
  /** Field key (e.g. "BIRT.sources") → incoming source citations the merge will add. */
  mergeIncomingSources?: Map<string, SourceCitation[]>;
  /** main person.events[i] → field key base aligned with orderedEventTags. */
  mainMergeKeyBases?: Map<number, string>;
  /** main person.events[i] → the incoming event it's paired with, as `${tag}:${compareIdx}`. */
  mainMergeCompareKeys?: Map<number, string>;
  /** main person.events[i] → sort key from incoming date, when main has no date. */
  mainMergeSortKeys?: Map<number, number>;
  /** Incoming-only events, each carrying a date-based sort key for interleaving. */
  extraMergeEvents?: { tag: string; keyBase: string; sortKey: number; compareIdx: number }[];
  /** Called to permanently reject an incoming event — dismissing/deleting an
   * "extra" suggestion row, deleting a main row paired with one, or editing
   * an extra row's field (materializing a new main event from it) — so it's
   * treated as absent for the rest of the session, on Save too (see
   * `rejectIncomingEvent`). */
  onRejectIncomingEvent?: (tag: string, compareIdx: number) => void;
  /** Called when an "extra" row's direct field edit is about to materialize a
   * new main event, to copy that incoming event's `SOUR` citations onto the
   * just-created node before it's rejected (see `onRejectIncomingEvent`) and
   * its sources become unreachable. Returns undo patches for any imported
   * top-level `SOUR`/`REPO` records. */
  onMaterializeIncomingSources?: (eventNode: GedNode, tag: string, compareIdx: number) => RecordPatch[];
  /** Called after a direct field edit, to resolve the touched merge sub-fields
   * (e.g. "date", "value") to "main" so they stop being treated as pending
   * incoming suggestions. `forcedId` is the row's stable per-event identity
   * (used to persist the dirty/bold marker), distinct from the volatile
   * `keyBase` (used for the incoming-value lookup / decision choice). */
  onResolveMergeField?: (keyBase: string, forcedId: string, subs: string[]) => void;
  /** Sub-field keys (e.g. "OCCU.value") resolved from a merge suggestion via a
   * direct edit earlier this session — kept dirty/bold despite the row's
   * one-time remount from "extra" to "main" kind. */
  resolvedSessionFields?: Set<string>;
  /** Stable `nodeId`s of events materialized this session from an incoming-only
   * suggestion — every field of such an event renders bold (it's all new vs the
   * saved main). Survives merge-state recomputes, unlike `resolvedSessionFields`. */
  materializedEventIds?: Set<number>;
  /** Record an event node (by `nodeId`) as freshly materialized from a merge suggestion. */
  onMaterializeEventNode?: (id: number) => void;
  pendingFocusNodeId?: number | null;
  undoVersion?: number;
  /** Bumped whenever the confirmed-match merge preview recomputes; folded into
   * row keys so a row already mounted before a match was confirmed remounts
   * and picks up the now-available incoming values (see `mergeGenRef`). */
  mergeGen?: number;
  /** Parents' ages at this person's birth ("♂32" "♀28" badges, each with a
   * full-precision tooltip), shown on the BIRT row when "Show ages" is on. */
  birthParentAges?: { text: string; title: string }[];
}) {
  const { settings } = useSettings();
  const birtEv = person.events.find((e) => e.tag === "BIRT");

  // The person's age at an event, shown after its date ("Show ages" setting);
  // the tooltip carries the full-precision Y/M/D breakdown.
  const birthDate = settings.showAge ? birthDateOf(person) : undefined;
  function eventAge(ev: GedEvent): { text: string; title: string }[] | undefined {
    if (!settings.showAge || ev.tag === "BIRT") return undefined;
    const age = ageBetween(birthDate, ev.date);
    if (age === undefined) return undefined;
    const detail = fullAgeBetween(birthDate, ev.date, t);
    return [{ text: String(age), title: detail ? `${t("event.age.person")}: ${detail}` : t("event.age.person") }];
  }

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

  // Fallback key bases when no merge is active (main-only count-based naming).
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
    ? (mainMergeKeyBases?.get(birtOriginalIdx) ?? eventKeyBases[birtOriginalIdx])
    : "BIRT";

  // Unified sorted list: main non-BIRT events interleaved with incoming-only extra events.
  type MainRow  = { kind: "main"; ev: GedEvent; i: number; mergeKeyBase: string; compareKey?: string; stableKey: number };
  type ExtraRow   = { kind: "extra";  tag: string; keyBase: string; compareIdx: number };
  type AnyRow     = (MainRow | ExtraRow) & { sortKey: number; tagPos: number };

  // Raw event nodes in the same order as person.events — used for stable WeakMap keys.
  const rawEventNodes = person.raw.children.filter((c) => INDI_EVENT_TAGS.has(c.tag));

  // Zone-aware anchors so undated life-zone events (RESI, OCCU, …) sort between
  // birth and death rather than before all dated events — used only as a
  // fallback when no merge supplies an authoritative sort key (`mainMergeSortKeys`).
  const anchors = lifespanAnchors(person.events);

  const allRows: AnyRow[] = [
    ...person.events
      .map((ev, i) => ({ ev, i }))
      .filter(({ ev }) => ev.tag !== "BIRT")
      .map(({ ev, i }): AnyRow => ({
        kind: "main",
        ev, i,
        mergeKeyBase: mainMergeKeyBases?.get(i) ?? eventKeyBases[i],
        compareKey: mainMergeCompareKeys?.get(i),
        stableKey: nodeId(rawEventNodes[i] ?? ev),
        sortKey: mainMergeSortKeys?.get(i) ?? zoneSortKey(ev.date, ev.tag, anchors),
        tagPos: EXTRA_EVENT_ORDER.indexOf(ev.tag),
      })),
    ...(extraMergeEvents ?? [])
      .map(({ tag, keyBase, sortKey, compareIdx }): AnyRow => ({
        kind: "extra",
        tag, keyBase, compareIdx,
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
      <EventFieldsRow
        key={`${person.id}-BIRT-${undoVersion ?? 0}-${mergeGen ?? 0}`}
        ev={birtEv}
        label={t("event.BIRT")}
        tag="BIRT"
        t={t}
        commitField={(update, extraPatches) => {
          commit((indi, notes) => setEventField(indi, "BIRT", update, notes), extraPatches);
          onResolveMergeField?.(birtMergeKeyBase, birtMergeKeyBase, subsOf(update));
        }}
        forcedKeyBase={birtMergeKeyBase}
        onRemove={birtOriginalIdx >= 0 ? () => commit((indi) => removeEventAtIndex(indi, birtOriginalIdx)) : undefined}
        onAddSource={() => onOpenSourceDialog({ kind: "event", commitField: (update, extraPatches) => commit((indi) => setEventField(indi, "BIRT", update), extraPatches) })}
        onEditSource={birtOriginalIdx >= 0 ? (idx) => openEditSource(rawEventNodes[birtOriginalIdx], idx, { kind: "individual", indi: person }) : undefined}
        onOpenSourceDialog={onOpenSourceDialog}
        placeSuggestions={placeSuggestions}
        placeToAddrs={placeToAddrs}
        placeCanonical={placeCanonical}
        addrCanonical={addrCanonical}
            placeCoords={placeCoords}
            pairCoords={pairCoords}
        mergeHighlight={mergeHighlight}
        mergeIncomingSources={mergeIncomingSources}
        mergeKeyBase={birtMergeKeyBase}
        resolvedSessionFields={resolvedSessionFields}
        eventNodeId={birtOriginalIdx >= 0 ? nodeId(rawEventNodes[birtOriginalIdx]) : undefined}
        materializedEventIds={materializedEventIds}
        age={birthParentAges}
      />
      {allRows.map((row) =>
        row.kind === "main" ? (
          <EventFieldsRow
            key={`ev-${row.stableKey}-${mergeGen ?? 0}`}
            ev={row.ev}
            label={t(`event.${row.ev.tag}`)}
            tag={row.ev.tag}
            t={t}
            commitField={(update, extraPatches) => {
              commit((indi, notes) => setEventFieldAtIndex(indi, row.i, update, notes), extraPatches);
              onResolveMergeField?.(row.mergeKeyBase, String(row.stableKey), subsOf(update));
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
            placeCoords={placeCoords}
            pairCoords={pairCoords}
            mergeHighlight={mergeHighlight}
            mergeIncomingSources={mergeIncomingSources}
            mergeKeyBase={row.mergeKeyBase}
            forcedKeyBase={String(row.stableKey)}
            resolvedSessionFields={resolvedSessionFields}
            eventNodeId={row.stableKey}
            materializedEventIds={materializedEventIds}
            age={eventAge(row.ev)}
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
              // The edit materializes this incoming-only suggestion into a real
              // main event node; capture its stable id so the dirty/bold
              // marker attaches to that exact node, surviving the row's
              // "extra"→"main" remount even as merge key bases reshuffle.
              let materializedId: number | undefined;
              commit((indi) => {
                const eventNode = addEventField(indi, row.tag, update);
                if (eventNode) {
                  materializedId = nodeId(eventNode);
                  patches.push(...(onMaterializeIncomingSources?.(eventNode, row.tag, row.compareIdx) ?? []));
                }
              }, patches);
              if (materializedId !== undefined) onMaterializeEventNode?.(materializedId);
              onResolveMergeField?.(row.keyBase, materializedId !== undefined ? String(materializedId) : row.keyBase, subsOf(update));
              onRejectIncomingEvent?.(row.tag, row.compareIdx);
            }}
            onRemove={() => onRejectIncomingEvent?.(row.tag, row.compareIdx)}
            onAddSource={() => onOpenSourceDialog({ kind: "event", commitField: (update, extraPatches) => commit((indi) => addEventField(indi, row.tag, update), extraPatches) })}
            onOpenSourceDialog={onOpenSourceDialog}
            placeSuggestions={placeSuggestions}
            placeToAddrs={placeToAddrs}
            placeCanonical={placeCanonical}
            addrCanonical={addrCanonical}
            placeCoords={placeCoords}
            pairCoords={pairCoords}
            mergeHighlight={mergeHighlight}
            mergeIncomingSources={mergeIncomingSources}
            mergeKeyBase={row.keyBase}
            forcedKeyBase={row.keyBase}
            resolvedSessionFields={resolvedSessionFields}
          />
        ),
      )}
    </div>
  );
});
