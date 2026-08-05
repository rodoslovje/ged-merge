import { useState, type ReactNode } from "react";
import type { Individual } from "../../gedcom/types";
import type { Translate } from "../../locales/i18n";
import { addAdditionalName, removeAdditionalName, setNickname, setMarriedName } from "../../gedcom/edit";
import { primaryName, displayName, nameTypeLabel } from "../../match/relatives";
import { NicknameEditor } from "./NicknameEditor";
import { MarriedNameEditor } from "./MarriedNameEditor";
import { NameVariantEditor } from "./NameVariantEditor";
import { AddEventSelect } from "./AddEventSelect";
import { eventDisplayLabel } from "../../gedcom/eventTags";
import type { Commit } from "./types";

/** Nickname plus any further `NAME` records (married/maiden/aka/…), shown as
 * chips that turn into editable fields on click, plus a single "+ Add name"
 * button and an "+ Add event" dropdown to append events from the same row. */
export function OtherNamesEditor({
  person,
  t,
  commit,
  emptyEventGroups,
  onAddEvent,
  quickEventTags,
  showAddLink,
  onAddLink,
  showAddNote,
  onAddNote,
  showAddMedia,
  onAddMedia,
  showAddFsId,
  onAddFsId,
  marriedNameTag,
  leadingControl,
}: {
  person: Individual;
  t: Translate;
  commit: Commit;
  emptyEventGroups: { labelKey: string; tags: string[] }[];
  onAddEvent: (tag: string) => void;
  /** Quick-add buttons (Settings › Quick add events), in order — rendered on
   *  their own row with the "+ Add event" menu; digits 1–9 mirror them. */
  quickEventTags?: string[];
  showAddLink: boolean;
  onAddLink: () => void;
  showAddNote: boolean;
  onAddNote: () => void;
  /** True when the person has no media yet, so an empty-state "+ Add media"
   * chip belongs in this row (the tray hosts adding once photos exist). */
  showAddMedia: boolean;
  onAddMedia: () => void;
  /** True when the person has no FamilySearch id yet — shows the "+ FamilySearch
   * ID" chip (the chips themselves live in `FsIdEditor` below this row). */
  showAddFsId: boolean;
  onAddFsId: () => void;
  /** True when the main file records married surnames inline as `_MARNM`, so
   * choosing the "married" type on an added name stores it there instead of as a
   * separate `TYPE married` NAME record. */
  marriedNameTag?: boolean;
  /** Rendered at the start of the actions row, before "+ Add event" (the sex picker). */
  leadingControl?: ReactNode;
}) {
  const [editing, setEditing] = useState<"nick" | "married" | number | null>(null);
  const primary = primaryName(person);
  const extraNames = person.names.slice(1);
  const hasNamesContent = editing !== null || !!primary?.nickname || !!primary?.married || extraNames.length > 0;
  const quick = quickEventTags ?? [];

  // With quick buttons configured, "+ Add event" moves to its own row and the
  // quick events line up beside it; without any it stays in the actions row.
  const addEventChip = (
    <AddEventSelect
      groups={emptyEventGroups}
      label={t("edit.addEvent")}
      tooltip={t("edit.addEventTooltip")}
      t={t}
      onAdd={onAddEvent}
      className="edit-name-chip edit-name-chip-add"
    />
  );

  const addNameBtn = (
    <button
      type="button"
      className="edit-name-chip edit-name-chip-add"
      title={t("edit.addNameTooltip")}
      onClick={() => {
        commit((indi) => addAdditionalName(indi, "aka"));
        setEditing(extraNames.length);
      }}
    >
      + {t("edit.addName")}
    </button>
  );

  return (
    <div className="edit-other-names">
      {/* Names row — only shown when there are names or editing */}
      {hasNamesContent && (
        <div className="edit-other-names-row">
          {editing === "nick" ? (
            <NicknameEditor person={person} t={t} commit={commit} onDone={() => setEditing(null)} />
          ) : primary?.nickname ? (
            <span className="edit-name-chip-wrap">
              <button type="button" className="edit-name-chip" onClick={() => setEditing("nick")}>
                {primary.nickname}
                <span className="muted"> ({nameTypeLabel("nick", t)})</span>
              </button>
              <button
                type="button"
                className="edit-link-remove"
                title={t("edit.removeName")}
                onClick={() => commit((indi) => setNickname(indi, ""))}
              >
                ×
              </button>
            </span>
          ) : null}
          {editing === "married" ? (
            <MarriedNameEditor person={person} t={t} commit={commit} onDone={() => setEditing(null)} />
          ) : primary?.married ? (
            <span className="edit-name-chip-wrap">
              <button type="button" className="edit-name-chip" onClick={() => setEditing("married")}>
                {primary.married}
                <span className="muted"> ({nameTypeLabel("married", t)})</span>
              </button>
              <button
                type="button"
                className="edit-link-remove"
                title={t("edit.removeName")}
                onClick={() => commit((indi) => setMarriedName(indi, ""))}
              >
                ×
              </button>
            </span>
          ) : null}
          {extraNames.map((n, i) =>
            editing === i ? (
              <NameVariantEditor key={i} person={person} index={i} t={t} commit={commit} marriedNameTag={marriedNameTag} onDone={() => setEditing(null)} />
            ) : (
              <span className="edit-name-chip-wrap" key={i}>
                <button type="button" className="edit-name-chip" onClick={() => setEditing(i)}>
                  {displayName(n)}
                  {n.type && <span className="muted"> ({nameTypeLabel(n.type, t)})</span>}
                </button>
                <button
                  type="button"
                  className="edit-link-remove"
                  title={t("edit.removeName")}
                  onClick={() => commit((indi) => removeAdditionalName(indi, i))}
                >
                  ×
                </button>
              </span>
            ),
          )}
          {addNameBtn}
        </div>
      )}
      {/* Action chips row — always present */}
      <div className="edit-other-names-row edit-other-names-actions">
        {leadingControl}
        {quick.length === 0 && addEventChip}
        {showAddMedia && (
          <button
            type="button"
            className="edit-name-chip edit-name-chip-add"
            title={t("media.add")}
            onClick={onAddMedia}
          >
            + {t("media.add")}
          </button>
        )}
        {showAddLink && (
          <button
            type="button"
            className="edit-name-chip edit-name-chip-add"
            title={t("edit.addLinkTooltip")}
            onClick={onAddLink}
          >
            + {t("edit.addLink")}
          </button>
        )}
        {showAddNote && (
          <button
            type="button"
            className="edit-name-chip edit-name-chip-add"
            title={t("edit.addNoteTooltip")}
            onClick={onAddNote}
          >
            + {t("edit.addNote")}
          </button>
        )}
        {showAddFsId && (
          <button
            type="button"
            className="edit-name-chip edit-name-chip-add"
            title={t("edit.addFsIdTooltip")}
            onClick={onAddFsId}
          >
            + {t("edit.addFsId")}
          </button>
        )}
        {!hasNamesContent && addNameBtn}
      </div>
      {/* Quick-add row: the event menu plus the configured one-click events.
       *  Digits 1–9 trigger the same buttons in this order (EditView). */}
      {quick.length > 0 && (
        <div className="edit-other-names-row edit-other-names-actions">
          {addEventChip}
          {quick.map((tag, i) => (
            <button
              key={tag}
              type="button"
              className="edit-name-chip edit-name-chip-add"
              title={t("edit.quickAdd.tooltip", { event: eventDisplayLabel(tag, t), key: i + 1 })}
              onClick={() => onAddEvent(tag)}
            >
              + {eventDisplayLabel(tag, t)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
