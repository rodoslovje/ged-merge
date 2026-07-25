import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
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
  return (
    <div className="tools-search">
      <input
        type="text"
        className="tools-search-input"
        placeholder={t("tools.search.placeholder")}
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
