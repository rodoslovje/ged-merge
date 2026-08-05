import React, { useEffect, useRef, useState, type ReactNode } from "react";
import type { Individual } from "../../gedcom/types";
import type { Translate } from "../../locales/i18n";
import type { MatchDecisionStatus } from "../../review/types";
import { lifespanTooltipOf } from "../../gedcom/age";
import { primaryName } from "../../match/relatives";
import { xrefLabel } from "../../gedcom/nameDisplay";
import { sexClass } from "../sex";
import { useSettingsSlice } from "../SettingsContext";
import { setName } from "../../gedcom/edit";
import { ClearableInput } from "./ClearableInput";
import type { Commit } from "./types";
import { fieldWidth, MATCH_STATUSES } from "./editConstants";

/** The preferences this file reads — subscribed field by field, so an
 *  unrelated one changing leaves it alone (see useSettingsSlice). */
const SETTINGS_KEYS = ["showAge", "showXref"] as const;

/** Editable given/surname fields for the primary name, plus the lifespan. */
export function NameEditor({
  person,
  t,
  lifespan,
  commit,
  focusOnMount,
  onEnterPastName,
  onMounted,
  mergeHighlight,
  hasMatch,
  matchStatus,
  onToggleMatchStatus,
  kinship,
  kinshipLineage,
  kinshipTooltip,
  modified,
  controls,
}: {
  person: Individual;
  t: Translate;
  lifespan?: string;
  commit: Commit;
  focusOnMount?: boolean;
  /** Enter on the surname — the end of the name — carries on to the event the
   *  person is usually given next (their birth). */
  onEnterPastName?: () => void;
  onMounted?: () => void;
  mergeHighlight?: Map<string, string>;
  /** True when this person has an incoming match candidate. */
  hasMatch?: boolean;
  matchStatus?: MatchDecisionStatus;
  onToggleMatchStatus?: (status: MatchDecisionStatus) => void;
  /** Kinship label shown inline in the name row (e.g. "Great-grandmother ×9"). */
  kinship?: string;
  /** CSS modifier class colouring the kinship by blood lineage (e.g. "lineage-maternal"). */
  kinshipLineage?: string;
  kinshipTooltip?: string;
  /** True when this person's record has unsaved edits — shows the same "modified"
   *  chip the relative cards and tree nodes use. */
  modified?: boolean;
  /** Delete control, placed at the far right of the decision row (or the name row if no match). */
  controls?: ReactNode;
}) {
  const settings = useSettingsSlice(SETTINGS_KEYS);
  const primary = primaryName(person);
  // Stable merge values from first render (component is keyed per person)
  const givenMergeInit = useRef(mergeHighlight?.get("given"));
  const surnameMergeInit = useRef(mergeHighlight?.get("surname"));
  const [given, setGiven] = useState(givenMergeInit.current ?? primary?.given ?? "");
  const [surname, setSurname] = useState(surnameMergeInit.current ?? primary?.surname ?? "");
  const givenRef = useRef<HTMLInputElement>(null);
  const surnameRef = useRef<HTMLInputElement>(null);

  /** Enter steps along the name and out the far end of it, the way it steps
   *  through an event's fields — the fast path from a new person to their
   *  birth date, which is otherwise a dozen buttons away in the tab order. */
  const enterMovesOn = (go: () => void) => (e: React.KeyboardEvent) => {
    if (e.key !== "Enter" || e.defaultPrevented) return;
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    e.preventDefault();
    go();
  };

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
    <div className="edit-name-row" title={lifespanTooltipOf(person, settings.showAge, t)}>
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
          onKeyDown={enterMovesOn(() => surnameRef.current?.focus())}
          onBlur={() => commitName(given, surname)}
          onClear={() => { setGiven(""); commitName("", surname); }}
        />
        <ClearableInput
          ref={surnameRef}
          className={`edit-input edit-name-input ${sexClass(person.sex)}${surnameIsMerge ? " edit-input--merge" : ""}`}
          wrapStyle={{ width: fieldWidth(surname, t("field.surname")) }}
          value={surname}
          placeholder={t("field.surname")}
          title={t("field.surname")}
          onChange={(e) => setSurname(e.target.value)}
          onKeyDown={onEnterPastName ? enterMovesOn(onEnterPastName) : undefined}
          onBlur={() => commitName(given, surname)}
          onClear={() => { setSurname(""); commitName(given, ""); }}
        />
        {/* Record id and lifespan, in the same order the relative cards use. */}
        {settings.showXref && <span className="person-xref gm-data">{xrefLabel(person.id)}</span>}
        {lifespan && <span className="person-years gm-data">{lifespan}</span>}
      </div>
      {kinship && <span className={`person-kinship ${kinshipLineage ?? ""}`} title={kinshipTooltip}>{kinship}</span>}
      {matchStatus && matchStatus !== "undecided" && (
        <span className={`status-chip ${matchStatus}`} title={t(`status.${matchStatus}`)}>
          {t(`status.${matchStatus}`).charAt(0)}
        </span>
      )}
      {modified && (
        <span className="status-chip modified" title={t("edit.tree.modified")}>
          {t("edit.tree.modified").charAt(0)}
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
