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
import { PersonMedia } from "./PersonMedia";
import { useMediaFolder } from "./MediaFolderContext";
import { useSettings } from "./SettingsContext";
import { collectMediaRefs } from "../gedcom/media";

/** Which dataset a relative id belongs to. */
export type RelativeSide = "main" | "incoming";

interface Props {
  candidate: IndividualCandidate;
  mainDs: Dataset;
  compareDs: Dataset;
  decision: CandidateDecision | undefined;
  onChange: (next: CandidateDecision) => void;
  /** True when the person on `side` with this id is reachable in the match list. */
  canNavigate: (side: RelativeSide, id: string) => boolean;
  /** Jump the compare view to the person on `side` with this id. */
  onNavigate: (side: RelativeSide, id: string) => void;
}

const CHOICES: FieldChoice[] = ["main", "incoming", "both"];

export function ComparePanel({
  candidate,
  mainDs,
  compareDs,
  decision,
  onChange,
  canNavigate,
  onNavigate,
}: Props) {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const mainPerson = {
    linkable: (id: string) => canNavigate("main", id),
    onNavigate: (id: string) => onNavigate("main", id),
  };
  const incomingPerson = {
    linkable: (id: string) => canNavigate("incoming", id),
    onNavigate: (id: string) => onNavigate("incoming", id),
  };
  // Edits rebuild the main Individual in place (new object stored back into
  // `mainDs.individuals`) without changing `mainDs`'s own identity, so the
  // memo must key off the looked-up records themselves — keying off `mainDs`
  // would miss edits made while this panel stays mounted in the background.
  const mainIndi = mainDs.individuals.get(candidate.mainId);
  const compareIndi = compareDs.individuals.get(candidate.compareId);
  // Only show the photos tray (and its divider line) when a media folder is
  // loaded and at least one side actually references a photo — otherwise the
  // empty tray leaves a stray separator under the header.
  const { folderName } = useMediaFolder();
  const hasMedia = useMemo(() => {
    if (!folderName) return false;
    const m = mainIndi ? collectMediaRefs(mainIndi.raw, mainDs.records).length : 0;
    const c = compareIndi ? collectMediaRefs(compareIndi.raw, compareDs.records).length : 0;
    return m + c > 0;
  }, [folderName, mainIndi, compareIndi, mainDs.records, compareDs.records]);
  const rows = useMemo<FieldRow[]>(() => {
    const rejectedEvents = decision?.rejectedEvents?.length ? new Set(decision.rejectedEvents) : undefined;
    return individualFieldRows(t, mainIndi, compareIndi, mainDs, compareDs, undefined, rejectedEvents, settings.showAge);
  }, [mainIndi, compareIndi, mainDs, compareDs, t, decision, settings.showAge]);

  const status = decision?.status ?? "undecided";
  const fields = decision?.fields ?? {};
  const takenChildren = useMemo(() => new Set(decision?.takenChildren ?? []), [decision]);
  // A rejected/deferred match never applies any incoming data on save (see
  // `mergeDecisions`, which skips non-"confirmed" decisions outright) — so the
  // preview shows every field as kept from main, regardless of any per-field
  // choice recorded earlier while the match was still confirmed.
  const forceMain = status === "rejected" || status === "deferred";

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
   * Per-pair emphasis and control for the children row. A child the main
   * family already lists agrees (kept, "="); a main-only child is kept; an
   * incoming-only child is opt-in — its own take/skip toggle drives whether it's
   * stitched in (recorded in `decision.takenChildren`).
   */
  function renderChildPair(pair: RelativePair) {
    const hasMain = !!pair.main?.text;
    const hasIncoming = !!pair.incoming?.text;
    const incId = pair.incoming?.id;
    if (hasMain) {
      const choiceNode = hasIncoming
        ? <span className="muted">=</span>
        : <span className="gm-main-tag">{t("compare.keepMain")}</span>;
      return { mainChosen: true, incomingChosen: false, choice: choiceNode };
    }
    // Incoming-only child.
    const taken = !forceMain && !!incId && takenChildren.has(incId);
    if (forceMain || !incId) {
      return { mainChosen: false, incomingChosen: false, choice: <span className="gm-main-tag">{t("compare.keepMain")}</span> };
    }
    return {
      mainChosen: false,
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
    if (forceMain) return <span className="gm-main-tag">{t("compare.keepMain")}</span>;
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
    return <span className="gm-main-tag">{t("compare.keepMain")}</span>;
  }

  return (
    <div className="compare-panel">
      {hasMedia && (
        <div className="compare-media">
          <div className="compare-media-col">
            {mainIndi && (
              <PersonMedia
                raw={mainIndi.raw}
                records={mainDs.records}
                refCtx={{ dataset: mainDs, onNavigate: mainPerson.onNavigate }}
              />
            )}
          </div>
          <div className="compare-media-col">
            {compareIndi && (
              <PersonMedia
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
            <th className="compare-col compare-col-main">{t("tree.main")}</th>
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
                  <td colSpan={4} className={isEventHeader ? "group-header-cell event-header-cell" : "group-header-cell"} title={row.labelTitle}>
                    {row.label}
                  </td>
                </tr>
              );
            }

            const choice = forceMain ? "main" : fields[row.key] ?? defaultChoice(row);
            // A sources row can be link-icons-only (no actual SOUR citation on
            // either side yet) — still route it through the icon rendering below
            // rather than the plain-text branch, which would print the bare URL.
            const hasSources = !!(row.mainSources || row.incomingSources || row.mainLinkIcons || row.incomingLinkIcons);
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
                      mainChosen={choice !== "incoming"}
                      incomingChosen={choice !== "main"}
                      mainPerson={mainPerson}
                      incomingPerson={incomingPerson}
                      {...(row.perChildChoice
                        ? { renderPair: renderChildPair }
                        : { renderChoice: () => renderChoiceCell(row, choice) })}
                    />
                  </td>
                ) : hasSources ? (
                  <>
                    <td className={choice !== "incoming" ? "f-val gm-data chosen" : "f-val gm-data"}>
                      <SourceRefs t={t} mainSources={row.mainSources} />
                      {row.mainLinkIcons?.length ? <LinkIcons urls={row.mainLinkIcons} otherUrls={row.incomingLinkIcons} /> : null}
                    </td>
                    <td className={choice !== "main" ? "f-val gm-data chosen" : "f-val gm-data"}>
                      <SourceRefs t={t} mainSources={row.incomingSources} compareAgainst={row.mainSources} />
                      {row.incomingLinkIcons?.length ? <LinkIcons urls={row.incomingLinkIcons} otherUrls={row.mainLinkIcons} /> : null}
                    </td>
                  </>
                ) : (
                  <>
                    <td
                      className={choice !== "incoming" ? "f-val gm-data chosen" : "f-val gm-data"}
                      title={row.mainTitle}
                    >
                      <FieldValue
                        text={row.main}
                        links={row.mainLinks}
                        linkIcons={row.mainLinkIcons}
                        otherLinkIcons={row.incomingLinkIcons}
                        person={row.mainRefs ? { refs: row.mainRefs, ...mainPerson } : undefined}
                      />
                      <EventAges ages={row.mainAges} />
                    </td>
                    <td
                      className={choice !== "main" ? "f-val gm-data chosen" : "f-val gm-data"}
                      title={row.incomingTitle}
                    >
                      <FieldValue
                        text={row.incoming}
                        links={row.incomingLinks}
                        otherLinks={row.mainLinks}
                        linkIcons={row.incomingLinkIcons}
                        otherLinkIcons={row.mainLinkIcons}
                        person={row.incomingRefs ? { refs: row.incomingRefs, ...incomingPerson } : undefined}
                      />
                      <EventAges ages={row.incomingAges} />
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

/** Age badges shown after an event's date value ("Show ages" setting) — the
 *  same muted "♂32 ♀28" / "62" chips the Edit view renders. */
function EventAges({ ages }: { ages?: { text: string; title: string }[] }) {
  if (!ages?.length) return null;
  return (
    <span className="edit-event-age compare-event-age gm-data">
      {ages.map((a, i) => (
        <span key={i} title={a.title}>{a.text}</span>
      ))}
    </span>
  );
}

function choiceLabel(t: Translate, c: FieldChoice): string {
  return t(`choice.${c}.label`);
}
function choiceTitle(t: Translate, c: FieldChoice): string {
  return t(`choice.${c}.title`);
}
