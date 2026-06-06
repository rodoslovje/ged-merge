import { useMemo } from "react";
import type { Dataset } from "../gedcom/types";
import type { FamilyCandidate, IndividualCandidate } from "../match/types";
import { familyFieldRows, individualFieldRows } from "../review/fields";
import {
  defaultChoice,
  type CandidateDecision,
  type FieldChoice,
  type FieldRow,
  type MatchDecisionStatus,
  type MatchKind,
} from "../review/types";
import { formatScore } from "./matchView";

interface Props {
  kind: MatchKind;
  candidate: IndividualCandidate | FamilyCandidate;
  masterDs: Dataset;
  compareDs: Dataset;
  decision: CandidateDecision | undefined;
  onChange: (next: CandidateDecision) => void;
  /** 0-based position of this candidate within the filtered list. */
  index: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}

const STATUSES: MatchDecisionStatus[] = ["confirmed", "rejected", "deferred"];
const CHOICES: FieldChoice[] = ["master", "incoming", "both"];

export function ComparePanel({
  kind,
  candidate,
  masterDs,
  compareDs,
  decision,
  onChange,
  index,
  total,
  onPrev,
  onNext,
}: Props) {
  const rows = useMemo<FieldRow[]>(() => {
    if (kind === "individual") {
      return individualFieldRows(
        masterDs.individuals.get(candidate.masterId),
        compareDs.individuals.get(candidate.compareId),
        masterDs,
        compareDs,
      );
    }
    return familyFieldRows(
      masterDs.families.get(candidate.masterId),
      compareDs.families.get(candidate.compareId),
      masterDs,
      compareDs,
    );
  }, [kind, candidate, masterDs, compareDs]);

  const status = decision?.status ?? "undecided";
  const fields = decision?.fields ?? {};

  function setStatus(next: MatchDecisionStatus) {
    onChange({ status: next, fields });
  }
  function setField(key: string, choice: FieldChoice) {
    onChange({ status, fields: { ...fields, [key]: choice } });
  }

  const conflicts = rows.filter((r) => r.state === "conflict").length;

  return (
    <div className="compare-panel">
      <div className="compare-nav">
        <button
          className="nav-btn"
          onClick={onPrev}
          disabled={index <= 0}
          title="Previous match (←)"
        >
          ‹ Prev
        </button>
        <span className="nav-pos">
          {index + 1} of {total}
        </span>
        <button
          className="nav-btn"
          onClick={onNext}
          disabled={index >= total - 1}
          title="Next match (→)"
        >
          Next ›
        </button>
        <div className="compare-meta muted">
          Score {formatScore(candidate.score)}
          {candidate.distance !== undefined && ` · distance ${candidate.distance}`}
          {conflicts > 0 && ` · ${conflicts} conflict${conflicts === 1 ? "" : "s"}`}
          {status !== "undecided" && (
            <span className={`status-chip ${status}`}>{status}</span>
          )}
        </div>
      </div>

      <div className="decision-bar">
        {STATUSES.map((s) => (
          <button
            key={s}
            className={status === s ? `decision ${s} active` : "decision"}
            onClick={() => setStatus(s)}
          >
            {s}
          </button>
        ))}
      </div>

      <table className="compare">
        <thead>
          <tr>
            <th>Field</th>
            <th>Master · {candidate.masterLabel}</th>
            <th>Incoming · {candidate.compareLabel}</th>
            <th>Use</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const choice = fields[row.key] ?? defaultChoice(row);
            return (
              <tr key={row.key} className={`field ${row.state}`}>
                <td className="f-label">{row.label}</td>
                <td className={choice !== "incoming" ? "f-val chosen" : "f-val"}>
                  {row.master}
                </td>
                <td className={choice !== "master" ? "f-val chosen" : "f-val"}>
                  {row.incoming}
                </td>
                <td className="f-choice">
                  {row.state === "conflict" || row.state === "incoming-only" ? (
                    CHOICES.map((c) => (
                      <button
                        key={c}
                        className={choice === c ? "choice active" : "choice"}
                        title={choiceTitle(c)}
                        onClick={() => setField(row.key, c)}
                      >
                        {choiceLabel(c)}
                      </button>
                    ))
                  ) : (
                    <span className="muted">{row.state === "agree" ? "=" : "master"}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function choiceLabel(c: FieldChoice): string {
  return c === "master" ? "M" : c === "incoming" ? "I" : "B";
}
function choiceTitle(c: FieldChoice): string {
  return c === "master" ? "Keep master" : c === "incoming" ? "Take incoming" : "Keep both";
}
