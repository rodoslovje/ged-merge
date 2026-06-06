import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  categorize,
  DEFAULT_CONFIG,
  type FamilyCandidate,
  type IndividualCandidate,
  type MatchCategory,
  type MatchResult,
  type ScoreComponent,
} from "../match/types";
import {
  decisionKey,
  type CandidateDecision,
  type MatchDecisionStatus,
  type MatchKind,
} from "../review/types";
import { formatScore, type Candidate, type Filters, type SortKey, type SortState } from "./matchView";

interface Props {
  result: MatchResult;
  tab: MatchKind;
  onTab: (tab: MatchKind) => void;
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
  onTab,
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
  const total = tab === "individual" ? result.individuals.length : result.families.length;

  // Rank 0 = primary (▲/▼), rank 1 = secondary (▲/▼ with a small "2").
  const rankOf = (key: SortKey) => sort.findIndex((s) => s.key === key);
  const arrow = (key: SortKey) => {
    const r = rankOf(key);
    if (r < 0) return "";
    const dir = sort[r].dir === "asc" ? "▲" : "▼";
    return r === 0 ? ` ${dir}` : ` ${dir}₂`;
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
      <div className="matches-head">
        <div className="tabs">
          <button
            className={tab === "individual" ? "tab active" : "tab"}
            onClick={() => onTab("individual")}
          >
            Individuals ({result.individuals.length})
          </button>
          <button
            className={tab === "family" ? "tab active" : "tab"}
            onClick={() => onTab("family")}
          >
            Families ({result.families.length})
          </button>
        </div>
        {homeControl}
      </div>

      <div className="filters">
        <label className="filter-check">
          <input
            type="checkbox"
            checked={filters.onlyNew}
            onChange={(e) => onFilters({ ...filters, onlyNew: e.target.checked })}
          />
          New data
        </label>
        <label className="filter-check">
          <input
            type="checkbox"
            checked={filters.onlyDiff}
            onChange={(e) => onFilters({ ...filters, onlyDiff: e.target.checked })}
          />
          Differences
        </label>
        <label className="filter-score">
          Min score{" "}
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
            ? "No candidate matches above threshold."
            : "No matches pass the current filters."}
        </p>
      ) : (
        <ul className="candidate-list" ref={listRef}>
          <li className="candidate-list-head">
            <button className={cls("score", "badge-h")} onClick={() => onToggleSort("score")}>
              Score{arrow("score")}
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
            <button className={cls("label", "labels")} onClick={() => onToggleSort("label")}>
              Compare ↔ Master{arrow("label")}
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
  const [open, setOpen] = useState(false);
  return (
    <li className={`candidate ${candidate.category}${selected ? " selected" : ""}`}>
      <div className="candidate-head">
        <button className="candidate-main" onClick={onSelect}>
          <span className={`badge ${candidate.category}`}>{formatScore(candidate.score)}</span>
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
          <span className="labels">
            <strong>{candidate.compareLabel}</strong>
            <span className="muted"> ↔ </span>
            <strong>{candidate.masterLabel}</strong>
          </span>
        </button>
        {status && status !== "undecided" && (
          <span className={`status-chip ${status}`}>{status}</span>
        )}
        <button
          className="chev-btn"
          title="Score breakdown"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? "▾" : "▸"}
        </button>
      </div>
      {open && (
        <table className="breakdown">
          <tbody>
            {candidate.components.map((comp) => (
              <ComponentRow key={comp.key} comp={comp} />
            ))}
          </tbody>
        </table>
      )}
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

function ComponentRow({ comp }: { comp: ScoreComponent }) {
  return (
    <tr>
      <td className="comp-key">{comp.key}</td>
      <td className="comp-bar">
        <span className="bar" style={{ width: `${Math.round(comp.score * 100)}%` }} />
      </td>
      <td className="comp-score">{Math.round(comp.score * 100)}%</td>
      <td className="comp-detail muted">{comp.detail ?? ""}</td>
    </tr>
  );
}
