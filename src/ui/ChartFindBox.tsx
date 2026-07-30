import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { lifespanOf } from "../gedcom/lifespan";
import { renderKeyToken } from "../keyboard/shortcuts";
import { useFindShortcutOn } from "../keyboard/useFindShortcut";
import { SearchIcon } from "./icons/SearchIcon";
import { useNameOf } from "./SettingsContext";
import type { ChartFind } from "./useChartFind";

/**
 * The chart's find box: type a name, press ⌕ (or Enter) and the canvas moves to
 * that person *within the current diagram* — the counter says how many places
 * they occupy and ‹ › walk between them. The global search (`/`) answers a
 * different question: it re-roots the chart on whoever is opened.
 *
 * When nobody by that name is drawn here but somebody in the file matches, the
 * box says so and offers to re-root on them, so a miss ends in one click rather
 * than a dead end.
 */
export function ChartFindBox({ find }: { find: ChartFind }) {
  const { t } = useTranslation();
  const nameOf = useNameOf();
  const inputRef = useRef<HTMLInputElement>(null);
  const { query, hits, position, step, miss, offChart } = find;
  const total = hits.length;

  // ⌘/Ctrl+F focuses the box instead of the browser's own find, which can't pan
  // the canvas to what it matched. The chart page sits on top of everything
  // else, so while it is mounted the chord is always its.
  useFindShortcutOn(inputRef, () => true);

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      // First Esc empties the box; a second one leaves it, so the chart's own
      // Esc-to-go-back stays reachable from the keyboard.
      e.stopPropagation();
      if (query) find.clear();
      else inputRef.current?.blur();
    }
  }

  const span = offChart ? lifespanOf(offChart) : "";

  return (
    <div className="chart-find">
      {/* Field and arrows never break apart; only the miss message drops to its
          own line, so a narrow controls row can't strand the ‹ › below the box. */}
      <div className="chart-find-row">
        <div className="chart-find-control">
          <button
            type="button"
            className="chart-find-go"
            title={t("chartFind.tooltip", { key: `${renderKeyToken("mod")}F` })}
            aria-label={t("chartFind.title")}
            onClick={() => step(1)}
          >
            <SearchIcon size={14} />
          </button>
          <input
            ref={inputRef}
            type="text"
            placeholder={t("chartFind.placeholder")}
            title={t("chartFind.tooltip", { key: `${renderKeyToken("mod")}F` })}
            value={query}
            onChange={(e) => find.setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {/* A *position*, so it appears with the jump the settled query makes —
              never as a bare match count for a search that hasn't moved yet. */}
          {position > 0 && (
            <span className="chart-find-count gm-data" title={t("chartFind.matches", { count: total })}>
              {position}/{total}
            </span>
          )}
          {query && (
            <button type="button" className="chart-find-clear" title={t("chartFind.clear")} onClick={find.clear}>
              ×
            </button>
          )}
        </div>
        {position > 0 && total > 1 && (
          <div className="chart-find-steps">
            <button type="button" title={t("chartFind.prev")} aria-label={t("chartFind.prev")} onClick={() => step(-1)}>
              ‹
            </button>
            <button type="button" title={t("chartFind.next")} aria-label={t("chartFind.next")} onClick={() => step(1)}>
              ›
            </button>
          </div>
        )}
      </div>
      {miss === "none" && <span className="chart-find-msg">{t("chartFind.none")}</span>}
      {miss === "offChart" && offChart && (
        <span className="chart-find-msg">
          {t("chartFind.offChart")}
          <button type="button" className="chart-find-goto" title={t("edit.tree.reroot")} onClick={find.goToOffChart}>
            {nameOf(offChart)}
            {span && <span className="gm-data"> {span}</span>}
          </button>
        </span>
      )}
    </div>
  );
}
