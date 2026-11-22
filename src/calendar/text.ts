// The family calendar's words: month and weekday names, dates, the family-
// history sentences and the day-list lines. Pure — the caller hands in the
// translator, the language and how to name a person.

import type { Translate } from "../locales/i18n";
import type { GedDate, Sex } from "../gedcom/types";
import type { DayEntry, Fact } from "./model";

export interface PersonWords {
  /** The display name. */
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

/** Monday-first short weekday names. 1 January 2001 was a Monday. */
export function weekdayNames(lang: string): string[] {
  const f = new Intl.DateTimeFormat(lang, { weekday: "short", timeZone: "UTC" });
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

export const ENTRY_GLYPH: Record<DayEntry["kind"], string> = { birthday: "*", anniversary: "⚭", memorial: "†" };

/** How a day cell names people: the given name, with the surname's initial, or in full. */
export type CellNames = "given" | "initial" | "full";
export const CELL_NAMES: CellNames[] = ["given", "initial", "full"];

export interface EntryOptions {
  names: CellNames;
  /** Show the age turned, the years married or the years since the death. */
  age: boolean;
  /** Large print, for an older reader: the given name with the kinship —
   *  "Tim (great-grandson)" — and no number. */
  large?: boolean;
}

function cellName(words: PersonWords, id: string, style: CellNames): string {
  if (style === "full") return words.name(id);
  const given = words.given(id);
  const surname = style === "initial" ? words.surname(id) : undefined;
  return surname ? `${given} ${surname.charAt(0).toLocaleUpperCase()}.` : given;
}

/** The short form for a day cell: the names as chosen, the number after. */
export function entryCell(t: Translate, words: PersonWords, e: DayEntry, opts: EntryOptions): string {
  if (opts.large) {
    if (e.ids.length === 2) return t("calendar.couple", { a: words.given(e.ids[0]), b: words.given(e.ids[1]) });
    const k = words.kinship(e.ids[0]);
    return k ? `${words.given(e.ids[0])} (${lowerFirst(k)})` : words.given(e.ids[0]);
  }
  const [a, b] = e.ids.map((id) => cellName(words, id, opts.names));
  const names = e.ids.length === 2 ? t("calendar.couple", { a, b }) : a;
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
  const years = opts.age && e.years !== undefined ? ` (${e.years})` : "";
  return `${e.ids.length === 1 ? nameAndKinship(words, e.ids[0]) : name}${years}`;
}
