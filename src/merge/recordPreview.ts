import type { ExternalId, Family, Individual, NameTranslation, NegativeAssertion, NoteRef, Sex } from "../gedcom/types";
import type { FieldChoice } from "../review/types";

/**
 * What a confirmed match's record-level rows will write into a record (a
 * person's or a family's), for Edit to show in place before the save. Each
 * entry mirrors its `apply…` function in `applyFields.ts`: the values the save
 * adds, and whether the record's own values give way to them.
 */
export interface RecordMergePreview {
  /** Notes the save writes; `replaces` — the record's own notes go. */
  notes?: { notes: NoteRef[]; replaces: boolean };
  /** The record becomes private (additive — a flag is never removed). */
  private?: boolean;
  /** "Did not happen" statements the save adds (additive). */
  noEvents?: NegativeAssertion[];
}

export interface PersonMergePreview extends RecordMergePreview {
  /** The incoming sex, replacing the person's. */
  sex?: Sex;
  /** The incoming nickname, replacing the person's. */
  nickname?: string;
  /** Translations of the primary name the save adds (additive). */
  translations?: NameTranslation[];
  /** FamilySearch ids the save adds; `replacesFirst` — the first one it
   *  writes takes the place of the person's first id. */
  fsids?: { ids: string[]; replacesFirst: boolean };
  /** Other external ids the save adds (additive). */
  exids?: ExternalId[];
}

/** A row's choice, or undefined when the row writes nothing (it agrees, only
 *  the main has it, or the reviewer kept the main's value). */
type ChoiceOf = (field: string) => FieldChoice | undefined;

function previewShared(main: Individual | Family, incoming: Individual | Family, choiceOf: ChoiceOf): RecordMergePreview {
  const out: RecordMergePreview = {};
  const notesChoice = choiceOf("notes");
  if (notesChoice) {
    const ownTexts = (main.noteRefs ?? []).map((n) => n.text.trim()).filter(Boolean);
    const kept = new Set(notesChoice === "both" ? ownTexts : []);
    const notes = (incoming.noteRefs ?? []).filter((n) => n.text.trim() && !kept.has(n.text.trim()));
    if (notes.length) out.notes = { notes, replaces: notesChoice !== "both" && ownTexts.length > 0 };
  }
  if (choiceOf("private") && incoming.private && !main.private) out.private = true;
  if (choiceOf("noEvents")) {
    const have = new Set((main.noEvents ?? []).map((a) => a.tag));
    const added = (incoming.noEvents ?? []).filter((a) => !have.has(a.tag));
    if (added.length) out.noEvents = added;
  }
  return out;
}

/** {@link RecordMergePreview} for a family's own rows. */
export function familyMergePreview(main: Family, incoming: Family, choiceOf: ChoiceOf): RecordMergePreview {
  return previewShared(main, incoming, choiceOf);
}

/** {@link PersonMergePreview} for a person's own rows. */
export function personMergePreview(main: Individual, incoming: Individual, choiceOf: ChoiceOf): PersonMergePreview {
  const out: PersonMergePreview = previewShared(main, incoming, choiceOf);
  if (choiceOf("sex") && incoming.sex !== main.sex) out.sex = incoming.sex;
  const incNick = incoming.names[0]?.nickname?.trim();
  if (choiceOf("nickname") && incNick && incNick !== main.names[0]?.nickname?.trim()) out.nickname = incNick;
  if (choiceOf("nameTranslations")) {
    const have = new Set((main.names[0]?.translations ?? []).map((tr) => tr.full.trim()));
    const added = (incoming.names[0]?.translations ?? []).filter((tr) => tr.full.trim() && !have.has(tr.full.trim()));
    if (added.length) out.translations = added;
  }
  const fsChoice = choiceOf("fsid");
  if (fsChoice) {
    const own = main.fsids ?? [];
    const have = new Set(own.map((id) => id.toUpperCase()));
    const ids = [...new Set((incoming.fsids ?? []).map((id) => id.trim().toUpperCase()))].filter((id) => id && !have.has(id));
    if (ids.length) out.fsids = { ids, replacesFirst: fsChoice !== "both" && own.length > 0 };
  }
  if (choiceOf("exid")) {
    const key = (x: ExternalId) => `${x.type ?? ""}|${x.id}`;
    const have = new Set((main.exids ?? []).map(key));
    const added = (incoming.exids ?? []).filter((x) => !have.has(key(x)));
    if (added.length) out.exids = added;
  }
  return out;
}
