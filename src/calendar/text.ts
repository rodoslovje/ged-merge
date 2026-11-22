// The family calendar's words: month and weekday names, dates, the family-
// history sentences and the day-list lines. Pure — the caller hands in the
// translator, the language and how to name a person.

import type { Translate } from "../locales/i18n";
import type { GedDate, Sex } from "../gedcom/types";
import type { DayEntry, Fact } from "./model";

export interface PersonWords {
  /** The display name. */
  name: (id: string) => string;
  /** The given name alone, for the crowded day cells. */
  given: (id: string) => string;
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

/** The short form for a day cell: given names, the number after. */
export function entryCell(t: Translate, words: PersonWords, e: DayEntry): string {
  const names = e.ids.length === 2 ? t("calendar.couple", { a: words.given(e.ids[0]), b: words.given(e.ids[1]) }) : words.given(e.ids[0]);
  return e.years !== undefined ? `${names} ${e.years}` : names;
}

/** The full line under the grid: day, full names, kinship, the number. */
export function entryLine(t: Translate, words: PersonWords, e: DayEntry): string {
  const name =
    e.ids.length === 2
      ? t("calendar.couple", { a: words.name(e.ids[0]), b: words.name(e.ids[1]) })
      : words.name(e.ids[0]);
  const k = e.ids.length === 1 ? words.kinship(e.ids[0]) : undefined;
  const years = e.years !== undefined ? ` (${e.years})` : "";
  return `${k ? `${name}, ${lowerFirst(k)}` : name}${years}`;
}
