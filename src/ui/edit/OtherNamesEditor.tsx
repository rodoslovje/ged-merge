import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Individual, PersonName } from "../../gedcom/types";
import type { Translate } from "../../locales/i18n";
import type { FieldChoice } from "../../review/types";
import { addAdditionalName, removeAdditionalName, setNickname, setMarriedName } from "../../gedcom/edit";
import { primaryName, displayName, nameTypeLabel } from "../../match/relatives";
import { NicknameEditor } from "./NicknameEditor";
import { MarriedNameEditor } from "./MarriedNameEditor";
import { NameVariantEditor } from "./NameVariantEditor";
import type { Commit } from "./types";

/** Nickname plus any further `NAME` records (married/maiden/aka/…), shown as
 * chips that turn into editable fields on click, plus a single "+ Add name"
 * button and an "+ Add event" dropdown to append events from the same row. */
export function OtherNamesEditor({
  person,
  t,
  commit,
  showAddLink,
  onAddLink,
  showAddNote,
  onAddNote,
  showAddMedia,
  onAddMedia,
  showAddFsId,
  onAddFsId,
  addNameNonce,
  marriedNameTag,
  leadingControl,
  mergeNames,
  onTakeMergeNames,
}: {
  person: Individual;
  t: Translate;
  commit: Commit;
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
  /** Increment to add an alternative name and open it for editing (⌥⇧A). */
  addNameNonce?: number;
  /** True when the main file records married surnames inline as `_MARNM`, so
   * choosing the "married" type on an added name stores it there instead of as a
   * separate `TYPE married` NAME record. */
  marriedNameTag?: boolean;
  /** Rendered at the start of the actions row, before "+ Add event" (the sex picker). */
  leadingControl?: ReactNode;
  /** A confirmed match's incoming additional names, previewed as chips the way
   * the merge will write them (see `useMergeOverlay`); `choice` says whether
   * the person's own extra names stay beside them (`both`) or give way. */
  mergeNames?: { names: PersonName[]; choice: FieldChoice };
  /** Write `mergeNames` into the record now, in one step with `then` — the
   * chips become the person's own names, ready to edit or remove. */
  onTakeMergeNames?: (then?: (indi: Individual) => void) => void;
}) {
  const [editing, setEditing] = useState<"nick" | "married" | number | null>(null);
  const primary = primaryName(person);
  const extraNames = person.names.slice(1);
  const hasNamesContent = editing !== null || !!primary?.nickname || !!primary?.married || extraNames.length > 0 || !!mergeNames;
  /** The person's own extra names the merge will replace — shown struck through. */
  const replaced = !!mergeNames && mergeNames.choice !== "both";
  /** Where the `i`th incoming name lands in `extraNames` once taken over. */
  const takenIndex = (i: number) => (replaced ? i : extraNames.length + i);

  // ⌥⇧A does what the "+ Add Name" chip does. The ref guard skips the value
  // seen at mount, so a remount on person switch adds nothing by itself.
  const seenAddNameNonce = useRef(addNameNonce ?? 0);
  useEffect(() => {
    if (!addNameNonce || addNameNonce === seenAddNameNonce.current) return;
    seenAddNameNonce.current = addNameNonce;
    commit((indi) => addAdditionalName(indi, "aka"));
    setEditing(person.names.length - 1);
  }, [addNameNonce, commit, person]);

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
                <button type="button" className={`edit-name-chip${replaced ? " edit-name-chip--replaced" : ""}`} onClick={() => setEditing(i)}>
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
          {/* Incoming names a confirmed merge will add: a click takes them into
              the record and opens the clicked one; × takes them and drops it. */}
          {mergeNames?.names.map((n, i) => (
            <span className="edit-name-chip-wrap" key={`merge-${i}`}>
              <button
                type="button"
                className="edit-name-chip edit-name-chip--merge"
                title={t("edit.mergeNameTooltip")}
                onClick={() => { onTakeMergeNames?.(); setEditing(takenIndex(i)); }}
              >
                {displayName(n)}
                {n.type && <span className="muted"> ({nameTypeLabel(n.type, t)})</span>}
              </button>
              <button
                type="button"
                className="edit-link-remove"
                title={t("edit.skipMergeName")}
                onClick={() => onTakeMergeNames?.((indi) => removeAdditionalName(indi, takenIndex(i)))}
              >
                ×
              </button>
            </span>
          ))}
          {addNameBtn}
        </div>
      )}
      {/* Action chips row — always present */}
      <div className="edit-other-names-row edit-other-names-actions">
        {leadingControl}
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
    </div>
  );
}
