import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { GedEvent, GeoCoord, SourceCitation } from "../../gedcom/types";
import type { Translate } from "../../locales/i18n";
import { eventDisplayLabel, vendorEventTooltip } from "../../gedcom/eventTags";
import type { RecordPatch } from "../historyTypes";
import type { EventFieldUpdate } from "../../gedcom/edit";
import { SourceRefs } from "../SourceRef";
import { siteIconForUrl } from "../../tools/sourceReshape";
import { ClearableInput, ClearableTextarea } from "./ClearableInput";
import { PlaceAutocomplete } from "./PlaceAutocomplete";
import { usePlaceLookup } from "./PlaceLookupContext";
import type { PlaceProposal } from "../../geo/placeProposal";
import { EventCoordPicker } from "./EventCoordPicker";
import { useField } from "./useField";
import { SECONDARY_VALUE_EVENT_TAGS, VALUE_EVENT_TAGS } from "./editConstants";
import { placeAddrCoordKey, placeCombosOf, placeKey } from "./placeSuggestions";
import { openPickerOnEnter } from "./openPicker";
import type { SourceDialogTarget } from "./types";

/** Sentinel `<option>` values for the action entries at the end of the
 * event-type dropdown (distinct from any real tag). */
const COPY_OPTION = "__copy_event__";
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
  onCopy,
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
  placeCoords,
  pairCoords,
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
  /** When set, the dropdown offers "Copy event to…" above the remove entry —
   * opening the target picker for this event. Only rows backed by a real event
   * node get it (there's nothing to copy from a merge suggestion). */
  onCopy?: () => void;
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
  /** Coordinate the file already uses for a place (settlement-level). */
  placeCoords: Map<string, GeoCoord>;
  /** Coordinate for a specific place+address pair (the house). */
  pairCoords: Map<string, GeoCoord>;
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
  const { i18n } = useTranslation();
  // A generic `EVEN`/`FACT` wears its descriptive `TYPE` as the event label
  // ("Civil Partnership"), so it reads like any built-in event — the label's
  // tooltip is what says it's custom. The TYPE itself is edited in an
  // always-shown "Title" extra, and the tag's own line value (`1 EVEN <v>`)
  // in the "Agency" slot (see the field bindings below).
  const isEven = tag === "EVEN" || tag === "FACT";
  const showValue = isEven || (tag !== undefined && VALUE_EVENT_TAGS.has(tag));
  // A residence's value is supplementary, not its headline (see
  // `SECONDARY_VALUE_EVENT_TAGS`): the row still leads with the date, and the
  // value rides on the extras line like the agency or the cause.
  const valueIsExtra = showValue && !isEven && tag !== undefined && SECONDARY_VALUE_EVENT_TAGS.has(tag);

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

  // The registers behind the place and address fields; null outside the Edit
  // view, where the fields stay file-only.
  const lookup = usePlaceLookup();
  const valueField = useField(ev?.value ?? "", valueMergeVal);
  const dateField = useField(ev?.date?.raw ?? "", dateMergeVal);
  const placeField = useField(ev?.place?.raw ?? "", placeMergeVal);
  // The coordinate this event actually carries (PLAC.MAP). Read from the model,
  // not the edited text, so it reflects what is in the file.
  const coord = ev?.place?.coord;
  // Whether the file uses coordinates at all: between them the two maps cover
  // every PLAC that carries a MAP (one for events with an address, one for those
  // without), so both empty means the file has none anywhere. A file that does
  // not use locations should not carry a pin on every event row — coordinates
  // are introduced there through Tools → Geocode places, and once the first one
  // lands the pins appear and can refine the rest.
  const fileUsesCoords = placeCoords.size > 0 || pairCoords.size > 0;
  const addrField = useField(ev?.address?.raw ?? "", addrMergeVal);

  // Known place+address pairs for the place field's combo suggestions —
  // typing an address there fills both fields in one go.
  const placeCombos = useMemo(() => placeCombosOf(placeToAddrs, placeCanonical), [placeToAddrs, placeCanonical]);

  /**
   * The coordinate the file already uses for a place (and address), so choosing
   * an existing value brings its position along instead of leaving the new event
   * unplaced. The pair's own house coordinate wins over the settlement's.
   *
   * Only offered when this event has none: a coordinate already here may be more
   * precise than the file's general one for that place, and picking the same
   * value from the list must never quietly coarsen it.
   */
  const knownCoord = (place: string, addr: string): GeoCoord | undefined => {
    if (coord) return undefined;
    const trimmed = place.trim();
    if (!trimmed) return undefined;
    return (addr.trim() ? pairCoords.get(placeAddrCoordKey(trimmed, addr)) : undefined) ?? placeCoords.get(placeKey(trimmed));
  };

  /** Combo pick fills both fields in one commit — shared by both hosts. */
  const pickCombo = (place: string, addr: string) => {
    placeField.set(place);
    addrField.set(addr);
    const known = knownCoord(place, addr);
    commitAll({ place, address: addr, ...(known ? { coord: known } : {}) });
  };
  /**
   * A register's offer for a place the file has never written: its jurisdiction
   * chain (already shaped to this file's layout), the house address when the
   * address register answered, and the coordinate the register puts it at —
   * written in one commit, so it is a single undo step.
   *
   * The coordinate comes along unconditionally, unlike {@link knownCoord}'s: it
   * is this place's own, not a neighbouring event's, so it cannot coarsen
   * anything — and an event whose coordinate was already set is not the case
   * that reaches here (the place is being typed).
   */
  const pickProposal = (proposal: PlaceProposal) => {
    placeField.set(proposal.plac);
    if (proposal.addr) addrField.set(proposal.addr);
    commitAll({
      place: proposal.plac,
      ...(proposal.addr ? { address: proposal.addr } : {}),
      coord: proposal.coord,
      ...(proposal.govId ? { govId: proposal.govId } : {}),
    });
  };
  // The address field's combos: pairs at other places (this place's own
  // addresses are already its plain suggestions), so an address lookup there
  // can move place+address together.
  const addrCombos = useMemo(
    () => placeCombos.filter((cb) => placeKey(cb.place) !== placeKey(placeField.value)),
    [placeCombos, placeField.value],
  );
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
  // EVEN remaps the Agency slot to its line value; every other event keeps the
  // normal value/agency mapping.
  const agencySlotField = isEven ? valueField : agencyField;
  const agencySlotForced = isEven ? valueForced : agencyForced;
  const agencySlotLabel = isEven ? t("event.colAgency") : t("event.agency", { event: label });
  const agencyClearUpdate: Partial<EventFieldUpdate> = isEven ? { value: "" } : { agency: "" };

  // EVEN's TYPE doubles as its display label; while it has one, the label
  // column shows it in place of the generic "Event"/"Fact".
  const customName = isEven ? (typeField.value.trim() || ev?.type?.trim() || "") : "";

  // Only value events (OCCU/EDUC/RETI) expose a Title slot (their line value).
  // Plain events have none — their TYPE lives in the extras-line Type field
  // instead; EVEN edits its TYPE there too, relabelled "Title" and always
  // shown (a custom event is named by it).
  const hasTitle = !isEven && showValue && !valueIsExtra;

  // Sizes a flowing field to its content (in `ch`) so short values like "fsd"
  // don't each claim a full-width column — that content-sizing is what lets the
  // place and the secondary fields pack onto one wrapped line and only spill to
  // a second row when they genuinely don't fit.
  const chW = (v: string, max = 40) => ({ width: `${Math.min(max, Math.max(6, v.trim().length + 2))}ch` });
  // Notes can be multi-line, so size them to the widest line, not the whole
  // string's length (which would over-widen a stack of short lines). The floor
  // is generous — notes are prose, and a freshly added one should offer a
  // sentence's worth of room, not a token-sized box.
  const noteW = (v: string, max = 50) => {
    const longest = v.split("\n").reduce((m, line) => Math.max(m, line.length), 0);
    return { width: `${Math.min(max, Math.max(18, longest + 2))}ch` };
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
  // A custom EVEN/FACT is named by its TYPE, so its Title field always shows.
  const typeShown = isEven || Boolean(typeField.value.trim()) || typeField.isMerge;
  const valueExtraShown = valueIsExtra && (Boolean(valueField.value.trim()) || valueField.isMerge);
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
    value: valueExtraShown || revealed.has("value"),
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
    ...(valueIsExtra ? [{ key: "value", label: t("event.colValue") }] : []),
    { key: "place", label: t("event.colPlace") },
    { key: "addr", label: t("event.colAddr") },
    { key: "agency", label: t("event.colAgency") },
    { key: "source", label: t("event.colLink") },
    { key: "type", label: isEven ? t("event.colTitle") : t("event.colType") },
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
  // and/or the event copied or removed — the latter two via "Copy event to…" /
  // "Remove this event" entries appended to the end of the list.
  const showSelect = Boolean(tag) && (Boolean(onChangeTag && tagGroups) || Boolean(onCopy) || Boolean(onRemove));

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
    // An untouched note is omitted rather than re-sent: its displayed text is a
    // stripped projection (URLs pulled into links; shared-note text resolved
    // from the record), so rewriting it as collateral of another field's commit
    // would flatten a shared-note pointer / drop the note's URLs. A still-shown
    // merge-incoming value is not "untouched" — it must materialize like the
    // other suggested fields (see the docstring above).
    if (override.note === undefined && !noteField.isMerge && noteField.value === noteField.initial) {
      delete merged.note;
    }
    // Fields with no text input behind them have no `initial` to compare against,
    // so an override carrying one is a change by definition. Without this, picking
    // a coordinate while every text field stays as it was reads as "unchanged" and
    // is silently dropped.
    const nonTextChange = override.coord !== undefined || override.links !== undefined || override.addSource !== undefined;
    const unchanged =
      !nonTextChange &&
      (merged.date ?? "") === dateField.initial &&
      (merged.value ?? "") === valueField.initial &&
      (merged.place ?? "") === placeField.initial &&
      (merged.address ?? "") === addrField.initial &&
      (merged.note === undefined || merged.note === noteField.initial) &&
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
    combos?: { place: string; addr: string }[],
    onPickCombo?: (place: string, addr: string) => void,
    lookupProps?: {
      onLookup?: (query: string) => Promise<PlaceProposal[]>;
      lookupNote?: string;
      onPickProposal?: (proposal: PlaceProposal) => void;
    },
  ) {
    return (
      <span key={key} data-detail={key} className={"edit-event-extra" + optCls(shown)}>
        <span className="edit-event-extra-label">{labelText}</span>
        <PlaceAutocomplete
          value={field.value}
          suggestions={suggestions}
          canonical={canonical}
          combos={combos}
          isDirty={field.isDirty || forced}
          isMerge={field.isMerge}
          className={"edit-input " + cls}
          wrapClassName="edit-event-extra-field"
          wrapStyle={chW(field.value)}
          title={title}
          onChange={field.set}
          onCommit={commit}
          onClear={() => { field.clear(); commit(""); }}
          onPickCombo={onPickCombo}
          {...lookupProps}
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
          title={
            isEven
              ? t("event.customTooltip", { tag: tag ?? "EVEN" })
              : tag
                ? vendorEventTooltip(tag, t, i18n.language)
                : undefined
          }
        >
          {customName || label}
          {showSelect && (
            <>
              <span className="edit-event-type-caret" aria-hidden="true">▾</span>
              <select
                className="edit-event-type-select"
                value={tag}
                title={onChangeTag ? t("edit.changeEventType") : onCopy ? t("edit.copyEvent") : t("edit.removeEvent")}
                onKeyDown={openPickerOnEnter}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === COPY_OPTION) onCopy?.();
                  else if (v === REMOVE_OPTION) onRemove?.();
                  else if (onChangeTag && v !== tag) onChangeTag(v);
                }}
              >
                {onChangeTag && tagGroups ? (
                  tagGroups.map((g, gi) =>
                    g.labelKey ? (
                      <optgroup key={g.labelKey} label={t(g.labelKey)}>
                        {g.tags.map((tg) => (
                          <option key={tg} value={tg}>{eventDisplayLabel(tg, t)}</option>
                        ))}
                      </optgroup>
                    ) : (
                      g.tags.map((tg) => (
                        <option key={`${gi}-${tg}`} value={tg}>{eventDisplayLabel(tg, t)}</option>
                      ))
                    ),
                  )
                ) : (
                  <option value={tag}>{label}</option>
                )}
                {onCopy && (
                  <option value={COPY_OPTION}>{t("edit.copyEvent")}</option>
                )}
                {onRemove && (
                  <option value={REMOVE_OPTION}>{t("edit.removeEvent")}</option>
                )}
              </select>
            </>
          )}
        </div>
      </div>

      {/* Leading item 2: the date — the input fills its fixed slot (text kept
       * right-aligned so the years line up in a column); the age badge follows
       * outside the slot so it never changes the date's position or size. */}
      <div className={"edit-event-date-cell" + optCls(show.date)}>
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
      </div>
      {age && (
        <span className="edit-event-age gm-data">
          {age.map((a, i) => (
            <span key={i} title={a.title}>{a.text}</span>
          ))}
        </span>
      )}

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
            wrapStyle={chW(valueField.value, 60)}
            className={fieldCls("edit-input edit-event-value", valueField.isMerge, valueField.isDirty || valueForced)}
            value={valueField.value}
            placeholder={t("event.colTitle")}
            title={label}
            onChange={valueField.onChange}
            onBlur={() => commitAll({})}
            onClear={() => { valueField.clear(); commitAll({ value: "" }); }}
          />
        )}
        {/* Place — the same everywhere: unlabelled (a place reads as a place) and
         * shown only when it has content, so no event reserves an empty slot. */}
        <span data-detail="place" className={"edit-event-extra edit-event-extra--place" + optCls(show.place)}>
          <PlaceAutocomplete
            value={placeField.value}
            suggestions={placeSuggestions}
            canonical={placeCanonical}
            combos={placeCombos}
            isDirty={placeField.isDirty || placeForced}
            isMerge={placeField.isMerge}
            className="edit-input edit-event-place"
            wrapClassName="edit-event-extra-field"
            wrapStyle={chW(placeField.value, 60)}
            title={t("event.place", { event: label })}
            onChange={placeField.set}
            onCommit={(val) => {
              // Picking (or typing) a place the file already knows brings its
              // coordinate along, so the event is placed without a second step.
              const known = knownCoord(val, addrField.value);
              commitAll({ place: val, ...(known ? { coord: known } : {}) });
            }}
            onClear={() => { placeField.clear(); commitAll({ place: "" }); }}
            onPickCombo={pickCombo}
            onPickProposal={pickProposal}
            // A place is looked up on its own; with online lookups off the
            // imported gazetteer still answers, so the search stays offered.
            onLookup={lookup ? (query) => lookup.search(query) : undefined}
            lookupNote={lookup && !lookup.online ? t("event.place.lookup.offlineOnly") : undefined}
          />
          {/* This event's own coordinate: a pin showing whether it has one, and
           *  opening the per-event picker. Here rather than only in the Tools
           *  list because the same place value may be coordinated on one event
           *  and not another — and because the Tools list only offers places
           *  *missing* a coordinate, so a settlement-pinned place whose address
           *  could be pinned at the house has no row there. */}
          {(fileUsesCoords || coord) && (
          <EventCoordPicker
            place={placeField.value}
            address={addrField.value}
            coord={coord}
            title={label}
            // What the file already knows for this place / this exact address,
            // so the picker can propose it without any lookup.
            fileCoord={placeCoords.get(placeKey(placeField.value))}
            filePairCoord={
              addrField.value.trim() ? pairCoords.get(placeAddrCoordKey(placeField.value, addrField.value)) : undefined
            }
            onPick={(c) => commitAll({ coord: c })}
            onClear={() => commitAll({ coord: null })}
          />
          )}
        </span>
        {extraPlace("addr", t("event.colAddr"), show.addr, addrField, addrForced, placeToAddrs.get(placeKey(placeField.value)) ?? [], addrCanonical, "edit-event-addr", t("event.addr", { event: label }), (val) => {
          const known = knownCoord(placeField.value, val);
          commitAll({ address: val, ...(known ? { coord: known } : {}) });
        }, addrCombos, pickCombo, {
          // An address is looked up inside the event's place — and only online:
          // house numbers are in the address registers, never in an imported
          // gazetteer, so with the opt-in off the row says why instead of
          // offering a search that could not answer.
          onLookup: lookup?.online ? (query) => lookup.searchAddress(placeField.value, query) : undefined,
          lookupNote: lookup && !lookup.online ? t("tools.geocode.downloadNeedsOptIn") : undefined,
          onPickProposal: pickProposal,
        })}
        {/* The tag's own line value, for events that lead with the date instead
            of it (RESI) — otherwise it is the primary field rendered above. */}
        {valueIsExtra && extraText("value", t("event.colValue"), show.value, valueField, valueForced, t("event.value", { event: label }), { value: "" })}
        {extraText(
          "type",
          isEven ? t("event.colTitle") : t("event.colType"),
          show.type,
          typeField,
          typeForced,
          isEven ? t("event.customTooltip", { tag: tag ?? "EVEN" }) : t("event.type", { event: label }),
          { type: "" },
        )}
        {extraText("agency", t("event.colAgency"), show.agency, agencySlotField, agencySlotForced, agencySlotLabel, agencyClearUpdate)}
        {extraText("cause", t("event.colCause"), show.cause, causeField, causeForced, t("event.cause", { event: label }), { cause: "" })}
        {/* Sources and links lead the note: the note is a textarea that grows to
            as many lines as it holds, and after it the icons ended up alone at
            the foot of a tall row, far from the event they belong to. */}
        <span className={"edit-event-extra edit-event-extra--sources" + optCls(sourcesShown)}>
          {/* Labelled like every other field on the row — a bare 📖 between the
              agency and the note said nothing about what it opens. Same wording
              as the add-detail menu's entry for this field. */}
          <span className="edit-event-extra-label">{t("event.colLink")}</span>
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
              {siteIconForUrl(link) ?? "🔗"}
            </button>
          ))}
        </span>
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
        {/* Add a source / place / note / other detail without keeping every empty
         * field on screen — the menu offers only the ones not already shown. A
         * real (visible) <select> so it's reliably keyboard-openable, unlike the
         * opacity-0 overlay chips. */}
        {addable.length > 0 && (
          <select
            className="edit-event-addfield"
            value=""
            title={t("edit.addDetailTooltip")}
            onKeyDown={openPickerOnEnter}
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
