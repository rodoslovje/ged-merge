// Croatian narrative grammar (see lang/types.ts for the contract).
//
// A Croatian date writes ordinals with a dot, the year included: "5. svibnja
// 1848.". Nearly every preposition here takes the genitive —
//   (none, "on")  + genitive:   5. svibnja 1848. · 1848. godine
//   (none, "in")  + locative:   u svibnju 1848.  (a month without a day)
//   oko, prije, nakon, od, do + genitive: oko 1848. godine · prije svibnja 1848.
//   između … i …  + genitive:   između 1848. i 1850. godine
// The year's own dot doubles as a sentence's full stop; polish() in
// narrativeText.ts folds "1848.." to "1848.". Open-class words (places, names)
// are never declined — see lang/types.ts.

import type { GedDate } from "../../gedcom/types";
import { dateText, withPhrase } from "../../gedcom/date";
import type { NarrativeLang } from "./types";

const NOM = [
  "siječanj", "veljača", "ožujak", "travanj", "svibanj", "lipanj",
  "srpanj", "kolovoz", "rujan", "listopad", "studeni", "prosinac",
];
const GEN = [
  "siječnja", "veljače", "ožujka", "travnja", "svibnja", "lipnja",
  "srpnja", "kolovoza", "rujna", "listopada", "studenoga", "prosinca",
];
const LOC = [
  "siječnju", "veljači", "ožujku", "travnju", "svibnju", "lipnju",
  "srpnju", "kolovozu", "rujnu", "listopadu", "studenome", "prosincu",
];

/** A year as written: "1848." — a year counted before the common era is
 *  negative in the model and reads "44. pr. Kr.". */
function yearText(year: number): string {
  return year < 0 ? `${-year}. pr. Kr.` : `${year}.`;
}

/** The genitive core: "5. svibnja 1848." / "svibnja 1848." / "1848. godine". */
function core(day?: number, month?: number, year?: number): string {
  const y = year !== undefined ? yearText(year) : undefined;
  if (month) return [day !== undefined ? `${day}.` : undefined, GEN[month - 1], y].filter(Boolean).join(" ");
  if (year === undefined || y === undefined) return "";
  return year < 0 ? y : `${y} godine`;
}

const JULIAN = " (po julijanskom kalendaru)";

function datePhrase(d: GedDate): string {
  const phrase = plainPhrase(d);
  // A Julian date keeps its components (the app shows the date the file
  // states), so the reader has to be told which calendar it is in.
  return phrase && d.calendar === "JULIAN" ? `${phrase}${JULIAN}` : phrase;
}

/** The label form: an exact date stands as written on a form — "5. svibnja
 *  1848." keeps the genitive, a month alone is nominative ("svibanj 1848.")
 *  and a year is bare; a qualified date reads as its phrase does. */
function dateLabel(d: GedDate): string {
  let label: string;
  if (d.qualifier === "exact" && !d.placeholder && d.year !== undefined && d.day === undefined) {
    label = d.month ? `${NOM[d.month - 1]} ${yearText(d.year)}` : yearText(d.year);
    if (d.phrase) label = withPhrase(label, d.phrase);
  } else {
    label = plainPhrase(d);
  }
  const how = d.approx === "CAL" ? " (izračunato)" : d.approx === "EST" ? " (procijenjeno)" : "";
  if (label && d.qualifier === "about") label += how;
  return label && d.calendar === "JULIAN" ? `${label}${JULIAN}` : label;
}

/** A date as a phrase, with a GEDCOM 7 date's own wording (`PHRASE`) in
 *  brackets after it. */
function plainPhrase(d: GedDate): string {
  const out = valuePhrase(d);
  return d.phrase && out && !out.includes(d.phrase) ? withPhrase(out, d.phrase) : out;
}

function valuePhrase(d: GedDate): string {
  if (d.placeholder) return "";
  const c = core(d.day, d.month, d.year);
  if (!c) return dateText(d); // unparseable — keep the recorded text
  switch (d.qualifier) {
    case "about":
      return `oko ${c}`;
    case "before":
      return `prije ${c}`;
    case "after":
      return `nakon ${c}`;
    case "between": {
      if (d.year2 === undefined && d.month2 === undefined) return `oko ${c}`;
      // Two bare years share one "godine": "između 1848. i 1850. godine".
      if (!d.month && !d.month2 && d.year !== undefined && d.year2 !== undefined && d.year > 0 && d.year2 > 0) {
        return `između ${yearText(d.year)} i ${yearText(d.year2)} godine`;
      }
      return `između ${c} i ${core(d.day2, d.month2, d.year2)}`;
    }
    case "from":
      return `od ${c}`;
    case "to":
      return `do ${c}`;
    case "range": {
      const to = core(d.day2, d.month2, d.year2);
      return to ? `od ${c} do ${to}` : `od ${c}`;
    }
    default:
      // exact / interpreted / unknown-qualifier: a month without a day reads
      // "u svibnju 1848.", anything else the genitive core.
      if (d.month && d.day === undefined && d.year !== undefined) return `u ${LOC[d.month - 1]} ${yearText(d.year)}`;
      return c;
  }
}

/** "{n} children" after "imati": one to four as the collective numerals
 *  ("jedno dijete", "dvoje djece" … "četvero djece"), then "5 djece" — and
 *  "21 dijete", since 21, 31 … agree with the singular. */
const CHILD_WORDS = ["jedno dijete", "dvoje djece", "troje djece", "četvero djece"];
function childCount(n: number): string {
  if (n >= 1 && n <= 4) return CHILD_WORDS[n - 1];
  return `${n} ${n % 10 === 1 && n % 100 !== 11 ? "dijete" : "djece"}`;
}

export const narrativeHr: NarrativeLang = {
  lang: "hr",
  datePhrase,
  dateLabel,
  // Nominative-safe frames — place names are never declined. An address reads
  // postal-style ("na adresi Ilica 5, Zagreb"), a bare place gets "u mjestu".
  placePhrase: (addr, place) =>
    addr ? `na adresi ${[addr, place].filter(Boolean).join(", ")}` : `u mjestu ${place}`,
  // Croatian verb forms carry the subject, as Slovenian ones do.
  pronoun: () => "",
  nameList: (names) =>
    names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} i ${names[names.length - 1]}`,
  childCount,
};
