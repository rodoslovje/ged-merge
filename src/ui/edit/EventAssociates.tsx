import { useState } from "react";
import type { Association, AssocRole, GedNode } from "../../gedcom/types";
import type { Translate } from "../../locales/i18n";
import { EDITABLE_ASSOC_ROLES, isVoidAssociation } from "../../gedcom/assoc";
import { canWriteNameOnly } from "../../gedcom/edit";
import { PersonLink } from "../PersonLink";
import { RelativePickerCard } from "./RelativePickerCard";
import { DropdownMenu } from "../DropdownMenu";
import { useAssoc } from "./AssocContext";

/** The role in words: the file's own wording where it has one, else the
 *  translated name of the role it was read as. */
export function roleLabel(assoc: Association, t: Translate): string {
  return assoc.roleText?.trim() || t(`assoc.role.${assoc.role}`);
}

/** Pick the role, and — for one the vocabulary has no word for — the wording to
 *  keep instead. */
export function RoleForm({
  t,
  initial,
  onSave,
  onCancel,
}: {
  t: Translate;
  initial?: Association;
  onSave: (role: AssocRole, roleText?: string) => void;
  onCancel: () => void;
}) {
  const [role, setRole] = useState<AssocRole>(initial?.role ?? "GODP");
  const [text, setText] = useState(initial?.roleText ?? "");

  return (
    <span className="edit-assoc-roleform">
      <select
        className="edit-assoc-select"
        value={role}
        onChange={(e) => setRole(e.target.value as AssocRole)}
        aria-label={t("assoc.roleLabel")}
        autoFocus
      >
        {EDITABLE_ASSOC_ROLES.map((r) => (
          <option key={r} value={r}>
            {t(`assoc.role.${r}`)}
          </option>
        ))}
      </select>
      {role === "OTHER" && (
        <input
          className="edit-assoc-input"
          value={text}
          placeholder={t("assoc.roleTextPlaceholder")}
          onChange={(e) => setText(e.target.value)}
          aria-label={t("assoc.roleTextLabel")}
        />
      )}
      <button type="button" className="edit-assoc-action" onClick={() => onSave(role, text.trim() || undefined)}>
        {t("assoc.save")}
      </button>
      <button type="button" className="edit-assoc-action" onClick={onCancel}>
        {t("assoc.cancel")}
      </button>
    </span>
  );
}

/**
 * The people an event names, edited on the event's own row: a chip each, plus
 * the picker behind the row's "+ Add › Association" entry.
 *
 * Outside the Edit view there is no {@link useAssoc} provider and the chips are
 * plain text — the merge's read-only rows have nothing to edit.
 */
export function EventAssociates({
  associations,
  container,
  ownerId,
  t,
  picking,
  onDonePicking,
  moveTargets,
}: {
  associations: Association[];
  /** The event node the associations hang under. */
  container: GedNode | undefined;
  /** The record the event belongs to — a person, or the family of a marriage.
   *  The edit commits against it, and a person is never offered as their own
   *  associate. */
  ownerId: string;
  t: Translate;
  /** True while "+ Add › Association" has the picker open on this row. */
  picking: boolean;
  onDonePicking: () => void;
  /**
   * Events this association could be moved onto, for one sitting on the record
   * itself — which is all a 5.5.1 file can write, and where an import may have
   * left a godparent whose baptism the file never named. Omitted on an event's
   * own row: it is already where it belongs.
   */
  moveTargets?: { node: GedNode; label: string }[];
}) {
  const api = useAssoc();
  const [editing, setEditing] = useState<Association | null>(null);
  const [picked, setPicked] = useState<{ targetId?: string; name?: string } | null>(null);

  const close = () => {
    setPicked(null);
    setEditing(null);
    onDonePicking();
  };

  return (
    <>
      {associations.map((assoc, i) => (
        <span key={i} className="edit-event-assoc">
          {api && editing === assoc ? (
            <RoleForm
              t={t}
              initial={assoc}
              onCancel={() => setEditing(null)}
              onSave={(role, roleText) => {
                api.update(ownerId, assoc.raw, {
                  targetId: isVoidAssociation(assoc) ? undefined : assoc.targetId,
                  name: assoc.name,
                  role,
                  roleText,
                });
                setEditing(null);
              }}
            />
          ) : (
            <>
              {isVoidAssociation(assoc) || !api ? (
                // Named, but recorded as nobody: there is no record to open, and
                // dressing the text up as a link would promise one.
                <span className="edit-assoc-name-only" title={t("assoc.nameOnlyTip")}>
                  {assoc.name || assoc.targetId}
                </span>
              ) : (
                <PersonLink
                  dataset={api.dataset}
                  id={assoc.targetId}
                  fallback={assoc.name || assoc.targetId}
                  onNavigate={api.navigate}
                />
              )}
              <span className="edit-assoc-role">{roleLabel(assoc, t)}</span>
              {api && container && (
                <>
                  <button
                    type="button"
                    className="edit-assoc-action"
                    title={t("assoc.editRole")}
                    onClick={() => setEditing(assoc)}
                  >
                    ✎
                  </button>
                  {!!moveTargets?.length && (
                    <DropdownMenu
                      className="edit-assoc-action"
                      title={t("assoc.moveTip")}
                      ariaLabel={t("assoc.move")}
                      groups={[{ label: t("assoc.move"), items: moveTargets.map((m, mi) => ({ value: String(mi), label: m.label })) }]}
                      onSelect={(v) => api.move(ownerId, container, moveTargets[Number(v)].node, assoc.raw)}
                      trigger="↧"
                    />
                  )}
                  <button
                    type="button"
                    className="edit-assoc-action edit-assoc-remove"
                    title={t("assoc.remove")}
                    onClick={() => api.remove(ownerId, container, assoc.raw)}
                  >
                    ✕
                  </button>
                </>
              )}
            </>
          )}
        </span>
      ))}
      {api && container && picking && !picked && (
        <RelativePickerCard
          roleLabel={t("assoc.pickLabel")}
          individuals={api.dataset.individuals}
          excludeId={ownerId}
          onPickExisting={(id) => setPicked({ targetId: id })}
          // In a 7.0 file the extra row records the typed name on the
          // association itself (`@VOID@` + `PHRASE`) rather than minting a
          // person — the godparent is named, not researched. A 5.5.1 file has
          // no such form, so it offers only people the file already holds.
          onAddNew={
            canWriteNameOnly(api.version)
              ? (typed) => (typed.trim() ? setPicked({ name: typed.trim() }) : close())
              : undefined
          }
          newLabel={t("assoc.nameOnly")}
          onCancel={close}
          t={t}
        />
      )}
      {api && container && picking && picked && (
        <RoleForm
          t={t}
          onCancel={close}
          onSave={(role, roleText) => {
            api.add(ownerId, container, { targetId: picked.targetId, name: picked.name, role, roleText });
            close();
          }}
        />
      )}
    </>
  );
}
