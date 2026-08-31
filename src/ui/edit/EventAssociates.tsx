import { useState, type ReactNode } from "react";
import type { Association, AssocRole, Dataset, GedNode, Sex } from "../../gedcom/types";
import { lifespanWithAge } from "../../gedcom/age";
import { useNameOf, useSettingsSlice } from "../SettingsContext";
import { sexClass } from "../sex";
import type { Translate } from "../../locales/i18n";
import { EDITABLE_ASSOC_ROLES, isVoidAssociation } from "../../gedcom/assoc";
import { canWriteNameOnly } from "../../gedcom/edit";
import { PersonLink } from "../PersonLink";
import { RelativePickerCard } from "./RelativePickerCard";
import { DropdownMenu } from "../DropdownMenu";
import { useAssoc, type AssocApi } from "./AssocContext";

/**
 * The role in words: the file's own wording where it has one, else the
 * translated name of the role it was read as.
 *
 * `sex` picks the exact word where the language has one — "boter" or "botra",
 * godfather or godmother. Without it (an associate the file records as nobody,
 * or one whose sex it never states) the neutral form stands.
 */
export function roleLabel(assoc: Association, t: Translate, sex?: Sex): string {
  const own = assoc.roleText?.trim();
  if (own) return own;
  return t(`assoc.role.${assoc.role}`, { context: sex === "M" || sex === "F" ? sex : undefined });
}

/**
 * The associate's name as the app writes it elsewhere, shown while their role
 * is being chosen — a pick you cannot see is a pick you cannot check. Not a
 * link: following it mid-form would abandon the form.
 */
export function PersonChip({
  dataset,
  targetId,
  name,
}: {
  dataset: Dataset;
  targetId?: string;
  /** For an associate the file records as nobody: the typed name. */
  name?: string;
}) {
  const nameOf = useNameOf();
  const settings = useSettingsSlice(CHIP_SETTINGS);
  const indi = targetId ? dataset.individuals.get(targetId) : undefined;
  if (!indi) return <span className="person-label">{name}</span>;
  const span = lifespanWithAge(indi, settings.showAge);
  return (
    <span className={`person-label ${sexClass(indi.sex)}`}>
      <span className="person-name">{nameOf(indi)}</span>
      {span && <span className="person-years gm-data">{span}</span>}
    </span>
  );
}

const CHIP_SETTINGS = ["showAge"] as const;

/** The associate's sex, where the file records them and states it. */
function sexOfTarget(api: AssocApi | null, assoc: Association): Sex | undefined {
  if (!api || isVoidAssociation(assoc)) return undefined;
  return api.dataset.individuals.get(assoc.targetId)?.sex;
}

/** Pick the role, and — for one the vocabulary has no word for — the wording to
 *  keep instead. */
export function RoleForm({
  t,
  initial,
  who,
  sex,
  onSave,
  onCancel,
}: {
  t: Translate;
  initial?: Association;
  /** Who the role is being chosen for — kept on screen throughout. */
  who?: ReactNode;
  /** Their sex, so the options read "boter" rather than "boter/botra" once
   *  there is a person to say it about. */
  sex?: Sex;
  onSave: (role: AssocRole, roleText?: string) => void;
  onCancel: () => void;
}) {
  const [role, setRole] = useState<AssocRole>(initial?.role ?? "GODP");
  const [text, setText] = useState(initial?.roleText ?? "");

  return (
    <span className="edit-assoc-roleform">
      {who}
      <select
        className="edit-assoc-select"
        value={role}
        onChange={(e) => setRole(e.target.value as AssocRole)}
        aria-label={t("assoc.roleLabel")}
        autoFocus
      >
        {EDITABLE_ASSOC_ROLES.map((r) => (
          <option key={r} value={r}>
            {t(`assoc.role.${r}`, { context: sex === "M" || sex === "F" ? sex : undefined })}
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
              who={
                <PersonChip
                  dataset={api.dataset}
                  targetId={isVoidAssociation(assoc) ? undefined : assoc.targetId}
                  name={assoc.name}
                />
              }
              sex={sexOfTarget(api, assoc)}
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
              <span className="edit-assoc-role">{roleLabel(assoc, t, sexOfTarget(api, assoc))}</span>
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
          who={<PersonChip dataset={api.dataset} targetId={picked.targetId} name={picked.name} />}
          sex={picked.targetId ? api.dataset.individuals.get(picked.targetId)?.sex : undefined}
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
