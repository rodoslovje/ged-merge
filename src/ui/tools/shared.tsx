import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { renderKeyToken } from "../../keyboard/shortcuts";
import { useFindShortcutOn } from "../../keyboard/useFindShortcut";
import type { Dataset, GeoCoord } from "../../gedcom/types";
import { formatCoord } from "../../geo/points";
import { customEventLabel } from "../../gedcom/eventTags";
import type { MiniMapPin } from "../map/MiniPlaceMap";
import type { SourceUse } from "../../tools/sources";
import { lineageClass, type KinshipResolver } from "../../match/kinship";
import { PersonLink } from "../PersonLink";
import { foldSearch, matchesTerms } from "../globalSearch";
import { useNameOf } from "../SettingsContext";
import { MapIcon } from "../icons/MapIcon";
import { PlaceAutocomplete } from "../edit/PlaceAutocomplete";
import { usePlaceLookup } from "../edit/PlaceLookupContext";
import { placeKey, type PlaceSuggestions } from "../edit/placeSuggestions";
import type { PlaceProposal } from "../../geo/placeProposal";

const MiniPlaceMap = lazy(() => import("../map/MiniPlaceMap"));

/** A Tools-tab "working…" placeholder: the same spinner + accent row the file
 *  loader uses for "Parsing and validating…", shown while a panel computes.
 *  Long worker scans also report progress and can offer a cancel button. */
export function ToolsLoading({
  label,
  progress,
  bytes,
  onCancel,
}: {
  label: string;
  progress?: { done: number; total: number };
  /** Treat `progress` as byte counts, so a download whose length the server
   *  never announced (chunked transfer, no Content-Length) can still show how
   *  much has arrived. A percentage there would read 100 % from the first
   *  chunk onwards and look stuck. */
  bytes?: boolean;
  onCancel?: () => void;
}) {
  const { t } = useTranslation();
  const known = progress && progress.total > 0;
  return (
    <div className="tools-loading">
      <div className="parsing-status">
        <span className="spinner" aria-hidden="true" />
        {label}
        {known && ` ${Math.round((progress.done / progress.total) * 100)} %`}
        {!known && bytes && progress && progress.done > 0 && ` ${(progress.done / 1048576).toFixed(1)} MB`}
      </div>
      {onCancel && (
        <button className="nav-btn tools-run" onClick={onCancel}>
          {t("confirm.cancel")}
        </button>
      )}
    </div>
  );
}

/** Shown when a worker scan failed (parity with the old sync scans, which
 *  would have thrown to the console and left the spinner up forever). */
export function ToolsError({ message }: { message: string }) {
  const { t } = useTranslation();
  return <p className="tools-clean">{t("tools.scan.error", { message })}</p>;
}

/** Records that cite a source/media or use a place; each navigates into Edit. */
export function UsageList({ dataset, uses, onNavigate }: { dataset: Dataset; uses: SourceUse[]; onNavigate: (id: string) => void }) {
  if (uses.length === 0) return null;
  return (
    <ul className="tools-usage">
      {uses.map((u, i) => (
        <li key={`${u.persons.map((p) => p.id).join("-")}-${i}`}>
          {u.persons.map((p, j) => (
            <span key={p.id}>
              {j > 0 && <span className="tools-usage-amp">&amp;</span>}
              <PersonLink dataset={dataset} id={p.id} fallback={p.label} onNavigate={onNavigate} />
            </span>
          ))}
        </li>
      ))}
    </ul>
  );
}

/**
 * A row's own map, in the Leaflet lazy chunk it shares with the Map chart — the
 * one way the three geocoding lists draw one. Each of them mounts at most one:
 * a list runs to hundreds of rows, and a map is never drawn until a row asks
 * for it, so the fallback below is what a row shows for the moment it takes to
 * arrive.
 */
export function RowMap({
  pins,
  context,
  title,
  fitKey,
  fitMaxZoom,
  onPickCoord,
}: {
  pins: MiniMapPin[];
  /** Faint dots for the coordinates the file already carries elsewhere — the
   *  family cluster that tells two same-named places apart. */
  context?: { coord: GeoCoord; name: string }[];
  title?: string;
  fitKey?: string;
  /** Closer than the default region framing, where answers for one name sit a
   *  few hundred metres apart and would otherwise pile into one dot. */
  fitMaxZoom?: number;
  onPickCoord?: (coord: GeoCoord) => void;
}) {
  return (
    <Suspense fallback={<div className="tools-geo-minimap" />}>
      <MiniPlaceMap
        pins={pins}
        {...(context ? { context } : {})}
        {...(title ? { title } : {})}
        {...(fitKey ? { fitKey } : {})}
        {...(fitMaxZoom ? { fitMaxZoom } : {})}
        {...(onPickCoord ? { onPickCoord } : {})}
      />
    </Suspense>
  );
}

/**
 * What the last write on this list did, standing at the end of the list's own
 * action row rather than in a paragraph of its own: the eye is on the button it
 * just pressed, and a line appearing under the intro moves the whole list down
 * to say so. A write that changed nothing says so in words — "0 updated
 * records" reads as the button having done nothing at all, when what happened
 * is that the file already held the value.
 */
export function AppliedNote({ count }: { count: number | null }) {
  const { t } = useTranslation();
  if (count === null) return null;
  return (
    <span className="tools-applied-note">
      {count === 0 ? t("tools.geocode.appliedNone") : t("tools.geocode.applied", { count })}
    </span>
  );
}

/**
 * Who a place belongs to: the standard person links (sex colour, lifespan, click
 * to open in Edit), each with its kinship chip and the number of events that
 * person has at this exact place, whose labels and dates make up its tooltip.
 *
 * Shared by the place lists that hang one off a row's count — the geocode review
 * and the register check ask the same question of the same value, so they answer
 * it the same way.
 */
export function GeoPeopleList({
  dataset,
  ids,
  place,
  kinship,
  onNavigate,
  limit = 30,
}: {
  dataset: Dataset;
  ids: readonly string[];
  /** The exact raw PLAC value the people are listed for. */
  place: string;
  kinship?: KinshipResolver;
  onNavigate: (id: string) => void;
  limit?: number;
}) {
  const { t, i18n } = useTranslation();
  return (
    <>
      <ul className="tools-usage tools-geo-people">
        {ids.slice(0, limit).map((id) => {
          const indi = dataset.individuals.get(id);
          const kin = kinship?.label(id);
          // The person's events at this exact place — their own and their
          // families', matching how the scans attribute a family PLAC to both
          // spouses.
          const placeEvents = indi
            ? [...indi.events, ...indi.spouseOf.flatMap((fid) => dataset.families.get(fid)?.events ?? [])].filter(
                (ev) => ev.place?.raw.trim() === place,
              )
            : [];
          const placeEventsTitle = placeEvents
            .map((ev) => {
              const custom = ev.tag === "EVEN" ? customEventLabel(ev.type, t, i18n.language) : "";
              const label = custom || t(`event.${ev.tag}`, { defaultValue: ev.tag });
              return ev.date?.raw ? `${label}: ${ev.date.raw}` : label;
            })
            .join("\n");
          return (
            <li key={id}>
              <PersonLink dataset={dataset} id={id} fallback={id} onNavigate={onNavigate} />
              {kin && <span className={`person-kinship ${lineageClass(kinship?.lineage(id))}`}>{kin}</span>}
              {indi && placeEvents.length > 0 && (
                <span className="tools-chip-count" title={placeEventsTitle}>
                  {placeEvents.length}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {ids.length > limit && (
        <p className="tools-geo-more">{t("tools.geocode.morePeople", { count: ids.length - limit })}</p>
      )}
    </>
  );
}

/** Returns `value` delayed by `delay` ms — updates only after typing pauses,
 * so the tree isn't re-filtered on every keystroke. */
export function useDebounced<T>(value: T, delay = 200): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

/**
 * Every person's name in the file, folded for searching, by xref — so a list
 * whose rows know only *which* people they concern can still be searched by
 * the name of one. Built once per dataset (the lists that use it memoize on
 * the dataset object), never per row and never per keystroke.
 */
export function usePersonNameIndex(dataset: Dataset): Map<string, string> {
  const nameOf = useNameOf();
  return useMemo(() => {
    const names = new Map<string, string>();
    // Every name the person carries, not just the displayed one: a woman filed
    // under her maiden name is looked for under her married one just as often.
    for (const [id, indi] of dataset.individuals) {
      const all = [nameOf(indi), ...indi.names.map((n) => n.full ?? "")].filter(Boolean).join(" ");
      names.set(id, foldSearch(all));
    }
    return names;
    // The dataset object is replaced on load and mutated in place by edits; a
    // name changed by an edit reaches the box on the next load, which is as
    // often as any other tools list re-reads it.
  }, [dataset, nameOf]);
}

/** True when one of these people's names carries every term of the query. */
export function personMatches(
  ids: readonly string[] | undefined,
  names: Map<string, string>,
  terms: readonly string[],
): boolean {
  if (!ids?.length || !terms.length) return false;
  return ids.some((id) => {
    const name = names.get(id);
    return !!name && matchesTerms(name, terms);
  });
}

/** True when any of the strings contain `q` (already lower-cased). */
export const someMatch = (q: string, ...vals: (string | undefined)[]) =>
  vals.some((v) => v?.toLowerCase().includes(q));

/** Shared search box for the Sources/Places explorers. A clear button appears
 *  once there's text to clear. */
export function TreeSearch({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  // ⌘/Ctrl+F focuses this box — but only for the panel actually on screen: the
  // Tools layer is `display:none` while another mode shows, and the sub-tabs
  // that aren't open render nothing.
  useFindShortcutOn(inputRef);
  return (
    <div className="tools-search">
      <input
        ref={inputRef}
        type="text"
        className="tools-search-input"
        placeholder={t("tools.search.placeholder")}
        title={t("tools.search.tooltip", { key: `${renderKeyToken("mod")}F` })}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button
          type="button"
          className="tools-search-clear"
          onClick={() => onChange("")}
          title={t("tools.search.clear")}
          aria-label={t("tools.search.clear")}
        >
          ✕
        </button>
      )}
    </div>
  );
}

// ── Geocode-page row furniture ───────────────────────────────────────────────
// The three lists on the Geocode page (places, addresses, coordinate conflicts)
// review different things but ask the same question of the reader — "is this the
// right point for this place?" — so they open with the same row and offer the
// same map. These are what keeps them looking like one tool rather than three.

/**
 * The ▶ every list on these two pages opens a row from.
 *
 * Its own component rather than part of {@link GeoRowHeader}: the geocoding
 * addresses row lays its head out itself — a checkbox, the address, a rename ✎
 * and a pin all on one line — so it cannot take the whole header, but the caret
 * is the piece that has to look and behave the same everywhere, and it was
 * copied out by hand there.
 */
export function RowCaret({
  open,
  onToggle,
  label,
  title,
}: {
  open: boolean;
  onToggle: () => void;
  /** What the caret opens, for a screen reader — the row's own name. */
  label?: string;
  title?: string;
}) {
  return (
    <button
      className={`tools-pair-toggle ${open ? "open" : ""}`}
      aria-expanded={open}
      {...(label ? { "aria-label": label } : {})}
      {...(title ? { title } : {})}
      onClick={onToggle}
    >
      ▶
    </button>
  );
}

/**
 * A list row's collapsible header: an optional leading control (the place
 * list's write checkbox), the caret, the place — and the address beside it when
 * the row is about a place+address pair — then whatever else the list shows.
 */
export function GeoRowHeader({
  open,
  onToggle,
  place,
  address,
  before,
  caret = true,
  className,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  place: React.ReactNode;
  /** Extra classes on the row line — for the address lists, whose rows carry
   *  enough on one line to need it to wrap. */
  className?: string;
  /** Shown after the place, muted — for the lists whose unit is a pair. */
  address?: string;
  /** Rendered before the caret (a checkbox, in the place list). */
  before?: React.ReactNode;
  /** False on a row that has nothing to disclose. Its people are reached by
   *  their own count, as everywhere else, and a caret standing open over an
   *  empty body would only promise a detail the row does not have. */
  caret?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className={className ? `tools-tree-row ${className}` : "tools-tree-row"}>
      {before}
      {caret ? (
        <RowCaret open={open} onToggle={onToggle} />
      ) : (
        <span className="tools-pair-toggle-spacer" aria-hidden="true" />
      )}
      <span className={caret ? "tools-tree-label clickable" : "tools-tree-label"} onClick={caret ? onToggle : undefined}>
        {place}
        {address && <span className="tools-geo-row-addr"> · {address}</span>}
      </span>
      {children}
    </div>
  );
}

/**
 * Show or hide a row's map. Opening a row by hand draws it already — the Edit
 * view's coordinate panel does the same, and it is the same question — so this
 * is how it is put away, and how it is fetched back for a row opened some other
 * way (through its people count, or by Expand all, which deliberately mounts
 * none: Leaflet is a lazy chunk and a list runs to hundreds of rows).
 *
 * Icon and words are the Edit view's own map toggle's: a folded map, "Show
 * map" / "Hide map". The pin is for a position — a coordinate an event holds —
 * and this is not that.
 */
export function MapToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const label = t(open ? "edit.mapHide" : "edit.mapShow");
  return (
    <button className="tools-issue-link tools-map-toggle" onClick={onToggle} aria-expanded={open} title={label}>
      <MapIcon size={15} />
      {label}
    </button>
  );
}

/**
 * The ✎ (U+270E) that opens a row's rename editor, and the ✕ that closes it —
 * the same mark the places tree, both geocoding lists, the compliance lists and
 * Organize sources put beside a value they let you rewrite.
 *
 * One component because "you can edit this here" is a promise the whole of these
 * two pages makes, and a list that draws the mark half a pixel differently — or
 * forgets it — reads as a list where the value is not yours to fix.
 */
export function RenameToggle({
  open,
  onOpen,
  onClose,
  title,
}: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  /** What opening it would let you rewrite — this row's value. */
  title: string;
}) {
  const { t } = useTranslation();
  return open ? (
    <button
      className="tools-place-edit-btn tools-place-edit-cancel"
      onClick={onClose}
      title={t("tools.places.rename.cancel")}
    >
      ✕
    </button>
  ) : (
    <button className="tools-place-edit-btn" onClick={onOpen} title={title}>
      ✎
    </button>
  );
}

/**
 * The editor that row unfolds: a place-completing text field and the button
 * that writes it, with Enter to apply and Escape to abandon.
 *
 * `children` is for whatever else a particular list writes alongside — the
 * compliance places row's "and leave this house on the ADDR line" chip. The
 * keyboard contract is the part worth having in one place: the autocomplete
 * takes Enter while a suggestion is highlighted and Escape while its dropdown
 * is open (both marked handled), and only the presses it leaves alone belong to
 * the editor.
 *
 * A list that has an answer for the field left empty passes `onRemove`: the
 * button then says so and does that instead, because clearing a value the file
 * carries and giving it a new one are the same act asked in one field — and the
 * alternative was a second control that is dead in every other state.
 */
export function RenameEditor({
  value,
  suggestions,
  canonical,
  placeholder,
  applyDisabled,
  applyLabel,
  onChange,
  onApply,
  onCancel,
  onRemove,
  removeLabel,
  removeTitle,
  autoFocus = true,
  children,
  ...lookup
}: {
  value: string;
  suggestions: string[];
  /** Folded value → the spelling the file settled on, so a typed variant snaps
   *  to the one already in use. */
  canonical: Map<string, string>;
  placeholder?: string;
  applyDisabled?: boolean;
  /** The button's word where "Rename" is not what this apply does — the places
   *  tree, whose target may be a name standing beside this one, in which case
   *  the rename is a merge and says so. */
  applyLabel?: string;
  onChange: (value: string) => void;
  onApply: () => void;
  onCancel: () => void;
  /** What an emptied field means, where emptying it means anything — without
   *  it, an empty field simply leaves the apply button disabled. */
  onRemove?: () => void;
  /** The button's word while the field is empty (required with `onRemove`). */
  removeLabel?: string;
  /** What removing would do, for the button's tooltip. */
  removeTitle?: string;
  /** Whether the field takes the keyboard as it appears. True where the editor
   *  is only ever mounted by the click that opens it; the lists whose rows come
   *  and go under a filter pass false once the editor has had its focus, so a
   *  row returning to the list cannot pull the caret out of the filter box. */
  autoFocus?: boolean;
  children?: React.ReactNode;
} & Pick<
  ComponentProps<typeof PlaceAutocomplete>,
  "onLookup" | "lookupNote" | "onPickProposal" | "combos" | "matchCombosByPlace" | "onPickCombo"
>) {
  const { t } = useTranslation();
  const removing = !value.trim() && !!onRemove;
  const apply = () => (removing ? onRemove!() : onApply());
  return (
    <div
      className="tools-place-rename"
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.defaultPrevented) apply();
        if (e.key === "Escape" && !e.defaultPrevented) onCancel();
      }}
    >
      <PlaceAutocomplete
        value={value}
        suggestions={suggestions}
        canonical={canonical}
        isDirty={false}
        className="tools-place-rename-input"
        wrapClassName="tools-place-rename-auto"
        {...(placeholder ? { placeholder } : {})}
        autoFocus={autoFocus}
        // A rename may be exactly a casing fix ("Pod Gozdom" → "pod gozdom") —
        // the canonical map must not snap it back on blur.
        preserveCase
        onChange={onChange}
        onCommit={onChange}
        onClear={() => onChange("")}
        {...lookup}
      />
      {children}
      <button
        className={"nav-btn tools-place-rename-apply " + (removing ? "danger" : "primary")}
        onClick={apply}
        disabled={removing ? false : applyDisabled}
        {...(removing && removeTitle ? { title: removeTitle } : {})}
      >
        {removing ? removeLabel : (applyLabel ?? t("tools.places.rename.apply"))}
      </button>
    </div>
  );
}

/**
 * One answer a row offers, in the shape all four of these lists offer answers:
 * the number that is also the radio, the name, whatever the list has to say
 * about that particular hit, the position it puts the place at, and the badge
 * naming where it came from.
 *
 * The number *is* the control. The input stays for the keyboard and for screen
 * readers, clipped out of sight — a second round control beside the number
 * would be one dot too many — and the number carries the same value the pin on
 * the map wears, which is what tells four answers spelled alike apart.
 *
 * Clicking the option a row already stands on clears it: a radio group has no
 * "none" of its own, and a row picked by mistake would otherwise be written.
 * Lists with nothing to clear to leave {@link onUnpick} off.
 */
export function CandidateOption({
  group,
  number,
  label,
  labelClass,
  title,
  ariaLabel,
  checked,
  disabled,
  onPick,
  onUnpick,
  coord,
  coordPrefix,
  coordTitle,
  onCoord,
  badge,
  className,
  children,
}: {
  /** Radio-group name — one per row, so picking here cannot unpick there. */
  group: string;
  /** Its place in the row's own list; shared by answers standing on one point. */
  number?: number;
  label: React.ReactNode;
  /** A class the name itself carries — the address pin on a register's house,
   *  which marks it as a building rather than another spelling of the village
   *  above it. */
  labelClass?: string;
  title?: string;
  /** Spoken name, where the visible one is not enough on its own. */
  ariaLabel?: string;
  checked: boolean;
  disabled?: boolean;
  onPick: () => void;
  onUnpick?: () => void;
  /** Where this answer puts the place. */
  coord?: GeoCoord;
  /** Rendered inside the coordinate, before the numbers (a population). */
  coordPrefix?: React.ReactNode;
  coordTitle?: string;
  /** Makes the coordinate the control that opens the row's coordinate panel,
   *  which draws every answer on one map under these same numbers. */
  onCoord?: () => void;
  /** What the answer is worth or where it came from, at the end of the line. */
  badge?: React.ReactNode;
  className?: string;
  /** What this list has to say about this hit — its kind, its municipality, the
   *  house a split would move out — between the name and the coordinate. */
  children?: React.ReactNode;
}) {
  const coordText = coord && (
    <>
      {coordPrefix}
      {formatCoord(coord)}
    </>
  );
  return (
    <li {...(className ? { className } : {})}>
      <label {...(title ? { title } : {})}>
        <input
          type="radio"
          className="tools-geo-cand-radio"
          name={group}
          {...(ariaLabel ? { "aria-label": ariaLabel } : {})}
          checked={checked}
          {...(disabled ? { disabled } : {})}
          onChange={onPick}
          // A checked radio fires no change event, so the click itself is what
          // takes a pick back.
          onClick={() => checked && onUnpick?.()}
        />
        {number !== undefined && <span className="tools-geo-cand-num">{number}</span>}
        <span className={labelClass ? `tools-geo-cand-name ${labelClass}` : "tools-geo-cand-name"}>{label}</span>
        {children}
        {coord &&
          (onCoord ? (
            <button
              type="button"
              className="tools-geo-coord-btn gm-data gm-coord"
              {...(coordTitle ? { title: coordTitle } : {})}
              onClick={(e) => {
                // The coordinate is a control of its own inside the label —
                // without this the click would pick the option as well.
                e.preventDefault();
                onCoord();
              }}
            >
              {coordText}
            </button>
          ) : (
            <span className="gm-data gm-coord">{coordText}</span>
          ))}
        {badge}
      </label>
    </li>
  );
}

/**
 * The address half of a rename that splits a value: the house on the event's own
 * `ADDR` line, beside the place it stands in.
 *
 * A field with the same three helps the place beside it has — what this file
 * already writes at that place, the place·address pairs it knows, and the
 * address register itself. The register matters most here: a house number is
 * exactly what a gazetteer of settlements cannot answer, and a value naming a
 * quarter of a town ("Čirče") is filed there as a street inside the town,
 * reachable only by asking for the address.
 */
export function AddressSplitField({
  place,
  value,
  placeSug,
  placeCombos,
  onChange,
  onPickCombo,
  onPickProposal,
}: {
  /** The place draft beside it — what the register is asked about the house
   *  *within*, and which of the file's addresses are offered plainly. */
  place: string;
  value: string;
  placeSug: PlaceSuggestions;
  /** Every place+address pair the file writes. */
  placeCombos: { place: string; addr: string }[];
  onChange: (value: string) => void;
  onPickCombo: (place: string, addr: string) => void;
  onPickProposal: (proposal: PlaceProposal) => void;
}) {
  const { t } = useTranslation();
  const lookup = usePlaceLookup();
  // Pairs at *other* places, since the addresses of the drafted place are
  // already its plain suggestions.
  const combos = useMemo(
    () => placeCombos.filter((cb) => placeKey(cb.place) !== placeKey(place)),
    [placeCombos, place],
  );
  return (
    <span className="tools-geo-addr-chip tools-geo-addr-chip--field" title={t("tools.geocode.renameAddrTooltip")}>
      {t("event.colAddr")}:
      <PlaceAutocomplete
        value={value}
        suggestions={placeSug.placeToAddrs.get(placeKey(place)) ?? []}
        canonical={placeSug.addrCanonical}
        combos={combos}
        // The pair list is this field's only route to another settlement, so a
        // typed place name matches too (as in the Edit row).
        matchCombosByPlace
        addresses
        isDirty={false}
        className="tools-geo-addr-chip-input"
        wrapClassName="tools-geo-addr-chip-auto"
        placeholder={t("tools.geocode.renameAddrPlaceholder")}
        onChange={onChange}
        onCommit={onChange}
        onClear={() => onChange("")}
        onPickCombo={onPickCombo}
        onPickProposal={onPickProposal}
        // House numbers live only in the online registers — an imported
        // gazetteer holds settlements — so with the opt-in off the field says
        // why instead of offering a search that cannot answer.
        onLookup={lookup?.online ? (query) => lookup.searchAddress(place, query) : undefined}
        lookupNote={lookup && !lookup.online ? t("tools.geocode.downloadNeedsOptIn") : undefined}
      />
    </span>
  );
}

/**
 * Open or close every row of a list, as one control rather than two: it offers
 * "expand all" whenever anything is still closed, and "collapse all" only once
 * everything is open. There is no state in which the other action is wanted, so
 * the pair was always one dead button.
 */
export function ExpandAllToggle({ allOpen, onToggle }: { allOpen: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  return (
    <button className="tools-issue-link" onClick={onToggle}>
      {t(allOpen ? "tools.sources.collapseAll" : "tools.sources.expandAll")}
    </button>
  );
}
