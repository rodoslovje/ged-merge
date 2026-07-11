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
  age,
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
  /** Age badges shown after the date ("Show ages" setting) — the person's age
   * at this event, or one glyph-tagged badge per spouse/parent (e.g. "♂32"
   * "♀28"), each with its own tooltip. */
  age?: { text: string; title: string }[];
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

  // Sizes a flowing extras input to its content (in `ch`) so short values like
  // "fsd" don't each claim a full-width column — that content-sizing is what
  // lets several secondary fields pack onto one wrapped line.
  const chW = (v: string) => ({ width: `${Math.min(40, Math.max(6, v.trim().length + 2))}ch` });

  // Compact layout: a field with no value (and not showing an incoming merge
  // value) is collapsed to zero height/width at rest and only revealed when the
  // event row is hovered or focused. The primary line carries the near-universal
  // Date + Place (or the value, for value-events); every other populated field
  // flows together on a wrapped "extras" line below, so a typical event with a
  // couple of extra fields lands on two rows instead of a rigid three-row grid
  // full of holes. Incoming merge suggestions count as "shown" (their value is
  // displayed even before it's written), so they never hide.
  const optCls = (shown: boolean) => (shown ? "" : " ev-collapsed");
  // Date and place appear on almost every event and share row 1, so for ordinary
  // date/place events we keep them in fixed positions even when empty — the most
  // common events then read as a stable two-column table (empty cells are an
  // invisible click target until hovered) rather than fields popping in at
  // varying spots. Value-events (OCCU/EDUC/RETI/EVEN) have no place and lead with
  // their value instead, so they stay fully compact.
  const primaryLine = !hasTitle;
  const dateShown = primaryLine || Boolean(dateField.value.trim()) || dateField.isMerge;
  const typeShown = Boolean(typeField.value.trim()) || typeField.isMerge;
  const placeShown = primaryLine || Boolean(placeField.value.trim()) || placeField.isMerge;
  const addrShown = Boolean(addrField.value.trim()) || addrField.isMerge;
  const titleShown = Boolean(titleField.value.trim()) || titleField.isMerge;
  const agencyShown = Boolean(agencySlotField.value.trim()) || agencySlotField.isMerge;
  const causeShown = Boolean(causeField.value.trim()) || causeField.isMerge;
  const noteShown = Boolean(noteField.value.trim()) || noteField.isMerge;
  const sourcesShown =
    Boolean(ev?.sources?.length) || Boolean(sourcesMergeVal?.length) || links.length > 0;

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

  // A secondary field on the flowing "extras" line: a small label + a
  // content-sized input. Collapsed (zero size) when empty; revealed on row
  // hover/focus like the primary fields. Used for Type / Agency / Cause.
  function extraText(
    key: string,
    labelText: string,
    shown: boolean,
    field: ReturnType<typeof useField>,
    forced: boolean,
    title: string,
    clearUpdate: Partial<EventFieldUpdate>,
  ) {
    return (
      <span key={key} className={"edit-event-extra" + optCls(shown)}>
        <span className="edit-event-extra-label">{labelText}</span>
        <ClearableInput
          wrapClassName="edit-event-extra-field"
          wrapStyle={chW(field.value)}
          className={fieldCls("edit-input", field.isMerge, field.isDirty || forced)}
          value={field.value}
          title={title}
          onChange={field.onChange}
          onBlur={() => commitAll({})}
          onClear={() => { field.clear(); commitAll(clearUpdate); }}
        />
      </span>
    );
  }

  return (
    <div className="edit-event">
      {/* Column 1: event-type label with the expand toggle beside it. When the
       * tag can be reassigned and/or the event removed, a hidden <select>
       * overlay turns the label into a menu — type choices (if any) plus a
       * "Remove this event" entry at the end. */}
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

      {/* Primary line, column 2: the date. */}
      <div className={"edit-event-date-cell" + optCls(dateShown)}>
        <ClearableInput
          className={fieldCls("edit-input edit-event-date", dateField.isMerge, dateField.isDirty || dateForced)}
          value={dateField.value}
          placeholder={t("event.colDate")}
          title={t("event.date", { event: label })}
          autoFocus={autoFocusDate}
          onChange={dateField.onChange}
          onBlur={() => commitAll({})}
          onClear={() => { dateField.clear(); commitAll({ date: "" }); }}
        />
        {age && (
          <span className="edit-event-age gm-data">
            {age.map((a, i) => (
              <span key={i} title={a.title}>{a.text}</span>
            ))}
          </span>
        )}
      </div>

      {/* Primary line, columns 3/4: Place + Address for ordinary events; the
       * value instead for value-events (OCCU/EDUC/RETI/EVEN), which have no
       * place — their Place/Address fall through to the extras line below. */}
      {primaryLine ? (
        <>
          <PlaceAutocomplete
            value={placeField.value}
            suggestions={placeSuggestions}
            canonical={placeCanonical}
            isDirty={placeField.isDirty || placeForced}
            isMerge={placeField.isMerge}
            className="edit-input edit-event-place"
            wrapClassName={"edit-event-c3" + optCls(placeShown)}
            wrapStyle={{ gridRow: 1 }}
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
            wrapClassName={"edit-event-c4" + optCls(addrShown)}
            wrapStyle={{ gridRow: 1 }}
            placeholder={t("event.colAddr")}
            title={t("event.addr", { event: label })}
            onChange={addrField.set}
            onCommit={(val) => commitAll({ address: val })}
            onClear={() => { addrField.clear(); commitAll({ address: "" }); }}
          />
        </>
      ) : (
        <ClearableInput
          wrapClassName={"edit-event-c3" + optCls(titleShown)}
          wrapStyle={{ gridRow: 1 }}
          className={fieldCls("edit-input edit-event-value", titleField.isMerge, titleField.isDirty || titleForced)}
          value={titleField.value}
          placeholder={t("event.colTitle")}
          title={titleLabel}
          onChange={titleField.onChange}
          onBlur={() => commitAll({})}
          onClear={() => { titleField.clear(); commitAll(titleClearUpdate); }}
        />
      )}

      {/* Extras line: sources and every other populated secondary field flow
       * together here and wrap, instead of each reserving a fixed grid cell —
       * so a typical event compacts to two rows rather than a holey three. */}
      <div className="edit-event-extras">
        <span className={"edit-event-extra edit-event-extra--sources" + optCls(sourcesShown)}>
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
        </span>
        {!primaryLine && (
          <span className={"edit-event-extra" + optCls(placeShown)}>
            <span className="edit-event-extra-label">{t("event.colPlace")}</span>
            <PlaceAutocomplete
              value={placeField.value}
              suggestions={placeSuggestions}
              canonical={placeCanonical}
              isDirty={placeField.isDirty || placeForced}
              isMerge={placeField.isMerge}
              className="edit-input edit-event-place"
              wrapClassName="edit-event-extra-field"
              wrapStyle={chW(placeField.value)}
              title={t("event.place", { event: label })}
              onChange={placeField.set}
              onCommit={(val) => commitAll({ place: val })}
              onClear={() => { placeField.clear(); commitAll({ place: "" }); }}
            />
          </span>
        )}
        {!primaryLine && (
          <span className={"edit-event-extra" + optCls(addrShown)}>
            <span className="edit-event-extra-label">{t("event.colAddr")}</span>
            <PlaceAutocomplete
              value={addrField.value}
              suggestions={placeToAddrs.get(placeKey(placeField.value)) ?? []}
              canonical={addrCanonical}
              isDirty={addrField.isDirty || addrForced}
              isMerge={addrField.isMerge}
              className="edit-input edit-event-addr"
              wrapClassName="edit-event-extra-field"
              wrapStyle={chW(addrField.value)}
              title={t("event.addr", { event: label })}
              onChange={addrField.set}
              onCommit={(val) => commitAll({ address: val })}
              onClear={() => { addrField.clear(); commitAll({ address: "" }); }}
            />
          </span>
        )}
        {showTypeCell &&
          extraText("type", t("event.colType"), typeShown, typeField, typeForced, t("event.type", { event: label }), { type: "" })}
        {extraText("agency", t("event.colAgency"), agencyShown, agencySlotField, agencySlotForced, agencySlotLabel, agencyClearUpdate)}
        {extraText("cause", t("event.colCause"), causeShown, causeField, causeForced, t("event.cause", { event: label }), { cause: "" })}
        <span className={"edit-event-extra edit-event-extra--note" + optCls(noteShown)}>
          <span className="edit-event-extra-label">{t("event.colNote")}</span>
          <ClearableTextarea
            wrapClassName="edit-event-extra-field"
            className={fieldCls("edit-input edit-event-note", noteField.isMerge, noteField.isDirty || noteForced)}
            value={noteField.value}
            title={t("event.note", { event: label })}
            rows={1}
            onChange={noteField.onChange}
            onBlur={() => commitAll({})}
            onClear={() => { noteField.clear(); commitAll({ note: "" }); }}
          />
        </span>
      </div>
    </div>
  );
}
