import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { renderKeyToken } from "../../keyboard/shortcuts";
import { useFindShortcutOn } from "../../keyboard/useFindShortcut";
import type { Dataset, GeoCoord } from "../../gedcom/types";
import type { MiniMapPin } from "../map/MiniPlaceMap";
import type { SourceUse } from "../../tools/sources";
import { lineageClass, type KinshipResolver } from "../../match/kinship";
import { PersonLink } from "../PersonLink";
import { PinIcon } from "../icons/PinIcon";

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
  const { t } = useTranslation();
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
              const label = ev.tag === "EVEN" && ev.type ? ev.type : t(`event.${ev.tag}`, { defaultValue: ev.tag });
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
  children,
}: {
  open: boolean;
  onToggle: () => void;
  place: React.ReactNode;
  /** Shown after the place, muted — for the lists whose unit is a pair. */
  address?: string;
  /** Rendered before the caret (a checkbox, in the place list). */
  before?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="tools-tree-row">
      {before}
      <button className={`tools-pair-toggle ${open ? "open" : ""}`} aria-expanded={open} onClick={onToggle}>
        ▶
      </button>
      <span className="tools-tree-label clickable" onClick={onToggle}>
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
 * It carries the app's pin, which marks a position everywhere else.
 */
export function MapToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  return (
    <button className="tools-issue-link tools-map-toggle" onClick={onToggle}>
      <PinIcon />
      {t(open ? "tools.geocode.hideMap" : "tools.geocode.showMap")}
    </button>
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
