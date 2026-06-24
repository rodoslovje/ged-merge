import { useEffect, useRef, useState } from "react";
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
      {matchStatus && matchStatus !== "undecided" && (
        <span className={`status-chip ${matchStatus}`} title={t(`status.${matchStatus}`)}>
          {t(`status.${matchStatus}`).charAt(0)}
        </span>
      )}
      {hasMatch && (
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
        </div>
      )}
    </div>
  );
}
