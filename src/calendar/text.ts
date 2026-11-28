// The family calendar's words: month and weekday names, dates, the family-
// history sentences and the day-list lines. Pure — the caller hands in the
// translator, the language and how to name a person.

import type { Translate } from "../locales/i18n";
import type { GedDate, Sex } from "../gedcom/types";
import type { DayEntry, Fact } from "./model";

export interface PersonWords {
  /** The display name — for a living person, as much of it as the calendar's
   *  {@link LivingNames} choice keeps. */
  name: (id: string) => string;
  /** The first given name alone, for the crowded day cells. */
  given: (id: string) => string;
  /** The surname, when the name has one. */
  surname: (id: string) => string | undefined;
  /** The kinship to the recipient ("Aunt"), none for the recipient themselves. */
  kinship: (id: string) => string | undefined;
  sex: (id: string) => Sex | undefined;
}

const capitalize = (s: string) => s.charAt(0).toLocaleUpperCase() + s.slice(1);
const lowerFirst = (s: string) => s.charAt(0).toLocaleLowerCase() + s.slice(1);

/** "January" … in the language, standalone (the nominative). */
export function monthName(lang: string, month: number): string {
  return capitalize(new Intl.DateTimeFormat(lang, { month: "long", timeZone: "UTC" }).format(Date.UTC(2001, month - 1, 1)));
}

/** Monday-first weekday names, in full. 1 January 2001 was a Monday. */
export function weekdayNames(lang: string): string[] {
  const f = new Intl.DateTimeFormat(lang, { weekday: "long", timeZone: "UTC" });
  return Array.from({ length: 7 }, (_, i) => capitalize(f.format(Date.UTC(2001, 0, 1 + i))));
}

/** A fact's date: the day when known, else the month and year. */
export function factDate(t: Translate, lang: string, date: GedDate): string {
  const month = date.month!;
  const vars = { day: date.day, month, monthName: monthName(lang, month), year: date.year };
  return date.day !== undefined ? t("calendar.date", vars) : t("calendar.dateMonth", vars);
}

const ctx = (sex: Sex | undefined) => (sex === "M" || sex === "F" ? sex : undefined);

/** "Great-grandfather Jože Novak" — the kinship word first, as a family says it. */
function who(words: PersonWords, id: string): string {
  const k = words.kinship(id);
  return k ? `${lowerFirst(k)} ${words.name(id)}` : words.name(id);
}

/** One moment from the family's past, as a sentence. */
export function factSentence(t: Translate, words: PersonWords, fact: Fact): string {
  const [a, b] = fact.ids;
  const body =
    fact.kind === "marriage"
      ? t("calendar.fact.marriage", { a: who(words, a), b: who(words, b) })
      : t(`calendar.fact.${fact.kind}`, { who: who(words, a), context: ctx(words.sex(a)) });
  const text = capitalize(body);
  return fact.place ? `${text} (${fact.place}).` : `${text}.`;
}

export function yearsAgo(t: Translate, n: number): string {
  return t("calendar.yearsAgo", { count: n });
}

/** A round birthday's or a jubilee's mark. */
export const ROUND_GLYPH = "★";

/** A name day's mark. */
export const NAME_DAY_GLYPH = "✿";

/** The mark before an entry. A plain birthday carries none: it is what a name
 *  on a day means unless a mark says otherwise. */
export function entryGlyph(e: DayEntry, round: boolean): string | undefined {
  if (round) return ROUND_GLYPH;
  return e.kind === "anniversary" ? "⚭" : e.kind === "memorial" ? "†" : e.kind === "nameday" ? NAME_DAY_GLYPH : undefined;
}

/** How the calendar names the living — on the day cells, in the lines, the
 *  captions and its charts: the initials, the given name, the given name with
 *  the surname's initial, or in full. The charts' privacy choices, plus the
 *  calendar's own "Ana N.". */
export type LivingNames = "initials" | "given" | "initial" | "full";
export const LIVING_NAMES: LivingNames[] = ["initials", "given", "initial", "full"];

export interface EntryOptions {
  names: LivingNames;
  /** Show the age turned and the years married. */
  age: boolean;
  /** Large print, for an older reader: the given name with the kinship —
   *  "Tim (great-grandson)" — and no number. */
  large?: boolean;
}

/** A name on a day cell. The living go by the choice — `words.name` already
 *  carries it, the cell only shortens the given name to the first one; the
 *  dead of a memorial day by their full name. */
function cellName(words: PersonWords, e: DayEntry, id: string, style: LivingNames): string {
  if (e.kind === "memorial" || style === "full" || style === "initials") return words.name(id);
  const given = words.given(id);
  const surname = style === "initial" ? words.surname(id) : undefined;
  return surname ? `${given} ${surname.charAt(0).toLocaleUpperCase()}.` : given;
}

/** The short form for a day cell: the names as chosen, the number after — on
 *  a memorial day always the year of the death. */
export function entryCell(t: Translate, words: PersonWords, e: DayEntry, opts: EntryOptions): string {
  // Large print shortens the living to the given name (the initials, when
  // that is the choice); a memorial day keeps its full name and year.
  if (opts.large && e.kind !== "memorial") {
    const short = (id: string) => (opts.names === "initials" ? words.name(id) : words.given(id));
    if (e.ids.length === 2) return t("calendar.couple", { a: short(e.ids[0]), b: short(e.ids[1]) });
    const k = words.kinship(e.ids[0]);
    return k ? `${short(e.ids[0])} (${lowerFirst(k)})` : short(e.ids[0]);
  }
  const [a, b] = e.ids.map((id) => cellName(words, e, id, opts.names));
  const names = e.ids.length === 2 ? t("calendar.couple", { a, b }) : a;
  if (e.kind === "memorial") return e.deathYear !== undefined ? `${names} ${e.deathYear}` : names;
  return opts.age && e.years !== undefined ? `${names} ${e.years}` : names;
}

/** "Tim Novak, great-grandson" — the name, then the kinship to the recipient. */
export function nameAndKinship(words: PersonWords, id: string): string {
  const k = words.kinship(id);
  return k ? `${words.name(id)}, ${lowerFirst(k)}` : words.name(id);
}

/** The full line under the grid: day, full names, kinship, the number. */
export function entryLine(t: Translate, words: PersonWords, e: DayEntry, opts: EntryOptions): string {
  const name =
    e.ids.length === 2
      ? t("calendar.couple", { a: words.name(e.ids[0]), b: words.name(e.ids[1]) })
      : words.name(e.ids[0]);
  const years =
    e.kind === "memorial"
      ? (e.deathYear !== undefined ? ` (${e.deathYear})` : "")
      : opts.age && e.years !== undefined ? ` (${e.years})` : "";
  return `${e.ids.length === 1 ? nameAndKinship(words, e.ids[0]) : name}${years}`;
}
