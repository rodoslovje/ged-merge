import { useState } from "react";
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

export function MatchResults({ result, decisions, onReview }: Props) {
  const [tab, setTab] = useState<MatchKind>("individual");
  const list = tab === "individual" ? result.individuals : result.families;

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
          {list.map((c, i) => (
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
            {candidate.distance === undefined ? "—" : `↺${candidate.distance}`}
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
