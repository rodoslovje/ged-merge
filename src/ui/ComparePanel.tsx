import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
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
  /** When set, shows a "Compare tree" button that opens the full-page tree. */
  onOpenTree?: () => void;
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
  onOpenTree,
}: Props) {
  const { t } = useTranslation();
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

  function toggleStatus(next: MatchDecisionStatus) {
    onChange({ status: status === next ? "undecided" as MatchDecisionStatus : next, fields });
  }
  function setField(key: string, choice: FieldChoice) {
    onChange({ status, fields: { ...fields, [key]: choice } });
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const key = e.key.toLowerCase();
      if (key === "c") toggleStatus("confirmed");
      else if (key === "r") toggleStatus("rejected");
      else if (key === "d") toggleStatus("deferred");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onChange, status, fields]);

  const conflicts = rows.filter((r) => r.state === "conflict").length;

  return (
    <div className="compare-panel">
      <div className="compare-nav">
        <div className="decision-bar">
          {STATUSES.map((s) => (
            <button
              key={s}
              className={status === s ? `decision ${s} active` : "decision"}
              title={`Keyboard shortcut: ${s.charAt(0).toUpperCase()}`}
              onClick={() => toggleStatus(s)}
            >
              {t(`status.${s}`)}
            </button>
          ))}
        </div>

        <div className="compare-meta muted">
          Score {formatScore(candidate.score)}
          {candidate.distance !== undefined && ` · distance ${candidate.distance}`}
          {conflicts > 0 && ` · ${conflicts} conflict${conflicts === 1 ? "" : "s"}`}
        </div>

        {onOpenTree && (
          <button className="tree-open-btn" onClick={onOpenTree}>
            {t("tree.button")}
          </button>
        )}
      </div>

      <table className="compare">
        <tbody>
          {rows.map((row) => {
            const choice = fields[row.key] ?? defaultChoice(row);
            return (
              <tr key={row.key} className={`field ${row.state}`}>
                <td className="f-label">{row.label}</td>
                <td className={choice !== "incoming" ? "f-val chosen" : "f-val"}>
                  {renderValue(row.master, row.masterLinks)}
                </td>
                <td className={choice !== "master" ? "f-val chosen" : "f-val"}>
                  {renderValue(row.incoming, row.incomingLinks)}
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

/** Render a cell as link icons when the row carries attached links, else text. */
function renderValue(text: string, links: string[] | undefined) {
  if (!links) return text;
  return (
    <span className="links">
      {links.map((url, i) => (
        <a
          key={i}
          href={linkHref(url)}
          target="_blank"
          rel="noopener noreferrer"
          className="link-icon"
          title={url}
        >
          🔗
        </a>
      ))}
    </span>
  );
}

/** Ensure scheme-less links (e.g. "www.example.com") get an absolute href. */
function linkHref(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

function choiceLabel(c: FieldChoice): string {
  return c === "master" ? "M" : c === "incoming" ? "I" : "B";
}
function choiceTitle(c: FieldChoice): string {
  return c === "master" ? "Keep master" : c === "incoming" ? "Take incoming" : "Keep both";
}
