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
  type RelativePair,
} from "../review/types";
import { PersonPhotos } from "./PersonPhotos";

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
  const takenChildren = useMemo(() => new Set(decision?.takenChildren ?? []), [decision]);
  // A rejected/deferred match never applies any incoming data on save (see
  // `mergeDecisions`, which skips non-"confirmed" decisions outright) — so the
  // preview shows every field as kept from master, regardless of any per-field
  // choice recorded earlier while the match was still confirmed.
  const forceMaster = status === "rejected" || status === "deferred";

  // Emit a full decision, carrying over the parts of it this panel doesn't touch
  // (event rejections, per-child picks) so a field edit never wipes them.
  function emit(patch: Partial<CandidateDecision>) {
    onChange({
      status,
      fields,
      ...(decision?.rejectedEvents?.length ? { rejectedEvents: decision.rejectedEvents } : {}),
      ...(takenChildren.size ? { takenChildren: [...takenChildren] } : {}),
      ...patch,
    });
  }

  function setField(key: string, choice: FieldChoice) {
    emit({ fields: { ...fields, [key]: choice } });
  }

  function setTakenChild(childId: string, taken: boolean) {
    const next = new Set(takenChildren);
    if (taken) next.add(childId);
    else next.delete(childId);
    emit({ takenChildren: next.size ? [...next] : undefined });
  }

  /**
   * Per-pair emphasis and control for the children row. A child the master
   * family already lists agrees (kept, "="); a master-only child is kept; an
   * incoming-only child is opt-in — its own take/skip toggle drives whether it's
   * stitched in (recorded in `decision.takenChildren`).
   */
  function renderChildPair(pair: RelativePair) {
    const hasMaster = !!pair.master?.text;
    const hasIncoming = !!pair.incoming?.text;
    const incId = pair.incoming?.id;
    if (hasMaster) {
      const choiceNode = hasIncoming
        ? <span className="muted">=</span>
        : <span className="gm-master-tag">{t("compare.keepMaster")}</span>;
      return { masterChosen: true, incomingChosen: false, choice: choiceNode };
    }
    // Incoming-only child.
    const taken = !forceMaster && !!incId && takenChildren.has(incId);
    if (forceMaster || !incId) {
      return { masterChosen: false, incomingChosen: false, choice: <span className="gm-master-tag">{t("compare.keepMaster")}</span> };
    }
    return {
      masterChosen: false,
      incomingChosen: taken,
      choice: (
        <button
          className={`choice take${taken ? " active" : ""}`}
          title={taken ? t("compare.childTaken.title") : t("compare.takeChild.title")}
          onClick={() => setTakenChild(incId, !taken)}
        >
          {taken ? t("compare.childTaken.label") : t("compare.takeChild.label")}
        </button>
      ),
    };
  }

  function renderChoiceCell(row: FieldRow, choice: FieldChoice) {
    if (forceMaster) return <span className="gm-master-tag">{t("compare.keepMaster")}</span>;
    if (row.state === "conflict" || row.state === "incoming-only") {
      return CHOICES.map((c) => (
        <button
          key={c}
          className={`choice ${c}${choice === c ? " active" : ""}`}
          title={choiceTitle(t, c)}
          onClick={() => setField(row.key, c)}
        >
          {choiceLabel(t, c)}
        </button>
      ));
    }
    if (row.state === "agree") return <span className="muted">=</span>;
    return <span className="gm-master-tag">{t("compare.keepMaster")}</span>;
  }

  return (
    <div className="compare-panel">
      {(masterIndi || compareIndi) && (
        <div className="compare-photos">
          <div className="compare-photos-col">
            {masterIndi && (
              <PersonPhotos
                raw={masterIndi.raw}
                records={masterDs.records}
                refCtx={{ dataset: masterDs, onNavigate: masterPerson.onNavigate }}
              />
            )}
          </div>
          <div className="compare-photos-col">
            {compareIndi && (
              <PersonPhotos
                raw={compareIndi.raw}
                records={compareDs.records}
                refCtx={{ dataset: compareDs, onNavigate: incomingPerson.onNavigate }}
              />
            )}
          </div>
        </div>
      )}
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
            // A sources row can be link-icons-only (no actual SOUR citation on
            // either side yet) — still route it through the icon rendering below
            // rather than the plain-text branch, which would print the bare URL.
            const hasSources = !!(row.masterSources || row.incomingSources || row.masterLinkIcons || row.incomingLinkIcons);
            // Partners share one choice for the whole list, repeated on every
            // line inside the grid so a name beneath the first reads as covered.
            // Children instead get a per-child take/skip toggle (`renderPair`).
            return (
              <tr key={row.key} className={`field ${row.state}`}>
                <td className="f-label">{row.displayLabel ?? row.label}</td>
                {row.relatives ? (
                  <td className="f-rel" colSpan={3}>
                    <RelativeGrid
                      pairs={row.relatives}
                      masterChosen={choice !== "incoming"}
                      incomingChosen={choice !== "master"}
                      masterPerson={masterPerson}
                      incomingPerson={incomingPerson}
                      {...(row.perChildChoice
                        ? { renderPair: renderChildPair }
                        : { renderChoice: () => renderChoiceCell(row, choice) })}
                    />
                  </td>
                ) : hasSources ? (
                  <>
                    <td className={choice !== "incoming" ? "f-val gm-data chosen" : "f-val gm-data"}>
                      <SourceRefs t={t} masterSources={row.masterSources} />
                      {row.masterLinkIcons?.length ? <LinkIcons urls={row.masterLinkIcons} otherUrls={row.incomingLinkIcons} /> : null}
                    </td>
                    <td className={choice !== "master" ? "f-val gm-data chosen" : "f-val gm-data"}>
                      <SourceRefs t={t} masterSources={row.incomingSources} compareAgainst={row.masterSources} />
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
                {row.relatives ? null : <td className="f-choice">{renderChoiceCell(row, choice)}</td>}
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
