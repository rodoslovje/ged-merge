import { useMemo, useState } from "react";
import type {
  FamilyCandidate,
  IndividualCandidate,
  MatchResult,
  ScoreComponent,
} from "../match/types";
import {
  decisionKey,
  type CandidateDecision,
  type MatchDecisionStatus,
  type MatchKind,
} from "../review/types";

interface Props {
  result: MatchResult;
  decisions: Map<string, CandidateDecision>;
  onReview: (kind: MatchKind, candidate: IndividualCandidate | FamilyCandidate) => void;
}

type Candidate = IndividualCandidate | FamilyCandidate;
type SortKey = "score" | "distance" | "newCount" | "diffCount" | "label";
interface SortState {
  key: SortKey;
  dir: "asc" | "desc";
}

const DEFAULT_DIR: Record<SortKey, "asc" | "desc"> = {
  score: "desc",
  distance: "asc",
  newCount: "desc",
  diffCount: "desc",
  label: "asc",
};

export function MatchResults({ result, decisions, onReview }: Props) {
  const [tab, setTab] = useState<MatchKind>("individual");
  const [sort, setSort] = useState<SortState | null>(null);
  const list = tab === "individual" ? result.individuals : result.families;

  // When unsorted, keep the worker's order (distance asc, then score desc).
  const sorted = useMemo(() => {
    if (!sort) return list;
    const mul = sort.dir === "asc" ? 1 : -1;
    return [...list].sort((a, b) => mul * compare(a, b, sort.key));
  }, [list, sort]);

  function toggleSort(key: SortKey) {
    setSort((prev) =>
      prev?.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: DEFAULT_DIR[key] },
    );
  }

  const arrow = (key: SortKey) =>
    sort?.key === key ? (sort.dir === "asc" ? " ▲" : " ▼") : "";
  const cls = (key: SortKey, extra: string) =>
    `sortbtn ${extra}${sort?.key === key ? " active" : ""}`;

  return (
    <section className="results">
      <div className="tabs">
        <button
          className={tab === "individual" ? "tab active" : "tab"}
          onClick={() => setTab("individual")}
        >
          Individuals ({result.individuals.length})
        </button>
        <button
          className={tab === "family" ? "tab active" : "tab"}
          onClick={() => setTab("family")}
        >
          Families ({result.families.length})
        </button>
      </div>

      {list.length === 0 ? (
        <p className="muted">No candidate matches above threshold.</p>
      ) : (
        <ul className="candidate-list">
          <li className="candidate-list-head">
            <button className={cls("score", "badge-h")} onClick={() => toggleSort("score")}>
              Score{arrow("score")}
            </button>
            <button
              className={cls("distance", "dist")}
              title="Distance from home person"
              onClick={() => toggleSort("distance")}
            >
              ↺{arrow("distance")}
            </button>
            <button
              className={cls("newCount", "nd")}
              title="New fields the compare file adds"
              onClick={() => toggleSort("newCount")}
            >
              N{arrow("newCount")}
            </button>
            <button
              className={cls("diffCount", "nd")}
              title="Fields present in both but differing"
              onClick={() => toggleSort("diffCount")}
            >
              D{arrow("diffCount")}
            </button>
            <button className={cls("label", "labels")} onClick={() => toggleSort("label")}>
              Compare ↔ Master{arrow("label")}
            </button>
          </li>
          {sorted.map((c, i) => (
            <CandidateRow
              key={`${c.masterId}-${c.compareId}-${i}`}
              kind={tab}
              candidate={c}
              status={decisions.get(decisionKey(tab, c.masterId, c.compareId))?.status}
              onReview={onReview}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function compare(a: Candidate, b: Candidate, key: SortKey): number {
  switch (key) {
    case "score":
      return a.score - b.score;
    case "distance":
      return (a.distance ?? Infinity) - (b.distance ?? Infinity);
    case "newCount":
      return (a.newCount ?? 0) - (b.newCount ?? 0);
    case "diffCount":
      return (a.diffCount ?? 0) - (b.diffCount ?? 0);
    case "label":
      return a.compareLabel.localeCompare(b.compareLabel);
  }
}

function CandidateRow({
  kind,
  candidate,
  status,
  onReview,
}: {
  kind: MatchKind;
  candidate: IndividualCandidate | FamilyCandidate;
  status: MatchDecisionStatus | undefined;
  onReview: (kind: MatchKind, candidate: IndividualCandidate | FamilyCandidate) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className={`candidate ${candidate.category}`}>
      <div className="candidate-head">
        <button className="candidate-main" onClick={() => setOpen((o) => !o)}>
          <span className={`badge ${candidate.category}`}>{candidate.score.toFixed(1)}</span>
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
          <span className="chev">{open ? "▾" : "▸"}</span>
        </button>
        {status && status !== "undecided" && (
          <span className={`status-chip ${status}`}>{status}</span>
        )}
        <button className="review-btn" onClick={() => onReview(kind, candidate)}>
          Review
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
