import { useRef, useState } from "react";
import type { GedEvent, SourceCitation } from "../../gedcom/types";
import type { Translate } from "../../locales/i18n";
import type { RecordPatch } from "../historyTypes";
import type { EventFieldUpdate } from "../../gedcom/edit";
import { SourceRefs } from "../SourceRef";
import { ClearableInput, ClearableTextarea } from "./ClearableInput";
import { PlaceAutocomplete } from "./PlaceAutocomplete";
import { useField } from "./useField";
import { VALUE_EVENT_TAGS } from "./editConstants";
import { placeKey } from "./placeSuggestions";
import type { SourceDialogTarget } from "./types";

/** Sentinel `<option>` value for the "Remove this event" entry at the end of
 * the event-type dropdown (distinct from any real tag). */
const REMOVE_OPTION = "__remove_event__";

/** Editable date/place/address/links for a single event (individual or
 * family), e.g. `1 BIRT` or `1 MARR`. */
export function EventFieldsRow({
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
  forcedKeyBase,
  resolvedSessionFields,
  eventNodeId,
  materializedEventIds,
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
  /** Stable per-event identity (e.g. the raw node's `nodeId`) used to look up
   * the session "this field was edited from a merge" markers in
   * `resolvedSessionFields`. Distinct from `mergeKeyBase`, which is a volatile
   * positional key (e.g. "RESI.1") that can be reassigned to a different event
   * as same-tag events reshuffle. Falls back to `mergeKeyBase`/`tag` for
   * callers whose key base is already stable (e.g. family events). */
  forcedKeyBase?: string;
  resolvedSessionFields?: Set<string>;
  /** This event's stable `nodeId`, matched against `materializedEventIds`. */
  eventNodeId?: number;
  /** `nodeId`s of events materialized this session from a merge suggestion;
   * every field of such an event renders bold (it's all new vs the saved
   * main), independently of `resolvedSessionFields`. */
  materializedEventIds?: Set<number>;
}) {
  // A generic `EVEN` is labelled "Event"; its descriptive `TYPE` is edited in
  // the "Title" slot and its own line value (`1 EVEN <v>`) in the "Agency" slot
  // (see the title/agency field bindings below). The Title slot shows for it too.
  const isEven = tag === "EVEN";
  const showValue = isEven || (tag !== undefined && VALUE_EVENT_TAGS.has(tag));

  // Compute merge values before hooks so they can be used as initial state.
  const kBase = mergeKeyBase ?? tag ?? "";
  const dateMergeVal = mergeHighlight?.get(`${kBase}.date`);
  const valueMergeVal = showValue ? mergeHighlight?.get(`${kBase}.value`) : undefined;
  const placeMergeVal = mergeHighlight?.get(`${kBase}.place`);
  const addrMergeVal = mergeHighlight?.get(`${kBase}.addr`);
  const noteMergeVal = mergeHighlight?.get(`${kBase}.note`);
  const agencyMergeVal = mergeHighlight?.get(`${kBase}.agency`);
  const typeMergeVal = mergeHighlight?.get(`${kBase}.type`);
  const causeMergeVal = mergeHighlight?.get(`${kBase}.cause`);
  const sourcesMergeVal = mergeIncomingSources?.get(`${kBase}.sources`);

  // A field just materialized from a merge suggestion via a direct edit keeps
  // showing dirty/bold across the row's one-time "extra"→"main" remount.
  // Keyed by the *stable* `forcedKeyBase` (not the volatile `kBase`) so the
  // marker stays attached to the same physical event when same-tag events
  // reshuffle their merge key bases.
  const fBase = forcedKeyBase ?? kBase;
  // A whole event materialized this session from an incoming suggestion is new
  // vs the saved main, so every field is a change — force them all bold,
  // regardless of per-field merge resolution (which can be cleared/recomputed).
  const eventForced = eventNodeId !== undefined && (materializedEventIds?.has(eventNodeId) ?? false);
  const dateForced = eventForced || (resolvedSessionFields?.has(`${fBase}.date`) ?? false);
  const valueForced = eventForced || (resolvedSessionFields?.has(`${fBase}.value`) ?? false);
  const placeForced = eventForced || (resolvedSessionFields?.has(`${fBase}.place`) ?? false);
  const addrForced = eventForced || (resolvedSessionFields?.has(`${fBase}.addr`) ?? false);
  const noteForced = eventForced || (resolvedSessionFields?.has(`${fBase}.note`) ?? false);
  const agencyForced = eventForced || (resolvedSessionFields?.has(`${fBase}.agency`) ?? false);
  const typeForced = eventForced || (resolvedSessionFields?.has(`${fBase}.type`) ?? false);
  const causeForced = eventForced || (resolvedSessionFields?.has(`${fBase}.cause`) ?? false);
  // Family rows remount on a real retag (see the `FamilyEventRow` call
  // sites), so the freshly-mounted row can't tell a real retag from this
  // tag having always been here — `markFamilyTagRetagged` flags it instead.
  const tagForced = resolvedSessionFields?.has(`${fBase}.tag`) ?? false;

  const valueField = useField(ev?.value ?? "", valueMergeVal);
  const dateField = useField(ev?.date?.raw ?? "", dateMergeVal);
  const placeField = useField(ev?.place?.raw ?? "", placeMergeVal);
  const addrField = useField(ev?.address?.raw ?? "", addrMergeVal);
  const noteField = useField(ev?.note ?? "", noteMergeVal);
  const agencyField = useField(ev?.agency ?? "", agencyMergeVal);
  const typeField = useField(ev?.type ?? "", typeMergeVal);
  const causeField = useField(ev?.cause ?? "", causeMergeVal);
  // The row stays mounted (same stable key) when its tag changes via
  // `onChangeTag`, so — unlike `useField` — track dirtiness against the tag
  // this row mounted with, not against `ev`'s own value (there's no GedEvent
  // field to compare against).
  const initialTagRef = useRef(tag);
  const tagDirty = tag !== undefined && tag !== initialTagRef.current;
  const [links, setLinks] = useState<string[]>(ev?.links ?? []);
  // EVEN remaps the Title slot to its TYPE and the Agency slot to its line
  // value; every other event keeps the normal value/agency mapping.
  const titleField = isEven ? typeField : valueField;
  const titleForced = isEven ? typeForced : valueForced;
  const titleLabel = isEven ? t("event.colTitle") : label;
  const titleClearUpdate: Partial<EventFieldUpdate> = isEven ? { type: "" } : { value: "" };
  const agencySlotField = isEven ? valueField : agencyField;
  const agencySlotForced = isEven ? valueForced : agencyForced;
  const agencySlotLabel = isEven ? t("event.colAgency") : t("event.agency", { event: label });
  const agencyClearUpdate: Partial<EventFieldUpdate> = isEven ? { value: "" } : { agency: "" };

  // Only value events (OCCU/EDUC/RETI) and EVEN expose a Title slot (their line
  // value / TYPE). Plain events have none — their TYPE lives in the column-2
  // Type field stacked under Date/Sources instead (EVEN keeps TYPE as Title).
  const hasTitle = showValue;
  const showTypeCell = !isEven;

  // Columns 3/4 lay out as three fixed rows, mirroring column 2's
  // Date / Sources / Type stack:
  //   1. Place + Address
  //   2. (Title — or Cause, when the event has no Title slot) + Agency
  //   3. Note + (Cause, when it wasn't already shown in row 2)
  // All three rows are always shown, but a row with no data sinks below the
  // rows that have some (stable order: Place, then mid, then Note), so populated
  // fields rise to the top. Cause appears exactly once: row 2 (mid) for plain
  // events, row 3 (note) for events that carry a Title.
  const causeInMid = !hasTitle;
  const placeData = Boolean(placeField.value.trim()) || Boolean(addrField.value.trim());
  const midData =
    (hasTitle && Boolean(titleField.value.trim())) ||
    (causeInMid && Boolean(causeField.value.trim())) ||
    Boolean(agencySlotField.value.trim());
  const noteData = Boolean(noteField.value.trim()) || (!causeInMid && Boolean(causeField.value.trim()));
  const rows = [
    { key: "place", data: placeData },
    { key: "mid", data: midData },
    { key: "note", data: noteData },
  ] as const;
  const arranged = [...rows.filter((r) => r.data), ...rows.filter((r) => !r.data)];
  const rowOf = (key: string) => arranged.findIndex((r) => r.key === key) + 1;

  // The event-type label becomes a dropdown when the tag can be reassigned
  // and/or the event removed — the latter via a "Remove this event" entry
  // appended to the end of the list.
  const showSelect = Boolean(tag) && (Boolean(onChangeTag && tagGroups) || Boolean(onRemove));

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
      type: typeField.value,
      cause: causeField.value,
      ...override,
    };
    const unchanged =
      (merged.date ?? "") === dateField.initial &&
      (merged.value ?? "") === valueField.initial &&
      (merged.place ?? "") === placeField.initial &&
      (merged.address ?? "") === addrField.initial &&
      (merged.note ?? "") === noteField.initial &&
      (merged.agency ?? "") === agencyField.initial &&
      (merged.type ?? "") === typeField.initial &&
      (merged.cause ?? "") === causeField.initial;
    if (unchanged) return;
    commitField(merged);
  }

  // Cause renders in column 3 (middle row) for plain events, or column 4
  // (note row) for events that carry a Title — never both.
  function causeInput(wrapClassName: string, gridRow: number) {
    return (
      <ClearableInput
        wrapClassName={wrapClassName}
        wrapStyle={{ gridRow }}
        className={fieldCls("edit-input edit-event-cause", causeField.isMerge, causeField.isDirty || causeForced)}
        value={causeField.value}
        placeholder={t("event.colCause")}
        title={t("event.cause", { event: label })}
        onChange={causeField.onChange}
        onBlur={() => commitAll({})}
        onClear={() => { causeField.clear(); commitAll({ cause: "" }); }}
      />
    );
  }

  return (
    <div className="edit-event">
      {/* Column 1, row 1: event-type label with the expand toggle beside it.
       * When the tag can be reassigned and/or the event removed, a hidden
       * <select> overlay turns the label into a menu — type choices (if any)
       * plus a "Remove this event" entry at the end. */}
      <div className="edit-event-type-row">
        <div
          className={fieldCls(
            showSelect ? "edit-event-label edit-event-label--select" : "edit-event-label",
            false,
            tagDirty || tagForced,
          )}
        >
          {label}
          {showSelect && (
            <>
              <span className="edit-event-type-caret" aria-hidden="true">▾</span>
              <select
                className="edit-event-type-select"
                value={tag}
                title={onChangeTag ? t("edit.changeEventType") : t("edit.removeEvent")}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === REMOVE_OPTION) onRemove?.();
                  else if (onChangeTag && v !== tag) onChangeTag(v);
                }}
              >
                {onChangeTag && tagGroups ? (
                  tagGroups.map((g, gi) =>
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
                  )
                ) : (
                  <option value={tag}>{label}</option>
                )}
                {onRemove && (
                  <option value={REMOVE_OPTION}>{t("edit.removeEvent")}</option>
                )}
              </select>
            </>
          )}
        </div>
      </div>

      {/* Column 2: date (row 1), sources (row 2), and — for standard events —
       * the TYPE sub-tag (row 3). */}
      <ClearableInput
        wrapClassName="edit-event-date-cell"
        className={fieldCls("edit-input edit-event-date", dateField.isMerge, dateField.isDirty || dateForced)}
        value={dateField.value}
        placeholder={t("event.colDate")}
        title={t("event.date", { event: label })}
        autoFocus={autoFocusDate}
        onChange={dateField.onChange}
        onBlur={() => commitAll({})}
        onClear={() => { dateField.clear(); commitAll({ date: "" }); }}
      />
      <div className="edit-event-sources-cell">
        {ev?.sources?.length || sourcesMergeVal?.length ? (
          <SourceRefs t={t} mainSources={ev?.sources} incomingSources={sourcesMergeVal} onEdit={onEditSource} />
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
      {showTypeCell && (
        <ClearableInput
          wrapClassName="edit-event-type-cell"
          className={fieldCls("edit-input edit-event-type", typeField.isMerge, typeField.isDirty || typeForced)}
          value={typeField.value}
          placeholder={t("event.colType")}
          title={t("event.type", { event: label })}
          onChange={typeField.onChange}
          onBlur={() => commitAll({})}
          onClear={() => { typeField.clear(); commitAll({ type: "" }); }}
        />
      )}

      {/* Columns 3/4 — three rows (Place/Address, Title-or-Cause/Agency,
       * Note/(Cause)); each lands on the row `rowOf` assigns so empty rows sink
       * to the bottom. */}
      <PlaceAutocomplete
        value={placeField.value}
        suggestions={placeSuggestions}
        canonical={placeCanonical}
        isDirty={placeField.isDirty || placeForced}
        isMerge={placeField.isMerge}
        className="edit-input edit-event-place"
        wrapClassName="edit-event-c3"
        wrapStyle={{ gridRow: rowOf("place") }}
        placeholder={t("event.colPlace")}
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
        wrapClassName="edit-event-c4"
        wrapStyle={{ gridRow: rowOf("place") }}
        placeholder={t("event.colAddr")}
        title={t("event.addr", { event: label })}
        onChange={addrField.set}
        onCommit={(val) => commitAll({ address: val })}
        onClear={() => { addrField.clear(); commitAll({ address: "" }); }}
      />
      {hasTitle && (
        <ClearableInput
          wrapClassName="edit-event-c3"
          wrapStyle={{ gridRow: rowOf("mid") }}
          className={fieldCls("edit-input edit-event-value", titleField.isMerge, titleField.isDirty || titleForced)}
          value={titleField.value}
          placeholder={t("event.colTitle")}
          title={titleLabel}
          onChange={titleField.onChange}
          onBlur={() => commitAll({})}
          onClear={() => { titleField.clear(); commitAll(titleClearUpdate); }}
        />
      )}
      {causeInMid && causeInput("edit-event-c3", rowOf("mid"))}
      <ClearableInput
        wrapClassName="edit-event-c4"
        wrapStyle={{ gridRow: rowOf("mid") }}
        className={fieldCls("edit-input edit-event-agency", agencySlotField.isMerge, agencySlotField.isDirty || agencySlotForced)}
        value={agencySlotField.value}
        placeholder={t("event.colAgency")}
        title={agencySlotLabel}
        onChange={agencySlotField.onChange}
        onBlur={() => commitAll({})}
        onClear={() => { agencySlotField.clear(); commitAll(agencyClearUpdate); }}
      />
      <ClearableTextarea
        wrapClassName="edit-event-c3"
        wrapStyle={{ gridRow: rowOf("note") }}
        className={fieldCls("edit-input edit-event-note", noteField.isMerge, noteField.isDirty || noteForced)}
        value={noteField.value}
        placeholder={t("event.colNote")}
        title={t("event.note", { event: label })}
        rows={1}
        onChange={noteField.onChange}
        onBlur={() => commitAll({})}
        onClear={() => { noteField.clear(); commitAll({ note: "" }); }}
      />
      {!causeInMid && causeInput("edit-event-c4", rowOf("note"))}
    </div>
  );
}
