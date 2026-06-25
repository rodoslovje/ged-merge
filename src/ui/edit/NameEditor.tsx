import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Individual } from "../../gedcom/types";
import type { Translate } from "../../locales/i18n";
import type { MatchDecisionStatus } from "../../review/types";
import { datesTooltipOf } from "../../gedcom/lifespan";
import { primaryName } from "../../match/relatives";
import { sexClass } from "../sex";
import { setName } from "../../gedcom/edit";
import { ClearableInput } from "./ClearableInput";
import type { Commit } from "./types";
import { fieldWidth, MATCH_STATUSES } from "./editConstants";

/** Editable given/surname fields for the primary name, plus the lifespan. */
export function NameEditor({
  person,
  t,
  lifespan,
  commit,
  focusOnMount,
  onMounted,
  mergeHighlight,
  hasMatch,
  matchStatus,
  onToggleMatchStatus,
  kinship,
  kinshipTooltip,
  controls,
}: {
  person: Individual;
  t: Translate;
  lifespan?: string;
  commit: Commit;
  focusOnMount?: boolean;
  onMounted?: () => void;
  mergeHighlight?: Map<string, string>;
  /** True when this person has an incoming match candidate. */
  hasMatch?: boolean;
  matchStatus?: MatchDecisionStatus;
  onToggleMatchStatus?: (status: MatchDecisionStatus) => void;
  /** Kinship label shown inline in the name row (e.g. "Great-grandmother ×9"). */
  kinship?: string;
  kinshipTooltip?: string;
  /** Delete control, placed at the far right of the decision row (or the name row if no match). */
  controls?: ReactNode;
}) {
  const primary = primaryName(person);
  // Stable merge values from first render (component is keyed per person)
  const givenMergeInit = useRef(mergeHighlight?.get("given"));
  const surnameMergeInit = useRef(mergeHighlight?.get("surname"));
  const [given, setGiven] = useState(givenMergeInit.current ?? primary?.given ?? "");
  const [surname, setSurname] = useState(surnameMergeInit.current ?? primary?.surname ?? "");
  const givenRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focusOnMount) givenRef.current?.focus();
    onMounted?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function commitName(nextGiven: string, nextSurname: string) {
    commit((indi) => setName(indi, { given: nextGiven, surname: nextSurname }));
  }

  const givenIsMerge = givenMergeInit.current !== undefined && given === givenMergeInit.current;
  const surnameIsMerge = surnameMergeInit.current !== undefined && surname === surnameMergeInit.current;

  return (
    <div className="edit-name-row" title={datesTooltipOf(person)}>
      {/* Given + surname stay together as one unwrappable unit, so a tight
          header wraps the Sex/Delete controls to their own row (see
          `.edit-person-header`) rather than breaking the name across lines. */}
      <div className="edit-name-fields">
        <ClearableInput
          ref={givenRef}
          className={`edit-input edit-name-input ${sexClass(person.sex)}${givenIsMerge ? " edit-input--merge" : ""}`}
          wrapStyle={{ width: fieldWidth(given, t("field.given")) }}
          value={given}
          placeholder={t("field.given")}
          title={t("field.given")}
          onChange={(e) => setGiven(e.target.value)}
          onBlur={() => commitName(given, surname)}
          onClear={() => { setGiven(""); commitName("", surname); }}
        />
        <ClearableInput
          className={`edit-input edit-name-input ${sexClass(person.sex)}${surnameIsMerge ? " edit-input--merge" : ""}`}
          wrapStyle={{ width: fieldWidth(surname, t("field.surname")) }}
          value={surname}
          placeholder={t("field.surname")}
          title={t("field.surname")}
          onChange={(e) => setSurname(e.target.value)}
          onBlur={() => commitName(given, surname)}
          onClear={() => { setSurname(""); commitName(given, ""); }}
        />
        {lifespan && <span className="person-years gm-data">{lifespan}</span>}
      </div>
      {kinship && <span className="person-kinship" title={kinshipTooltip}>{kinship}</span>}
      {matchStatus && matchStatus !== "undecided" && (
        <span className={`status-chip ${matchStatus}`} title={t(`status.${matchStatus}`)}>
          {t(`status.${matchStatus}`).charAt(0)}
        </span>
      )}
      {hasMatch ? (
        <div className="decision-bar edit-name-decisions">
          {MATCH_STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              className={matchStatus === s ? `decision ${s} active` : "decision"}
              title={t(`status.${s}`)}
              onClick={() => onToggleMatchStatus?.(s)}
            >
              {t(`status.${s}`)}
            </button>
          ))}
          {controls && <div className="edit-name-controls">{controls}</div>}
        </div>
      ) : (
        controls && <div className="edit-name-controls edit-name-controls--solo">{controls}</div>
      )}
    </div>
  );
}
