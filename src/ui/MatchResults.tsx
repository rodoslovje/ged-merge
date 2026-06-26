import { memo, useEffect, useMemo, useRef } from "react";
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
import { datesTooltip, formatLifespan } from "../gedcom/lifespan";
import { formatScore, type Candidate, type Filters, type SortKey, type SortState } from "./matchView";
import { sexClass } from "./sex";

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
  /** Show the relationship-distance column (only meaningful with a home person). */
  showRelation: boolean;
  showFilters: boolean;
}

/** Shared attributes for the small, language-neutral column-header icons. */
const ICON_PROPS = {
  className: "col-ico",
  width: 13,
  height: 13,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
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
}: Props) {
  const { t } = useTranslation();
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

  // Keep the selected row visible as the user pages with Prev/Next or arrows.
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (window.innerWidth > 880) {
      // children[0] is the header row; candidate rows start at children[1]
      const el = listRef.current?.children[selectedIndex + 1] as HTMLElement | undefined;
      el?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex, list]);

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
            <label className="filter-check" title={t("filter.newDataTooltip")}>
              <input
                type="checkbox"
                checked={filters.onlyNew}
                onChange={(e) => onFilters({ ...filters, onlyNew: e.target.checked })}
              />
              {t("filter.newData")}
            </label>
            <label className="filter-check" title={t("filter.differencesTooltip")}>
              <input
                type="checkbox"
                checked={filters.onlyDiff}
                onChange={(e) => onFilters({ ...filters, onlyDiff: e.target.checked })}
              />
              {t("filter.differences")}
            </label>
            <label className="filter-check" title={t("filter.linksTooltip")}>
              <input
                type="checkbox"
                checked={filters.onlyLinks}
                onChange={(e) => onFilters({ ...filters, onlyLinks: e.target.checked })}
              />
              {t("filter.links")}
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
        <ul className="candidate-list" ref={listRef}>
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
                className={cls("newCount", "nd")}
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
                className={cls("diffCount", "nd")}
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
              <button
                className={cls("linkCount", "nd")}
                title={t("list.linkTooltip")}
                onClick={() => onToggleSort("linkCount")}
              >
                🔗{arrow("linkCount")}
              </button>
            </span>
          </li>
          {list.map((c, i) => (
            <CandidateRow
              // Stable per candidate pair (no index): lets React reuse rows
              // across filter/sort changes instead of remounting the whole list.
              key={`${c.masterId}-${c.compareId}`}
              candidate={c}
              index={i}
              selected={i === selectedIndex}
              status={decisions.get(decisionKey("individual", c.masterId, c.compareId))?.status}
              showRelation={showRelation}
              onSelect={onSelect}
            />
          ))}
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
  onSelect,
}: {
  candidate: IndividualCandidate;
  index: number;
  selected: boolean;
  status: MatchDecisionStatus | undefined;
  showRelation: boolean;
  onSelect: (index: number) => void;
}) {
  const { t } = useTranslation();

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
    <li className={`candidate ${candidate.category}${selected ? " selected" : ""}${candidate.linkCount ? " has-links" : ""}`}>
      <div className="candidate-head">
        <button className="candidate-main" onClick={() => onSelect(index)}>
          <span className={`person-label ${sexClass(candidate.sex)}`}>
            <span className="person-name">{candidate.name}</span>
            {formatLifespan(candidate.birthYear, candidate.deathYear, candidate.deceased) && (
              <span
                className="person-years gm-data"
                title={datesTooltip(candidate.birthDate, candidate.deathDate, candidate.deceased)}
              >
                {formatLifespan(candidate.birthYear, candidate.deathYear, candidate.deceased)}
              </span>
            )}
            {candidate.relationshipLinked && (
              <span className="rel-tree-badge" title={t("list.relationshipLinked")}>🌳</span>
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
              className={`nd new ${candidate.newCount ? "" : "zero"}`}
              title={t("list.newTooltip")}
            >
              {candidate.newCount ?? 0}
            </span>
            <span
              className={`nd diff ${candidate.diffCount ? "" : "zero"}`}
              title={t("list.diffTooltip")}
            >
              {candidate.diffCount ?? 0}
            </span>
            <span
              className={`nd link ${candidate.linkCount ? "" : "zero"}`}
              title={t("list.linkTooltip")}
            >
              {candidate.linkCount ?? 0}
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
