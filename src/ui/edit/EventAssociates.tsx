import { useEffect, useRef, useState } from "react";
import type { Association, AssocRole, Dataset, GedNode, Sex } from "../../gedcom/types";
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

/** Sentinel menu value for the one entry that is neither a role nor a move. */
const REMOVE_OPTION = "__remove_assoc__";
/** Move targets are numbered; this tells their values from the sentinels. */
const MOVE_PREFIX = "move:";

/**
 * One associate as the row shows them: who they were, in what role, and what
 * the record said about them.
 *
 * Edited in place, the way an event's fields are — the role is a field that
 * looks like the words it holds until the pointer reaches it, the note is its
 * own box, and the menu beside the role carries only what typing cannot do: the
 * vocabulary, a move to one of the record's events, and taking the person off
 * the record. There is no edit button, because there is nothing an edit button
 * would open that is not already here.
 */
function AssociateChip({
  assoc,
  api,
  ownerId,
  container,
  t,
  moveTargets,
  removeTitle,
  fresh,
}: {
  assoc: Association;
  api: AssocApi;
  ownerId: string;
  container: GedNode;
  t: Translate;
  moveTargets?: { node: GedNode; label: string }[];
  removeTitle?: string;
  /** Just written: the row opens with the caret in the role and a note waiting,
   *  since naming somebody, saying in what role and saying what the record said
   *  about them is one thought. */
  fresh?: boolean;
}) {
  const sex = sexOfTarget(api, assoc);
  const shown = roleLabel(assoc, t, sex);
  const [role, setRole] = useState(shown);
  /** Opens a fresh, empty note on this row — the event rows' own trigger. Also
   *  counts the box a just-written row opens by itself, so the offer below does
   *  not stand beside an empty box offering a second one. */
  const [noteAdd, setNoteAdd] = useState(fresh ? 1 : 0);
  const roleRef = useRef<HTMLInputElement>(null);

  /** The vocabulary's word for a role, in the associate's own gender. */
  const roleWord = (r: AssocRole) => t(`assoc.role.${r}`, { context: sex === "M" || sex === "F" ? sex : undefined });

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
        ref={roleRef}
        className="edit-input edit-assoc-role edit-assoc-role-field"
        value={role}
        size={Math.max(6, role.length)}
        aria-label={t("assoc.roleLabel")}
        placeholder={t("assoc.roleTextPlaceholder")}
        // Not focused on arrival, though it is the first field here: the empty
        // note beside it is, because the role already holds a sensible word and
        // the note holds nothing. Shift+Tab reaches it from there.
        onFocus={(e) => fresh && e.currentTarget.select()}
        onChange={(e) => setRole(e.target.value)}
        onBlur={() => {
          const text = role.trim();
          if (text === shown) return; // untouched: the file keeps its own words
          if (text) {
            // Typed over: the words are kept verbatim, and the role reads as
            // whichever of the vocabulary they name — OTHER when none.
            commit(roleFromRela(text), text);
          } else {
            // Left empty — including the empty box "other" opens. The file keeps
            // the role it was read as, and the row says it in the app's words
            // rather than standing blank.
            commit(assoc.role, undefined);
            setRole(roleWord(assoc.role));
          }
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
          // No note entry here: the row itself offers the box (see below), and a
          // menu is no place to look for something the row already shows.
          { items: [{ value: REMOVE_OPTION, label: removeTitle ?? t("assoc.remove") }] },
        ]}
        onSelect={(v) => {
          if (v === REMOVE_OPTION) api.remove(ownerId, container, assoc.raw);
          else if (v.startsWith(MOVE_PREFIX) && moveTargets) {
            api.move(ownerId, container, moveTargets[Number(v.slice(MOVE_PREFIX.length))].node, assoc.raw);
          } else if (v === "OTHER") {
            // "Other" is not a role, it is the absence of one in the
            // vocabulary — so picking it asks for the word instead of writing
            // "other" into the file: the box is emptied and handed the caret.
            setRole("");
            commit("OTHER", undefined);
            roleRef.current?.focus();
          } else {
            // A role from the vocabulary replaces wording of the file's own:
            // "botra" and "witness" on one association is two answers.
            setRole(roleWord(v as AssocRole));
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
        addOnMount={fresh}
        addTrigger={noteAdd}
        t={t}
        onCommit={(refs) => api.notes(ownerId, assoc.raw, refs)}
      />
      {/* With no note yet there is no box to click, so the row offers one: it
          comes up with the row like the ▾ does, and clicking hands over to the
          editor above, which opens a real note with the caret in it. */}
      {!assoc.noteRefs?.length && !noteAdd && (
        <button
          type="button"
          className="edit-assoc-note-add"
          title={t("edit.addNoteTooltip")}
          onClick={() => setNoteAdd((n) => n + 1)}
        >
          {t("edit.addNote")}
        </button>
      )}
    </>
  );
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
  /** The associate just written, whose row opens ready to be filled in. */
  const [fresh, setFresh] = useState<number | null>(null);

  // One render's worth: the row mounts with it, takes the caret and opens an
  // empty note, and from then on is an ordinary row. Left standing, it would
  // open a second empty note every time the first one was committed.
  useEffect(() => {
    if (fresh !== null) setFresh(null);
  }, [fresh]);

  /**
   * Picking somebody writes the association there and then, the way adding an
   * event or another name does — no form to fill and confirm. The role it
   * starts with is the one a register names most, and the row it lands in is
   * where it is changed: the caret is already in the role.
   */
  const name = (who: { targetId?: string; name?: string }) => {
    if (!api || !container) return;
    api.add(ownerId, container, { ...who, role: "GODP" });
    setFresh(associations.length);
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
              fresh={i === fresh}
            />
          ) : (
            // The merge's read-only rows have nothing to edit.
            <span className="edit-assoc-role">{roleLabel(assoc, t, sexOfTarget(api, assoc))}</span>
          )}
        </span>
      ))}
      {api && container && picking && (
        <RelativePickerCard
          roleLabel={t("assoc.pickLabel")}
          individuals={api.dataset.individuals}
          excludeId={ownerId}
          onPickExisting={(id) => name({ targetId: id })}
          // In a 7.0 file the extra row records the typed name on the
          // association itself (`@VOID@` + `PHRASE`) rather than minting a
          // person — the godparent is named, not researched. A 5.5.1 file has
          // no such form, so it offers only people the file already holds.
          onAddNew={
            canWriteNameOnly(api.version)
              ? (typed) => (typed.trim() ? name({ name: typed.trim() }) : onDonePicking())
              : undefined
          }
          newLabel={t("assoc.nameOnly")}
          onCancel={onDonePicking}
          t={t}
        />
      )}
    </>
  );
}
