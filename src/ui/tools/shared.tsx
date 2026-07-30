import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { renderKeyToken } from "../../keyboard/shortcuts";
import { useFindShortcutOn } from "../../keyboard/useFindShortcut";
import type { Dataset } from "../../gedcom/types";
import type { SourceUse } from "../../tools/sources";
import { PersonLink } from "../PersonLink";

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

/** Show or hide a row's map. The map is never drawn until asked for: Leaflet is
 *  a lazy chunk, and a list of hundreds of rows must not mount hundreds of them. */
export function MapToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  return (
    <button className="tools-issue-link" onClick={onToggle}>
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
