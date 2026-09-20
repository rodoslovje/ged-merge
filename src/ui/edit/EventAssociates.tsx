import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { Association, AssocRole, Dataset, GedNode, Sex } from "../../gedcom/types";
import { lifespanTooltipOf, lifespanWithAge } from "../../gedcom/age";
import { useNameOf, useSettingsSlice } from "../SettingsContext";
import { sexClass } from "../sex";
import type { Translate } from "../../locales/i18n";
import { EDITABLE_ASSOC_ROLES, isVoidAssociation, roleFromRela } from "../../gedcom/assoc";
import { canWriteNameOnly } from "../../gedcom/edit";
import { PersonLink } from "../PersonLink";
import { MARRIAGE_SYMBOL } from "../../chart/nodeDisplay";
import { isTallNoteList, NotesEditor } from "./NotesEditor";
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
  const { t } = useTranslation();
  const nameOf = useNameOf();
  const settings = useSettingsSlice(CHIP_SETTINGS);
  const indi = targetId ? dataset.individuals.get(targetId) : undefined;
  if (!indi) return <span className="person-label">{name}</span>;
  const span = lifespanWithAge(indi, settings.showAge);
  return (
    <span className={`person-label ${sexClass(indi.sex)}`}>
      <span className="person-name">{nameOf(indi)}</span>
      {span && (
        <span className="person-years gm-data" title={lifespanTooltipOf(indi, settings.showAge, t)}>
          {span}
        </span>
      )}
    </span>
  );
}

const CHIP_SETTINGS = ["showAge"] as const;

/**
 * A record an association points at, or is carried by. Usually a person; a
 * 5.5.1 file also points at a family (`ASSO @F14@ / TYPE FAM` — a witness at
 * that couple's marriage), and the same shape names the marriage a person was
 * a witness at. A family has no page of its own, so it reads as its couple,
 * each spouse a link to their own record — an `@F96@` said nothing about whose
 * wedding it was.
 */
export function RecordLink({
  dataset,
  id,
  fallback,
  onNavigate,
}: {
  dataset: Dataset;
  id: string;
  fallback: string;
  onNavigate: (id: string) => void;
}) {
  const fam = dataset.individuals.has(id) ? undefined : dataset.families.get(id);
  if (!fam) return <PersonLink dataset={dataset} id={id} fallback={fallback} onNavigate={onNavigate} />;
  const spouses = [fam.husband, fam.wife].filter((s): s is string => !!s);
  if (!spouses.length) return <span className="edit-assoc-name-only">{fallback}</span>;
  return (
    <span className="edit-assoc-couple">
      {spouses.map((spouseId, i) => (
        <span key={spouseId}>
          {i > 0 && <span className="edit-assoc-couple-join">{MARRIAGE_SYMBOL}</span>}
          <PersonLink dataset={dataset} id={spouseId} fallback={spouseId} onNavigate={onNavigate} />
        </span>
      ))}
    </span>
  );
}

/** Sentinel menu values for the entries that are not a role or a move target. */
const REMOVE_OPTION = "__remove_assoc__";
const NOTE_OPTION = "__note_assoc__";
/** Move targets are numbered; this tells their values from the sentinels. */
const MOVE_PREFIX = "move:";

/**
 * One associate as the row shows them: who they were, in what role, and what
 * the record said about them.
 *
 * Edited in place, the way an event's fields are — the role is a field that
 * looks like the words it holds until the pointer reaches it, and its own menu
 * carries the vocabulary plus the things that are not typing: a note, a move to
 * an event, and taking the person off the record. There is no edit button,
 * because there is nothing an edit button would open that is not already here.
 */
function AssociateChip({
  assoc,
  api,
  ownerId,
  container,
  t,
  moveTargets,
  removeTitle,
}: {
  assoc: Association;
  api: AssocApi;
  ownerId: string;
  container: GedNode;
  t: Translate;
  moveTargets?: { node: GedNode; label: string }[];
  removeTitle?: string;
}) {
  const sex = sexOfTarget(api, assoc);
  const shown = roleLabel(assoc, t, sex);
  const [role, setRole] = useState(shown);
  /** Opens a fresh, empty note on this row — the event rows' own trigger. */
  const [noteAdd, setNoteAdd] = useState(0);

  /** Write the role: a word of the file's own, or the vocabulary's. */
  const commit = (next: AssocRole, text: string | undefined) =>
    api.update(ownerId, assoc.raw, {
      targetId: isVoidAssociation(assoc) ? undefined : assoc.targetId,
      name: assoc.name,
      role: next,
      roleText: text,
      // A 5.5-era association may point at a family; changing its role must not
      // cost the `TYPE FAM` that says so.
      targetKind: assoc.targetKind,
    });

  return (
    <>
      {/* Typed over, the role becomes the file's own wording; the vocabulary is
          in the menu beside it. What stands here at rest is what the file says,
          so a row of matches reads "DNA match" and not "named without a role". */}
      <input
        className="edit-input edit-assoc-role edit-assoc-role-field"
        value={role}
        size={Math.max(6, role.length)}
        aria-label={t("assoc.roleLabel")}
        placeholder={t("assoc.roleTextPlaceholder")}
        onChange={(e) => setRole(e.target.value)}
        onBlur={() => {
          const text = role.trim();
          if (text === shown) return; // untouched: the file keeps its own words
          // Cleared, it falls back to the role the file was read as; typed over,
          // the words are kept verbatim and the role reads as OTHER.
          if (text) commit(roleFromRela(text), text);
          else commit(assoc.role, undefined);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          else if (e.key === "Escape") setRole(shown);
        }}
      />
      <DropdownMenu
        className="edit-assoc-role-menu"
        title={t("assoc.rowMenuTip")}
        ariaLabel={t("assoc.rowMenu")}
        current={assoc.role}
        groups={[
          { items: EDITABLE_ASSOC_ROLES.map((r) => ({ value: r, label: t(`assoc.role.${r}`, { context: sex === "M" || sex === "F" ? sex : undefined }) })) },
          ...(moveTargets?.length
            ? [{ label: t("assoc.move"), items: moveTargets.map((m, mi) => ({ value: `${MOVE_PREFIX}${mi}`, label: m.label })) }]
            : []),
          {
            items: [
              // The app's own words for this everywhere else — a note on an
              // association is a note like any other.
              { value: NOTE_OPTION, label: t("edit.addNote") },
              { value: REMOVE_OPTION, label: removeTitle ?? t("assoc.remove") },
            ],
          },
        ]}
        onSelect={(v) => {
          if (v === REMOVE_OPTION) api.remove(ownerId, container, assoc.raw);
          else if (v === NOTE_OPTION) setNoteAdd((n) => n + 1);
          else if (v.startsWith(MOVE_PREFIX) && moveTargets) {
            api.move(ownerId, container, moveTargets[Number(v.slice(MOVE_PREFIX.length))].node, assoc.raw);
          } else {
            // A role from the vocabulary replaces wording of the file's own:
            // "botra" and "witness" on one association is two answers.
            setRole(t(`assoc.role.${v}`, { context: sex === "M" || sex === "F" ? sex : undefined }));
            commit(v as AssocRole, undefined);
          }
        }}
        trigger={<span className="edit-assoc-role-caret" aria-hidden="true">▾</span>}
      />
      {/* The association's own notes, as chips — the same editor a person's or
          an event's notes use, because they are the same thing: `ASSO` carries
          `NOTE` in both dialects. Seeded from the record once, so the editor is
          remounted when a commit or an undo moves them underneath it. */}
      <NotesEditor
        key={noteEditorKey(assoc)}
        notes={assoc.noteRefs ?? []}
        addTrigger={noteAdd}
        t={t}
        onCommit={(refs) => api.notes(ownerId, assoc.raw, refs)}
      />
    </>
  );
}

/**
 * The association's first note written as text on the `ASSO` itself — the one
 * the role form edits. A pointer to a shared note record is deliberately not
 * offered there: it belongs to every record citing it, and a one-line field is
 * no place to rewrite something with other owners. Those are edited as chips on
 * the row, where the lock and the shared-note machinery are.
 */
function firstInlineNote(assoc: Association | undefined): string | undefined {
  return (assoc?.noteRefs ?? []).find((r) => !r.xref)?.text;
}

/** A note list's identity, for remounting the editor when the record's own
 *  notes have moved on under it (see the event rows, which key the same way). */
function noteEditorKey(assoc: Association): string {
  return (assoc.noteRefs ?? []).map((r) => `${r.xref ?? ""}:${r.text}:${r.private ? 1 : 0}`).join("|");
}

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
  onSave: (role: AssocRole, roleText?: string, note?: string) => void;
  onCancel: () => void;
}) {
  const [role, setRole] = useState<AssocRole>(initial?.role ?? "GODP");
  const [text, setText] = useState(initial?.roleText ?? "");
  // The register that named a godparent usually said something about them, and
  // a DNA match without its numbers is barely worth recording — so the note is
  // part of naming the associate, not a second trip through the row.
  const [note, setNote] = useState(firstInlineNote(initial) ?? "");

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
      <input
        className="edit-assoc-input edit-assoc-note-input"
        value={note}
        placeholder={t("assoc.notePlaceholder")}
        onChange={(e) => setNote(e.target.value)}
        aria-label={t("assoc.noteLabel")}
      />
      <button
        type="button"
        className="edit-assoc-action"
        onClick={() => onSave(role, text.trim() || undefined, note.trim() || undefined)}
      >
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
  removeTitle,
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
  /** What the ✕ says it removes the person from. Defaults to the event, since
   *  that is where most associations sit; a record-level row says so instead. */
  removeTitle?: string;
}) {
  const api = useAssoc();
  const [picked, setPicked] = useState<{ targetId?: string; name?: string } | null>(null);

  const close = () => {
    setPicked(null);
    onDonePicking();
  };

  return (
    <>
      {associations.map((assoc, i) => (
        // The event rows' own rule, applied to the associate: a note longer
        // than a chip takes a line of its own under them, a one-liner reads on
        // after the role. Inline, a sentence-long note left the name a column
        // one character wide.
        <span
          key={i}
          className={"edit-event-assoc" + (isTallNoteList(assoc.noteRefs ?? []) ? " edit-event-assoc--tall" : "")}
        >
          {isVoidAssociation(assoc) || !api ? (
            // Named, but recorded as nobody: there is no record to open, and
            // dressing the text up as a link would promise one.
            <span className="edit-assoc-name-only" title={t("assoc.nameOnlyTip")}>
              {assoc.name || assoc.targetId}
            </span>
          ) : (
            <RecordLink
              dataset={api.dataset}
              id={assoc.targetId}
              fallback={assoc.name || assoc.targetId}
              onNavigate={api.navigate}
            />
          )}
          {api && container ? (
            <AssociateChip
              assoc={assoc}
              api={api}
              ownerId={ownerId}
              container={container}
              t={t}
              moveTargets={moveTargets}
              removeTitle={removeTitle}
            />
          ) : (
            // The merge's read-only rows have nothing to edit.
            <span className="edit-assoc-role">{roleLabel(assoc, t, sexOfTarget(api, assoc))}</span>
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
          onSave={(role, roleText, note) => {
            api.add(ownerId, container, { targetId: picked.targetId, name: picked.name, role, roleText, note });
            close();
          }}
        />
      )}
    </>
  );
}
