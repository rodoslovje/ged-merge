// English narrative grammar (see lang/types.ts for the contract).

import type { GedDate, Sex } from "../../gedcom/types";
import type { NarrativeLang } from "./types";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** The bare date core, no preposition: "5 May 1848" / "May 1848" / "1848". */
function core(day?: number, month?: number, year?: number): string {
  const monthName = month ? MONTHS[month - 1] : undefined;
  return [day, monthName, year].filter((p) => p !== undefined).join(" ");
}

function datePhrase(d: GedDate): string {
  if (d.placeholder) return "";
  const c = core(d.day, d.month, d.year);
  if (!c) return d.raw; // unparseable — keep the recorded text
  const c2 = core(d.day2, d.month2, d.year2);
  switch (d.qualifier) {
    case "about":
      return `about ${c}`;
    case "before":
      return `before ${c}`;
    case "after":
      return `after ${c}`;
    case "between":
      return c2 ? `between ${c} and ${c2}` : `about ${c}`;
    case "from":
      return `from ${c}`;
    case "to":
      return `until ${c}`;
    case "range":
      return c2 ? `from ${c} to ${c2}` : `from ${c}`;
    default:
      // exact / interpreted / unknown-qualifier: a full date reads "on …",
      // anything coarser "in …".
      return d.day && d.month ? `on ${c}` : `in ${c}`;
  }
}

const PRONOUNS: Record<Sex, string> = { M: "He", F: "She", U: "" };

export const narrativeEn: NarrativeLang = {
  lang: "en",
  datePhrase,
  placePhrase: (addr, place) => (addr ? `at ${[addr, place].filter(Boolean).join(", ")}` : `in ${place}`),
  pronoun: (sex) => PRONOUNS[sex],
  nameList: (names) =>
    names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`,
  childCount: (n) => (n === 1 ? "one child" : `${n} children`),
};
