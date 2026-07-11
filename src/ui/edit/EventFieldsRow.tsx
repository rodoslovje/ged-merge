import { useEffect, useRef, useState } from "react";
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
  // Secondary fields the user chose to add via the "+ Detail" menu on a sparse
  // event (they start empty). `focusKey` moves focus to the one just added.
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
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

  // Sizes a flowing field to its content (in `ch`) so short values like "fsd"
  // don't each claim a full-width column — that content-sizing is what lets the
  // place and the secondary fields pack onto one wrapped line and only spill to
  // a second row when they genuinely don't fit.
  const chW = (v: string, max = 40) => ({ width: `${Math.min(max, Math.max(6, v.trim().length + 2))}ch` });
  // Notes can be multi-line, so size them to the widest line, not the whole
  // string's length (which would over-widen a stack of short lines).
  const noteW = (v: string, max = 50) => {
    const longest = v.split("\n").reduce((m, line) => Math.max(m, line.length), 0);
    return { width: `${Math.min(max, Math.max(6, longest + 2))}ch` };
  };

  // Compact layout: a field with no value (and not showing an incoming merge
  // value) is collapsed to zero height/width at rest and only revealed when the
  // event row is hovered or focused. The primary line carries the near-universal
  // Date + Place (or the value, for value-events); every other populated field
  // flows together on a wrapped "extras" line below, so a typical event with a
  // couple of extra fields lands on two rows instead of a rigid three-row grid
  // full of holes. Incoming merge suggestions count as "shown" (their value is
  // displayed even before it's written), so they never hide.
  const optCls = (shown: boolean) => (shown ? "" : " ev-collapsed");
  // The date is the event's anchor, so ordinary date/place events always show it
  // (it's also where a brand-new event is typed). Place and every other field
  // are content-driven: shown only when they have a value (or an incoming merge
  // value, or the user adds them), so an event without a place reserves no empty
  // slot. Value-events (OCCU/EDUC/RETI/EVEN) lead with their value instead.
  const primaryLine = !hasTitle;
  const dateShown = primaryLine || Boolean(dateField.value.trim()) || dateField.isMerge;
  const typeShown = Boolean(typeField.value.trim()) || typeField.isMerge;
  const placeShown = Boolean(placeField.value.trim()) || placeField.isMerge;
  const addrShown = Boolean(addrField.value.trim()) || addrField.isMerge;
  const agencyShown = Boolean(agencySlotField.value.trim()) || agencySlotField.isMerge;
  const causeShown = Boolean(causeField.value.trim()) || causeField.isMerge;
  const noteShown = Boolean(noteField.value.trim()) || noteField.isMerge;
  const sourcesShown =
    Boolean(ev?.sources?.length) || Boolean(sourcesMergeVal?.length) || links.length > 0;
  // A field renders when it has content OR the user added it from the "+ Detail"
  // menu. Empty, un-added fields stay hidden — no more revealing every empty
  // field on hover, which read as a crowded row of blank labelled inputs.
  const show = {
    date: dateShown || revealed.has("date"),
    place: placeShown || revealed.has("place"),
    addr: addrShown || revealed.has("addr"),
    type: typeShown || revealed.has("type"),
    agency: agencyShown || revealed.has("agency"),
    cause: causeShown || revealed.has("cause"),
    note: noteShown || revealed.has("note"),
  };
  // Fields offered by the "+ Detail" menu: source is always addable; the rest
  // only while not already showing. Place/address adapt to the event kind
  // (ordinary events show Place on the primary line, so only Address is offered).
  const addable: { key: string; label: string }[] = [
    { key: "source", label: t("edit.addLink") },
    { key: "place", label: t("event.colPlace") },
    { key: "addr", label: t("event.colAddr") },
    ...(showTypeCell ? [{ key: "type", label: t("event.colType") }] : []),
    { key: "agency", label: t("event.colAgency") },
    { key: "cause", label: t("event.colCause") },
    { key: "note", label: t("event.colNote") },
  ].filter((f) => f.key === "source" || !show[f.key as keyof typeof show]);

  function addDetail(key: string) {
    if (key === "source") {
      onAddSource();
      return;
    }
    setRevealed((prev) => new Set(prev).add(key));
    setFocusKey(key);
  }

  // Move focus into a field the moment it's added from the "+ Detail" menu, so
  // the whole flow stays on the keyboard. The fields are always in the DOM (just
  // CSS-hidden until shown), so `autoFocus` wouldn't fire on reveal — focus it
  // imperatively once the reveal has committed.
  useEffect(() => {
    if (!focusKey) return;
    const el = rootRef.current?.querySelector<HTMLElement>(
      `[data-detail="${focusKey}"] input, [data-detail="${focusKey}"] textarea`,
    );
    el?.focus();
    setFocusKey(null);
  }, [focusKey]);

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
  // content-sized input. Hidden when empty and not added; shown once it has a
  // value or the user picks it from the "+ Detail" menu. Used for Type / Agency
  // / Cause.
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
      <span key={key} data-detail={key} className={"edit-event-extra" + optCls(shown)}>
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

  // A place/address field on the flowing body: a hover label + a content-sized
  // autocomplete. Used for Address (all events) and, on value-events, Place.
  function extraPlace(
    key: string,
    labelText: string,
    shown: boolean,
    field: ReturnType<typeof useField>,
    forced: boolean,
    suggestions: string[],
    canonical: Map<string, string>,
    cls: string,
    title: string,
    commit: (val: string) => void,
  ) {
    return (
      <span key={key} data-detail={key} className={"edit-event-extra" + optCls(shown)}>
        <span className="edit-event-extra-label">{labelText}</span>
        <PlaceAutocomplete
          value={field.value}
          suggestions={suggestions}
          canonical={canonical}
          isDirty={field.isDirty || forced}
          isMerge={field.isMerge}
          className={"edit-input " + cls}
          wrapClassName="edit-event-extra-field"
          wrapStyle={chW(field.value)}
          title={title}
          onChange={field.set}
          onCommit={commit}
          onClear={() => { field.clear(); commit(""); }}
        />
      </span>
    );
  }

  return (
    <div className="edit-event" ref={rootRef}>
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

      {/* Primary line, column 2: the date (wider only when age badges show). */}
      <div className={"edit-event-date-cell" + (age ? " edit-event-date-cell--age" : "") + optCls(show.date)}>
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

      {/* Body: the primary field (Place, or the value for value-events) plus
       * every populated secondary field flow together here and wrap only when
       * they don't fit — so a short extra like a cause rides on the first row
       * beside the place instead of claiming a near-empty second row. */}
      <div className="edit-event-body">
        {/* Value-events lead with their value (its own click target, always
         * shown); ordinary events lead with the date, already rendered above. */}
        {!primaryLine && (
          <ClearableInput
            wrapClassName="edit-event-primary"
            wrapStyle={chW(titleField.value, 60)}
            className={fieldCls("edit-input edit-event-value", titleField.isMerge, titleField.isDirty || titleForced)}
            value={titleField.value}
            placeholder={t("event.colTitle")}
            title={titleLabel}
            onChange={titleField.onChange}
            onBlur={() => commitAll({})}
            onClear={() => { titleField.clear(); commitAll(titleClearUpdate); }}
          />
        )}
        {/* Place — the same everywhere: unlabelled (a place reads as a place) and
         * shown only when it has content, so no event reserves an empty slot. */}
        <span data-detail="place" className={"edit-event-extra edit-event-extra--place" + optCls(show.place)}>
          <PlaceAutocomplete
            value={placeField.value}
            suggestions={placeSuggestions}
            canonical={placeCanonical}
            isDirty={placeField.isDirty || placeForced}
            isMerge={placeField.isMerge}
            className="edit-input edit-event-place"
            wrapClassName="edit-event-extra-field"
            wrapStyle={chW(placeField.value, 60)}
            title={t("event.place", { event: label })}
            onChange={placeField.set}
            onCommit={(val) => commitAll({ place: val })}
            onClear={() => { placeField.clear(); commitAll({ place: "" }); }}
          />
        </span>
        {extraPlace("addr", t("event.colAddr"), show.addr, addrField, addrForced, placeToAddrs.get(placeKey(placeField.value)) ?? [], addrCanonical, "edit-event-addr", t("event.addr", { event: label }), (val) => commitAll({ address: val }))}
        {showTypeCell &&
          extraText("type", t("event.colType"), show.type, typeField, typeForced, t("event.type", { event: label }), { type: "" })}
        {extraText("agency", t("event.colAgency"), show.agency, agencySlotField, agencySlotForced, agencySlotLabel, agencyClearUpdate)}
        {extraText("cause", t("event.colCause"), show.cause, causeField, causeForced, t("event.cause", { event: label }), { cause: "" })}
        <span data-detail="note" className={"edit-event-extra edit-event-extra--note" + optCls(show.note)}>
          <span className="edit-event-extra-label">{t("event.colNote")}</span>
          <ClearableTextarea
            wrapClassName="edit-event-extra-field"
            wrapStyle={noteW(noteField.value)}
            className={fieldCls("edit-input edit-event-note", noteField.isMerge, noteField.isDirty || noteForced)}
            value={noteField.value}
            title={t("event.note", { event: label })}
            rows={1}
            onChange={noteField.onChange}
            onBlur={() => commitAll({})}
            onClear={() => { noteField.clear(); commitAll({ note: "" }); }}
          />
        </span>
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
        </span>
        {/* Add a source / place / note / other detail without keeping every empty
         * field on screen — the menu offers only the ones not already shown. A
         * real (visible) <select> so it's reliably keyboard-openable, unlike the
         * opacity-0 overlay chips. */}
        {addable.length > 0 && (
          <select
            className="edit-event-addfield"
            value=""
            title={t("edit.addDetailTooltip")}
            onChange={(e) => {
              const k = e.target.value;
              if (k) addDetail(k);
            }}
          >
            <option value="">+ {t("edit.addDetail")}</option>
            {addable.map((f) => (
              <option key={f.key} value={f.key}>{f.label}</option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}
