import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { Translate } from "../locales/i18n";
import type { Dataset } from "../gedcom/types";
import type { IndividualCandidate } from "../match/types";
import { individualFieldRows } from "../review/fields";
import { FieldValue, RelativeGrid } from "./FieldValue";
import {
  defaultChoice,
  type CandidateDecision,
  type FieldChoice,
  type FieldRow,
  type MatchDecisionStatus,
} from "../review/types";

/** Which dataset a relative id belongs to. */
export type RelativeSide = "master" | "incoming";

interface Props {
  candidate: IndividualCandidate;
  masterDs: Dataset;
  compareDs: Dataset;
  decision: CandidateDecision | undefined;
  onChange: (next: CandidateDecision) => void;
  /** When set, shows a "Compare tree" button that opens the full-page tree. */
  onOpenTree?: () => void;
  /** True when the person on `side` with this id is reachable in the match list. */
  canNavigate: (side: RelativeSide, id: string) => boolean;
  /** Jump the compare view to the person on `side` with this id. */
  onNavigate: (side: RelativeSide, id: string) => void;
}

const STATUSES: MatchDecisionStatus[] = ["confirmed", "rejected", "deferred"];
const CHOICES: FieldChoice[] = ["master", "incoming", "both"];

export function ComparePanel({
  candidate,
  masterDs,
  compareDs,
  decision,
  onChange,
  onOpenTree,
  canNavigate,
  onNavigate,
}: Props) {
  const { t } = useTranslation();
  const masterPerson = {
    linkable: (id: string) => canNavigate("master", id),
    onNavigate: (id: string) => onNavigate("master", id),
  };
  const incomingPerson = {
    linkable: (id: string) => canNavigate("incoming", id),
    onNavigate: (id: string) => onNavigate("incoming", id),
  };
  const rows = useMemo<FieldRow[]>(
    () =>
      individualFieldRows(
        t,
        masterDs.individuals.get(candidate.masterId),
        compareDs.individuals.get(candidate.compareId),
        masterDs,
        compareDs,
      ),
    [candidate, masterDs, compareDs, t],
  );

  const status = decision?.status ?? "undecided";
  const fields = decision?.fields ?? {};

  function toggleStatus(next: MatchDecisionStatus) {
    onChange({ status: status === next ? "undecided" : next, fields });
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

        {onOpenTree && (
          <button className="tree-open-btn" onClick={onOpenTree}>
            {t("tree.button")}
          </button>
        )}
      </div>

      <table className="compare">
        <thead>
          <tr className="compare-head">
            <th />
            <th className="compare-col compare-col-master">{t("tree.master")}</th>
            <th className="compare-col compare-col-incoming">{t("tree.incoming")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            if (row.isGroupHeader) {
              const isEventHeader = !!row.isEventHeader;
              return (
                <tr key={row.key} className={isEventHeader ? "group-header-row event-header-row" : "group-header-row"}>
                  <td colSpan={4} className={isEventHeader ? "group-header-cell event-header-cell" : "group-header-cell"}>
                    {row.label}
                  </td>
                </tr>
              );
            }

            const choice = fields[row.key] ?? defaultChoice(row);
            return (
              <tr key={row.key} className={`field ${row.state}`}>
                <td className="f-label">{row.displayLabel ?? row.label}</td>
                {row.relatives ? (
                  <td className="f-rel" colSpan={2}>
                    <RelativeGrid
                      pairs={row.relatives}
                      masterChosen={choice !== "incoming"}
                      incomingChosen={choice !== "master"}
                      masterPerson={masterPerson}
                      incomingPerson={incomingPerson}
                    />
                  </td>
                ) : (
                  <>
                    <td
                      className={choice !== "incoming" ? "f-val gm-data chosen" : "f-val gm-data"}
                      title={row.masterTitle}
                    >
                      <FieldValue
                        text={row.master}
                        links={row.masterLinks}
                        person={row.masterRefs ? { refs: row.masterRefs, ...masterPerson } : undefined}
                      />
                    </td>
                    <td
                      className={choice !== "master" ? "f-val gm-data chosen" : "f-val gm-data"}
                      title={row.incomingTitle}
                    >
                      <FieldValue
                        text={row.incoming}
                        links={row.incomingLinks}
                        otherLinks={row.masterLinks}
                        person={row.incomingRefs ? { refs: row.incomingRefs, ...incomingPerson } : undefined}
                      />
                    </td>
                  </>
                )}
                <td className="f-choice">
                  {row.state === "conflict" || row.state === "incoming-only" ? (
                    CHOICES.map((c) => (
                      <button
                        key={c}
                        className={`choice ${c}${choice === c ? " active" : ""}`}
                        title={choiceTitle(t, c)}
                        onClick={() => setField(row.key, c)}
                      >
                        {choiceLabel(t, c)}
                      </button>
                    ))
                  ) : row.state === "agree" ? (
                    <span className="muted">=</span>
                  ) : (
                    <span className="gm-master-tag">{t("compare.keepMaster")}</span>
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

function choiceLabel(t: Translate, c: FieldChoice): string {
  return t(`choice.${c}.label`);
}
function choiceTitle(t: Translate, c: FieldChoice): string {
  return t(`choice.${c}.title`);
}
