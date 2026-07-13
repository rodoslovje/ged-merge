import { memo, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  categorize,
  DEFAULT_CONFIG,
  type IndividualCandidate,
  type MatchCategory,
  type MatchResult,
} from "../match/types";
import {
  decisionKey,
  type CandidateDecision,
  type MatchDecisionStatus,
} from "../review/types";
import { formatFieldLabel } from "../review/fields";
import type { Dataset } from "../gedcom/types";
import { candidateLifespan, formatScore, importTotal, type Candidate, type Filters, type SortKey, type SortState } from "./matchView";
import { useSettings } from "./SettingsContext";
import { sexClass } from "./sex";
import { useVirtualList } from "./useVirtualList";

interface Props {
  result: MatchResult;
  /** Active sort keys, primary first then secondary. */
  sort: SortState[];
  onToggleSort: (key: SortKey) => void;
  filters: Filters;
  onFilters: (next: Filters) => void;
  /** Already filtered + sorted list for the active tab. */
  list: Candidate[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  decisions: Map<string, CandidateDecision>;
  /** Show the relationship-distance column (only meaningful with a start person). */
  showRelation: boolean;
  showFilters: boolean;
  /** Per-main kinship to the start person, shown under each name. */
  kinshipByMain?: Map<string, { label: string; lineageClass: string; tooltip?: string }>;
  /** Live main dataset, to resolve each row's record for the age suffix. */
  mainDataset: Dataset | undefined;
}

/** Shared attributes for the small, language-neutral column-header icons. */
const ICON_PROPS = {
  className: "col-ico",
  width: 14,
  height: 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

export function MatchResults({
  result,
  sort,
  onToggleSort,
  filters,
  onFilters,
  list,
  selectedIndex,
  onSelect,
  decisions,
  showRelation,
  showFilters,
  kinshipByMain,
  mainDataset,
}: Props) {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const total = result.individuals.length;

  // Rank 0 = primary (▲/▼), rank 1 = secondary (△/▽).
  const rankOf = (key: SortKey) => sort.findIndex((s) => s.key === key);
  const arrow = (key: SortKey) => {
    const r = rankOf(key);
    if (r < 0) return "";
    if (r === 0) return sort[r].dir === "asc" ? " ▲" : " ▼";
    return sort[r].dir === "asc" ? " △" : " ▽";
  };
  const cls = (key: SortKey, extra: string) => {
    const r = rankOf(key);
    const active = r === 0 ? " active" : r === 1 ? " active2" : "";
    return `sortbtn ${extra}${active}`;
  };

  // Only the rows near the viewport are mounted — an index-scale compare file
  // yields tens of thousands of candidates. scrollMargin mirrors the rows'
  // scroll-margin-top, so auto-scrolls clear the sticky header row.
  const virtual = useVirtualList({ count: list.length, estimate: 40, itemsKey: list, scrollMargin: 40 });

  // Keep the selected row visible as the user pages with Prev/Next or arrows.
  const { scrollToIndex } = virtual;
  useEffect(() => {
    if (window.innerWidth > 880) scrollToIndex(selectedIndex);
  }, [selectedIndex, list, scrollToIndex]);

  return (
    <div className="results">
      {showFilters && (
        <div className="filters">
          <div className="filter-row">
            <div className="name-search-wrap">
              <input
                type="text"
                className="name-search"
                placeholder={t("filter.search")}
                title={t("filter.searchTooltip")}
                value={filters.nameQuery}
                onChange={(e) => onFilters({ ...filters, nameQuery: e.target.value })}
                onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
              />
              {filters.nameQuery && (
                <button
                  className="name-search-clear"
                  onClick={() => onFilters({ ...filters, nameQuery: "" })}
                  tabIndex={-1}
                  aria-label={t("filter.clearSearch")}
                >
                  ✕
                </button>
              )}
            </div>
          </div>
          <div className="filter-row">
            <label className="filter-score" title={t("filter.scoreTooltip")}>
              <select
                className="score-select"
                value={filters.minScore}
                style={{ color: scoreColor(filters.minScore) }}
                onChange={(e) => onFilters({ ...filters, minScore: Number(e.target.value) })}
              >
                {[50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100].map((v) => (
                  <option key={v} value={v} style={{ color: "var(--text)" }}>
                    {v === 100 ? "100" : `≥ ${v}`}
                  </option>
                ))}
              </select>
            </label>
            <label className="filter-check" title={t("filter.newPeopleTooltip")}>
              <input
                type="checkbox"
                checked={filters.onlyImports}
                onChange={(e) => onFilters({ ...filters, onlyImports: e.target.checked })}
              />
              {t("filter.newPeople")}
            </label>
            <label className="filter-check" title={t("filter.newDataTooltip")}>
              <input
                type="checkbox"
                checked={filters.onlyNew}
                onChange={(e) => onFilters({ ...filters, onlyNew: e.target.checked })}
              />
              {t("filter.newData")}
            </label>
            <label className="filter-check" title={t("filter.linksTooltip")}>
              <input
                type="checkbox"
                checked={filters.onlyLinks}
                onChange={(e) => onFilters({ ...filters, onlyLinks: e.target.checked })}
              />
              {t("filter.links")}
            </label>
            <label className="filter-check" title={t("filter.differencesTooltip")}>
              <input
                type="checkbox"
                checked={filters.onlyDiff}
                onChange={(e) => onFilters({ ...filters, onlyDiff: e.target.checked })}
              />
              {t("filter.differences")}
            </label>
          </div>
        </div>
      )}

      {list.length === 0 ? (
        <p className="muted">
          {total === 0
            ? t("filter.noAboveThreshold")
            : t("filter.noPassFilter")}
        </p>
      ) : (
        <ul className="candidate-list">
          <li className="candidate-list-head">
            <button className={cls("label", "person-col")} onClick={() => onToggleSort("label")}>
              {t("list.person")}{arrow("label")}
            </button>
            {/* Decision status: confirmed / rejected / deferred. Sorting groups
               rows by status. Kept next to Person, the row it judges. */}
            <button
              className={cls("status", "status-h")}
              title={t("list.statusTooltip")}
              onClick={() => onToggleSort("status")}
            >
              <svg {...ICON_PROPS}>
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
              {arrow("status")}
            </button>
            <span className="candidate-metrics">
              <button
                className={cls("score", "badge-h")}
                title={t("list.score")}
                onClick={() => onToggleSort("score")}
              >
                {/* Match score: a target / bullseye. */}
                <svg {...ICON_PROPS}>
                  <circle cx="12" cy="12" r="10" />
                  <circle cx="12" cy="12" r="6" />
                  <circle cx="12" cy="12" r="2" />
                </svg>
                {arrow("score")}
              </button>
              {showRelation && (
                <button
                  className={cls("distance", "dist")}
                  title={t("list.distanceTooltip")}
                  onClick={() => onToggleSort("distance")}
                >
                  <svg {...ICON_PROPS}>
                    <circle cx="18" cy="5" r="3" />
                    <circle cx="6" cy="12" r="3" />
                    <circle cx="18" cy="19" r="3" />
                    <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                    <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                  </svg>
                  {arrow("distance")}
                </button>
              )}
              <button
                className={cls("importCount", "nd import")}
                title={t("list.importTooltip")}
                onClick={() => onToggleSort("importCount")}
              >
                {/* New persons (ancestors + descendants): a group of people. */}
                <svg {...ICON_PROPS}>
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
                {arrow("importCount")}
              </button>
              <button
                className={cls("newCount", "nd new")}
                title={t("list.newTooltip")}
                onClick={() => onToggleSort("newCount")}
              >
                {/* New data: a plus sign. */}
                <svg {...ICON_PROPS}>
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                {arrow("newCount")}
              </button>
              <button
                className={cls("linkCount", "nd link")}
                title={t("list.linkTooltip")}
                onClick={() => onToggleSort("linkCount")}
              >
                {/* New links: a chain link. */}
                <svg {...ICON_PROPS}>
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
                {arrow("linkCount")}
              </button>
              <button
                className={cls("diffCount", "nd diff")}
                title={t("list.diffTooltip")}
                onClick={() => onToggleSort("diffCount")}
              >
                {/* Differences: a not-equal sign. */}
                <svg {...ICON_PROPS}>
                  <line x1="5" y1="9" x2="19" y2="9" />
                  <line x1="5" y1="15" x2="19" y2="15" />
                  <line x1="17" y1="5" x2="7" y2="19" />
                </svg>
                {arrow("diffCount")}
              </button>
            </span>
          </li>
          <li className="v-spacer" style={{ height: virtual.padTop }} ref={virtual.topRef} aria-hidden />
          {list.slice(virtual.start, virtual.end).map((c, j) => {
            const i = virtual.start + j;
            return (
              <CandidateRow
                // Stable per candidate pair (no index): lets React reuse rows
                // across filter/sort changes instead of remounting the whole list.
                key={`${c.mainId}-${c.compareId}`}
                candidate={c}
                index={i}
                selected={i === selectedIndex}
                status={decisions.get(decisionKey("individual", c.mainId, c.compareId))?.status}
                showRelation={showRelation}
                kinship={kinshipByMain?.get(c.mainId)}
                onSelect={onSelect}
                mainDataset={mainDataset}
                showAge={settings.showAge}
              />
            );
          })}
          <li className="v-spacer" style={{ height: virtual.padBottom }} ref={virtual.bottomRef} aria-hidden />
        </ul>
      )}
    </div>
  );
}

const CandidateRow = memo(function CandidateRow({
  candidate,
  index,
  selected,
  status,
  showRelation,
  kinship,
  onSelect,
  mainDataset,
  showAge,
}: {
  candidate: IndividualCandidate;
  index: number;
  selected: boolean;
  status: MatchDecisionStatus | undefined;
  showRelation: boolean;
  kinship?: { label: string; lineageClass: string; tooltip?: string };
  onSelect: (index: number) => void;
  mainDataset: Dataset | undefined;
  showAge: boolean;
}) {
  const { t } = useTranslation();
  const lifespan = candidateLifespan(candidate, mainDataset, showAge, t);

  // Cached per candidate, so re-renders triggered only by an index shift (e.g.
  // a filter toggle) don't rebuild this string for every row.
  const scoreTooltip = useMemo(
    () =>
      candidate.score === 1
        ? undefined
        : candidate.components
            .map((c) => {
              const label = formatFieldLabel(t, c.key);
              const detail = c.score === 1 ? "" : c.detail ? ` (${c.detail})` : "";
              const missing = c.missing ? " missing" : "";
              return `${label}: ${Math.round(c.score * 100)}%${missing}${detail}`;
            })
            .join("\n"),
    [candidate, t],
  );

  return (
    <li className={`candidate ${candidate.category}${selected ? " selected" : ""}`}>
      <div className="candidate-head">
        <button className="candidate-main" onClick={() => onSelect(index)}>
          <span className={`person-label ${sexClass(candidate.sex)}`}>
            <span className="person-name">{candidate.name}</span>
            {lifespan.span && (
              <span className="person-years gm-data" title={lifespan.title}>
                {lifespan.span}
              </span>
            )}
            {candidate.relationshipLinked && (
              <span className="rel-tree-badge" title={t("list.relationshipLinked")}>🌳</span>
            )}
            {candidate.uidMatched && (
              <span className="rel-tree-badge" title={t("list.uidMatched")}>🔑</span>
            )}
            {kinship && (
              <span className={`candidate-kinship ${kinship.lineageClass}`} title={kinship.tooltip}>
                {kinship.label}
              </span>
            )}
          </span>
          {status && status !== "undecided" ? (
            <span className={`status-chip ${status}`} title={t(`status.${status}`)}>
              {t(`status.${status}`).charAt(0)}
            </span>
          ) : (
            <span className="status-chip status-empty" aria-hidden />
          )}
          <span className="candidate-metrics">
            <span className={`badge ${candidate.category}`} title={scoreTooltip}>
              {formatScore(candidate.score)}
            </span>
            {showRelation && (
              <span className="dist" title={t("list.distanceTooltip")}>
                {candidate.distance === undefined ? "" : candidate.distance}
              </span>
            )}
            <span
              className={`nd import ${importTotal(candidate) ? "" : "zero"}`}
              title={t("list.importBreakdown", {
                anc: candidate.ancestorCount ?? 0,
                desc: candidate.descendantCount ?? 0,
              })}
            >
              {importTotal(candidate)}
            </span>
            <span
              className={`nd new ${candidate.newCount ? "" : "zero"}`}
              title={t("list.newTooltip")}
            >
              {candidate.newCount ?? 0}
            </span>
            <span
              className={`nd link ${candidate.linkCount ? "" : "zero"}`}
              title={t("list.linkTooltip")}
            >
              {candidate.linkCount ?? 0}
            </span>
            <span
              className={`nd diff ${candidate.diffCount ? "" : "zero"}`}
              title={t("list.diffTooltip")}
            >
              {candidate.diffCount ?? 0}
            </span>
          </span>
        </button>
      </div>
    </li>
  );
});

/** Score-category colour as a theme token, so the filter slider/value follow
 *  the Heritage Pine palette (and light mode) like the score badges do. */
const CATEGORY_COLOR: Record<MatchCategory, string> = {
  strong: "var(--state-match)",
  probable: "var(--state-minor)",
  weak: "var(--faint)",
};

function scoreColor(score: number): string {
  return CATEGORY_COLOR[categorize(score / 100, DEFAULT_CONFIG)];
}
