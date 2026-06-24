import type { Individual, GedEvent, GedNode, SourceCitation } from "../../gedcom/types";
import type { Translate } from "../../locales/i18n";
import type { RecordPatch } from "../historyTypes";
import type { EventFieldUpdate } from "../../gedcom/edit";
import { addEventField, removeEventAtIndex, setEventField, setEventFieldAtIndex, changeEventTagAtIndex } from "../../gedcom/edit";
import { INDI_EVENT_TAGS } from "../../gedcom/builder";
import { clampBeforeDeathZone, dateToSortKey, minDeathZoneKey } from "../../review/fields";
import { EventFieldsRow } from "./EventFieldsRow";
import { nodeId } from "./nodeId";
import { EXTRA_EVENT_ORDER, INDIVIDUAL_EVENT_GROUPS, ASSIGNABLE_EVENT_TAGS } from "./editConstants";
import type { Commit, OpenEditSource, SourceDialogTarget } from "./types";

/** Events grid: BIRT always first (creates on commit), then all other events
 * in person.events order — multiple occurrences of the same tag are supported.
 * When mergeHighlight is set, merge-highlighted fields are shown and extra incoming-only
 * events are appended at the end. */
export function EventList({
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
