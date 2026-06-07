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
        t,
        masterDs.individuals.get(candidate.masterId),
        compareDs.individuals.get(candidate.compareId),
        masterDs,
        compareDs,
      );
    }
    return familyFieldRows(
      t,
      masterDs.families.get(candidate.masterId),
      compareDs.families.get(candidate.compareId),
      masterDs,
      compareDs,
    );
  }, [kind, candidate, masterDs, compareDs, t]);

  const status = decision?.status ?? "undecided";
  const fields = decision?.fields ?? {};

  function toggleStatus(next: MatchDecisionStatus) {
    onChange({ status: status === next ? "undecided" as MatchDecisionStatus : next, fields });
  }
  function setField(key: string, choice: FieldChoice) {
    onChange({ status, fields: { ...fields, [key]: choice } });
  }

  // Each status' shortcut is the first letter of its *localized* label, so the
  // keys follow the UI language (Confirmed→C / Potrjeno→P, Rejected→R / Zavrnjeno→Z…).
  const shortcutOf = (s: MatchDecisionStatus) => t(`status.${s}`).charAt(0).toLowerCase();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const key = e.key.toLowerCase();
      const hit = STATUSES.find((s) => shortcutOf(s) === key);
      if (hit) toggleStatus(hit);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onChange, status, fields, t]);

  const conflicts = rows.filter((r) => r.state === "conflict").length;

  return (
    <div className="compare-panel">
      <div className="compare-nav">
        <div className="decision-bar">
          {STATUSES.map((s) => (
            <button
              key={s}
              className={status === s ? `decision ${s} active` : "decision"}
              title={t("compare.shortcut", { key: shortcutOf(s).toUpperCase() })}
              onClick={() => toggleStatus(s)}
            >
              {t(`status.${s}`)}
            </button>
          ))}
        </div>

        <div className="compare-meta muted">
          {t("compare.score")} {formatScore(candidate.score)}
          {candidate.distance !== undefined && ` · ${t("compare.distance")} ${candidate.distance}`}
          {conflicts > 0 && ` · ${conflicts} ${conflicts === 1 ? t("compare.conflict") : t("compare.conflicts")}`}
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
                        title={choiceTitle(t, c)}
                        onClick={() => setField(row.key, c)}
                      >
                        {choiceLabel(t, c)}
                      </button>
                    ))
                  ) : (
                    <span className="muted">{row.state === "agree" ? "=" : t("compare.keepMaster")}</span>
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
  if (!links) return renderLines(text);
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

/**
 * Render a possibly multi-line value (e.g. children/partners) one item per line.
 * Blank lines are kept at full height (a non-breaking space) so a relative and
 * its aligned counterpart in the other column stay on the same row.
 */
function renderLines(text: string) {
  if (!text.includes("\n")) return text;
  return text.split("\n").map((line, i) => (
    <div key={i} className="val-line">
      {line || " "}
    </div>
  ));
}

/** Ensure scheme-less links (e.g. "www.example.com") get an absolute href. */
function linkHref(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

function choiceLabel(t: any, c: FieldChoice): string {
  return t(`choice.${c}.label`);
}
function choiceTitle(t: any, c: FieldChoice): string {
  return t(`choice.${c}.title`);
}
