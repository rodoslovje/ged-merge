import type { ExternalId, Family, GedEvent, Individual, NameTranslation, NegativeAssertion, NoteRef, PersonName, Sex } from "../gedcom/types";
import type { FieldChoice } from "../review/types";
import { orderedEventTags } from "../review/fields";
import { BIRTH_TAGS, DEATH_TAGS } from "../gedcom/lifespan";

const LIFESPAN_TAGS: readonly string[] = [...BIRTH_TAGS, ...DEATH_TAGS];

/**
 * The person as a relative's card shows them once the save has merged a
 * confirmed match, so the card agrees with the person's own page: the name and
 * sex the save writes, and the birth/death events (with their christening/
 * burial fallbacks) carrying the dates it writes. Returns `main` itself when
 * nothing on the card changes.
 */
export function personCardPreview(main: Individual, incoming: Individual, choiceOf: ChoiceOf): Individual {
  let out = main;
  const events = lifespanEventsPreview(main, incoming, choiceOf);
  if (events) out = { ...out, events };
  const names = namesPreview(main, incoming, choiceOf);
  if (names) out = { ...out, names };
  if (choiceOf("sex") && incoming.sex !== main.sex) out = { ...out, sex: incoming.sex };
  return out;
}

function lifespanEventsPreview(main: Individual, incoming: Individual, choiceOf: ChoiceOf): GedEvent[] | undefined {
  let events: GedEvent[] | undefined;
  const byTag = (ind: Individual, tag: string) => ind.events.filter((e) => e.tag === tag);
  for (const inst of orderedEventTags(main, incoming)) {
    if (!LIFESPAN_TAGS.includes(inst.tag) || inst.compareIdx < 0) continue;
    const keyBase = inst.multi ? `${inst.tag}.${inst.keyIdx}` : inst.tag;
    if (!choiceOf(`${keyBase}.date`)) continue;
    const incEv = byTag(incoming, inst.tag)[inst.compareIdx];
    if (!incEv?.date) continue;
    events ??= [...main.events];
    const mainEv = inst.mainIdx >= 0 ? byTag(main, inst.tag)[inst.mainIdx] : undefined;
    const at = mainEv ? events.indexOf(mainEv) : -1;
    if (at >= 0) events[at] = { ...events[at], date: incEv.date };
    else events.push(incEv);
  }
  return events;
}

/** The names the save leaves on the person, mirroring `applyNamePart` (a part
 *  taken rewrites only that part of the primary name; "both" adds the incoming
 *  name beside it) and the additional-names row ("both" keeps the person's own
 *  beside the incoming ones, anything else replaces them). */
function namesPreview(main: Individual, incoming: Individual, choiceOf: ChoiceOf): PersonName[] | undefined {
  const same = (a: PersonName, b: PersonName) => a.full.trim() === b.full.trim();
  let primary: PersonName | undefined = main.names[0];
  let extras = main.names.slice(1);
  let changed = false;
  const extraChoice = choiceOf("additionalNames");
  if (extraChoice && incoming.names.length > 1) {
    const incExtras = incoming.names.slice(1);
    extras = extraChoice === "both" ? [...extras, ...incExtras.filter((n) => !extras.some((e) => same(e, n)))] : incExtras;
    changed = true;
  }
  const inc = incoming.names[0];
  let partTaken = false;
  for (const part of ["given", "surname"] as const) {
    const choice = choiceOf(part);
    if (!choice || !inc) continue;
    if (choice === "both") {
      if (![primary, ...extras].some((n) => n && same(n, inc))) {
        extras = [inc, ...extras];
        changed = true;
      }
    } else if (inc[part]) {
      primary = { ...(primary ?? { full: "" }), [part]: inc[part] };
      partTaken = changed = true;
    }
  }
  if (partTaken && primary) {
    const full = [primary.prefix, primary.given, primary.surname, primary.suffix].filter(Boolean).join(" ");
    primary = { ...primary, full };
  }
  if (!changed) return undefined;
  return primary ? [primary, ...extras] : extras;
}

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
