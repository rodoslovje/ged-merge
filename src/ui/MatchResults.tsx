import { useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  categorize,
  DEFAULT_CONFIG,
  type FamilyCandidate,
  type IndividualCandidate,
  type MatchCategory,
  type MatchResult,
} from "../match/types";
import {
  decisionKey,
  type CandidateDecision,
  type MatchDecisionStatus,
  type MatchKind,
} from "../review/types";
import { formatFieldLabel } from "../review/fields";
import { formatScore, sexClass, type Candidate, type Filters, type SortKey, type SortState } from "./matchView";

interface Props {
  result: MatchResult;
  tab: MatchKind;
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
}

export function MatchResults({
  result,
  tab,
  sort,
  onToggleSort,
  filters,
  onFilters,
  list,
  selectedIndex,
  onSelect,
  decisions,
  homeControl,
}: Props) {
  const { t } = useTranslation();
  const total = tab === "individual" ? result.individuals.length : result.families.length;

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
    const el = listRef.current?.querySelector<HTMLElement>(".candidate.selected");
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, list]);

  return (
    <div className="results">
      <div className="filters">
        {homeControl}
        <label className="filter-check">
          <input
            type="checkbox"
            checked={filters.onlyNew}
            onChange={(e) => onFilters({ ...filters, onlyNew: e.target.checked })}
          />
          {t("filter.newData")}
        </label>
        <label className="filter-check">
          <input
            type="checkbox"
            checked={filters.onlyDiff}
            onChange={(e) => onFilters({ ...filters, onlyDiff: e.target.checked })}
          />
          {t("filter.differences")}
        </label>
        <label className="filter-check">
          <input
            type="checkbox"
            checked={filters.onlyLinks}
            onChange={(e) => onFilters({ ...filters, onlyLinks: e.target.checked })}
          />
          {t("filter.links")}
        </label>
        <label className="filter-score">
          {t("filter.minScore")}{" "}
          <span className="filter-score-val" style={{ color: scoreColor(filters.minScore) }}>
            {filters.minScore}
          </span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={filters.minScore}
            style={{ accentColor: scoreColor(filters.minScore) }}
            onChange={(e) => onFilters({ ...filters, minScore: Number(e.target.value) })}
          />
        </label>
        <span className="filter-count muted">
          {list.length} of {total}
        </span>
      </div>

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
              title="Distance from home person"
              onClick={() => onToggleSort("distance")}
            >
              ↺{arrow("distance")}
            </button>
            <button
              className={cls("newCount", "nd")}
              title="New fields the compare file adds"
              onClick={() => onToggleSort("newCount")}
            >
              N{arrow("newCount")}
            </button>
            <button
              className={cls("diffCount", "nd")}
              title="Fields present in both but differing"
              onClick={() => onToggleSort("diffCount")}
            >
              D{arrow("diffCount")}
            </button>
            <button
              className={cls("linkCount", "nd")}
              title="Attached links the compare adds or that differ"
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
              status={decisions.get(decisionKey(tab, c.masterId, c.compareId))?.status}
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
  candidate: IndividualCandidate | FamilyCandidate;
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
            const label = formatFieldLabel(c.key);
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
          <span className="dist" title="Distance from home person">
            {candidate.distance === undefined ? "" : candidate.distance}
          </span>
          <span
            className={`nd new ${candidate.newCount ? "" : "zero"}`}
            title="New fields the compare file adds"
          >
            {candidate.newCount ?? 0}
          </span>
          <span
            className={`nd diff ${candidate.diffCount ? "" : "zero"}`}
            title="Fields present in both but differing"
          >
            {candidate.diffCount ?? 0}
          </span>
          <span
            className={`nd link ${candidate.linkCount ? "" : "zero"}`}
            title="Attached links the compare adds or that differ"
          >
            {candidate.linkCount ?? 0}
          </span>
          <span className={`labels ${sexClass(candidate)}`}>{candidate.title}</span>
        </button>
        {status && status !== "undecided" && (
          <span className={`status-chip ${status}`}>{t(`status.${status}`)}</span>
        )}
      </div>
    </li>
  );
}

/** Match the score badge / category color scheme used for candidate rows. */
const CATEGORY_COLOR: Record<MatchCategory, string> = {
  strong: "#3ecf8e",
  probable: "#e2b341",
  weak: "#6b7280",
};

function scoreColor(score: number): string {
  return CATEGORY_COLOR[categorize(score / 100, DEFAULT_CONFIG)];
}
