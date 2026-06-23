import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { Translate } from "../locales/i18n";
import type { Dataset } from "../gedcom/types";
import type { IndividualCandidate } from "../match/types";
import { individualFieldRows } from "../review/fields";
import { FieldValue, LinkIcons, RelativeGrid } from "./FieldValue";
import { SourceRefs } from "./SourceRef";
import {
  defaultChoice,
  type CandidateDecision,
  type FieldChoice,
  type FieldRow,
} from "../review/types";

/** Which dataset a relative id belongs to. */
export type RelativeSide = "master" | "incoming";

interface Props {
  candidate: IndividualCandidate;
  masterDs: Dataset;
  compareDs: Dataset;
  decision: CandidateDecision | undefined;
  onChange: (next: CandidateDecision) => void;
  /** True when the person on `side` with this id is reachable in the match list. */
  canNavigate: (side: RelativeSide, id: string) => boolean;
  /** Jump the compare view to the person on `side` with this id. */
  onNavigate: (side: RelativeSide, id: string) => void;
}

const CHOICES: FieldChoice[] = ["master", "incoming", "both"];

export function ComparePanel({
  candidate,
  masterDs,
  compareDs,
  decision,
  onChange,
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
  // Edits rebuild the master Individual in place (new object stored back into
  // `masterDs.individuals`) without changing `masterDs`'s own identity, so the
  // memo must key off the looked-up records themselves — keying off `masterDs`
  // would miss edits made while this panel stays mounted in the background.
  const masterIndi = masterDs.individuals.get(candidate.masterId);
  const compareIndi = compareDs.individuals.get(candidate.compareId);
  const rows = useMemo<FieldRow[]>(() => {
    const rejectedEvents = decision?.rejectedEvents?.length ? new Set(decision.rejectedEvents) : undefined;
    return individualFieldRows(t, masterIndi, compareIndi, masterDs, compareDs, undefined, rejectedEvents);
  }, [masterIndi, compareIndi, masterDs, compareDs, t, decision]);

  const status = decision?.status ?? "undecided";
  const fields = decision?.fields ?? {};
  // A rejected/deferred match never applies any incoming data on save (see
  // `mergeDecisions`, which skips non-"confirmed" decisions outright) — so the
  // preview shows every field as kept from master, regardless of any per-field
  // choice recorded earlier while the match was still confirmed.
  const forceMaster = status === "rejected" || status === "deferred";

  function setField(key: string, choice: FieldChoice) {
    onChange({ status, fields: { ...fields, [key]: choice } });
  }

  return (
    <div className="compare-panel">
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

            const choice = forceMaster ? "master" : fields[row.key] ?? defaultChoice(row);
            const hasSources = !!(row.masterSources || row.incomingSources);
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
                ) : hasSources ? (
                  <>
                    <td className={choice !== "incoming" ? "f-val gm-data chosen" : "f-val gm-data"}>
                      <SourceRefs t={t} masterSources={row.masterSources} />
                      {row.masterLinkIcons?.length ? <LinkIcons urls={row.masterLinkIcons} otherUrls={row.incomingLinkIcons} /> : null}
                    </td>
                    <td className={choice !== "master" ? "f-val gm-data chosen" : "f-val gm-data"}>
                      <SourceRefs t={t} masterSources={row.incomingSources} />
                      {row.incomingLinkIcons?.length ? <LinkIcons urls={row.incomingLinkIcons} otherUrls={row.masterLinkIcons} /> : null}
                    </td>
                  </>
                ) : (
                  <>
                    <td
                      className={choice !== "incoming" ? "f-val gm-data chosen" : "f-val gm-data"}
                      title={row.masterTitle}
                    >
                      <FieldValue
                        text={row.master}
                        links={row.masterLinks}
                        linkIcons={row.masterLinkIcons}
                        otherLinkIcons={row.incomingLinkIcons}
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
                        linkIcons={row.incomingLinkIcons}
                        otherLinkIcons={row.masterLinkIcons}
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
