import { useEffect, useRef, type ReactNode } from "react";
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
import { formatScore, type Candidate, type Filters, type SortKey, type SortState } from "./matchView";
import { sexClass } from "./sex";
import { SexBadge } from "./SexBadge";

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
  /** Home-person picker, rendered to the right of the tabs. */
  homeControl?: ReactNode;
  showFilters: boolean;
}

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
  homeControl,
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
      const el = listRef.current?.querySelector<HTMLElement>(".candidate.selected");
      el?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex, list]);

  return (
    <div className="results">
      {showFilters && (
        <div className="filters">
          <div className="filter-row">
            {homeControl}
            <label className="filter-score" title={t("filter.scoreTooltip")}>
              <span className="filter-score-val" style={{ color: scoreColor(filters.minScore) }}>
                {filters.minScore}
              </span>
              <input
                type="range"
                min={50}
                max={100}
                step={5}
                value={filters.minScore}
                style={{ accentColor: scoreColor(filters.minScore) }}
                onChange={(e) => onFilters({ ...filters, minScore: Number(e.target.value) })}
              />
            </label>
          </div>
          <div className="filter-row">
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
            <button className={cls("score", "badge-h")} onClick={() => onToggleSort("score")}>
              {t("list.score")}{arrow("score")}
            </button>
            <button
              className={cls("distance", "dist")}
              title={t("list.distanceTooltip")}
              onClick={() => onToggleSort("distance")}
            >
              ↺{arrow("distance")}
            </button>
            <button
              className={cls("newCount", "nd")}
              title={t("list.newTooltip")}
              onClick={() => onToggleSort("newCount")}
            >
              N{arrow("newCount")}
            </button>
            <button
              className={cls("diffCount", "nd")}
              title={t("list.diffTooltip")}
              onClick={() => onToggleSort("diffCount")}
            >
              D{arrow("diffCount")}
            </button>
            <button
              className={cls("linkCount", "nd")}
              title={t("list.linkTooltip")}
              onClick={() => onToggleSort("linkCount")}
            >
              🔗{arrow("linkCount")}
            </button>
            <button className={cls("label", "labels")} onClick={() => onToggleSort("label")}>
              {t("list.masterCompare")}{arrow("label")}
            </button>
          </li>
          {list.map((c, i) => (
            <CandidateRow
              key={`${c.masterId}-${c.compareId}-${i}`}
              candidate={c}
              selected={i === selectedIndex}
              status={decisions.get(decisionKey("individual", c.masterId, c.compareId))?.status}
              onSelect={() => onSelect(i)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function CandidateRow({
  candidate,
  selected,
  status,
  onSelect,
}: {
  candidate: IndividualCandidate;
  selected: boolean;
  status: MatchDecisionStatus | undefined;
  onSelect: () => void;
}) {
  const { t } = useTranslation();

  const scoreTooltip =
    candidate.score === 1
      ? undefined
      : candidate.components
          .map((c) => {
            const label = formatFieldLabel(t, c.key);
            const detail = c.score === 1 ? "" : c.detail ? ` (${c.detail})` : "";
            const missing = c.missing ? " missing" : "";
            return `${label}: ${Math.round(c.score * 100)}%${missing}${detail}`;
          })
          .join("\n");

  return (
    <li className={`candidate ${candidate.category}${selected ? " selected" : ""}`}>
      <div className="candidate-head">
        <button className="candidate-main" onClick={onSelect}>
          <span className={`badge ${candidate.category}`} title={scoreTooltip}>
            {formatScore(candidate.score)}
          </span>
          <span className="dist" title={t("list.distanceTooltip")}>
            {candidate.distance === undefined ? "" : candidate.distance}
          </span>
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
          <span className={`labels ${sexClass(candidate.sex)}`}>
            <SexBadge sex={candidate.sex} />
            <span className="candidate-name">{candidate.name}</span>
            {candidate.birthYear != null && (
              <span className="candidate-year gm-data">{candidate.birthYear}</span>
            )}
          </span>
        </button>
        {status && status !== "undecided" && (
          <span className={`status-chip ${status}`} title={t(`status.${status}`)}>
            {t(`status.${status}`).charAt(0)}
          </span>
        )}
      </div>
    </li>
  );
}

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
