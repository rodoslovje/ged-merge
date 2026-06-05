import { useState } from "react";
import type {
  FamilyCandidate,
  IndividualCandidate,
  MatchResult,
  ScoreComponent,
} from "../match/types";

interface Props {
  result: MatchResult;
}

export function MatchResults({ result }: Props) {
  const [tab, setTab] = useState<"individuals" | "families">("individuals");
  const list = tab === "individuals" ? result.individuals : result.families;

  return (
    <section className="results">
      <div className="tabs">
        <button
          className={tab === "individuals" ? "tab active" : "tab"}
          onClick={() => setTab("individuals")}
        >
          Individuals ({result.individuals.length})
        </button>
        <button
          className={tab === "families" ? "tab active" : "tab"}
          onClick={() => setTab("families")}
        >
          Families ({result.families.length})
        </button>
      </div>

      {list.length === 0 ? (
        <p className="muted">No candidate matches above threshold.</p>
      ) : (
        <ul className="candidate-list">
          {list.map((c, i) => (
            <CandidateRow key={`${c.masterId}-${c.compareId}-${i}`} candidate={c} />
          ))}
        </ul>
      )}
    </section>
  );
}

function CandidateRow({ candidate }: { candidate: IndividualCandidate | FamilyCandidate }) {
  const [open, setOpen] = useState(false);
  return (
    <li className={`candidate ${candidate.category}`}>
      <button className="candidate-head" onClick={() => setOpen((o) => !o)}>
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
