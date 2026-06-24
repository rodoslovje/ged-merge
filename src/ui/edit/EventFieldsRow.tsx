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
