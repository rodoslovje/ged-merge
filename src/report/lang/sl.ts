// Slovenian narrative grammar (see lang/types.ts for the contract).
//
// Dates are fully mechanical because months and "leto" are a closed class:
// each case-bearing preposition selects its month/year form —
//   (none, "on/in")  + genitive:      5. maja 1848 · maja 1848 · leta 1848
//   okoli            + genitive:      okoli 5. maja 1848 · okoli leta 1848
//   pred, med        + instrumental:  pred 5. majem 1848 · med letoma 1848 in 1850
//   po               + locative:      po 5. maju 1848 · po letu 1848
//   od, do           + genitive:      od maja 1848 · do leta 1850
// Open-class words (places, names) are never declined — see lang/types.ts.

import type { GedDate } from "../../gedcom/types";
import type { NarrativeLang } from "./types";

const GEN = [
  "januarja", "februarja", "marca", "aprila", "maja", "junija",
  "julija", "avgusta", "septembra", "oktobra", "novembra", "decembra",
];
const INS = [
  "januarjem", "februarjem", "marcem", "aprilom", "majem", "junijem",
  "julijem", "avgustom", "septembrom", "oktobrom", "novembrom", "decembrom",
];
const LOC = [
  "januarju", "februarju", "marcu", "aprilu", "maju", "juniju",
  "juliju", "avgustu", "septembru", "oktobru", "novembru", "decembru",
];

type Case = { months: string[]; year: string };
const GENITIVE: Case = { months: GEN, year: "leta" };
const INSTRUMENTAL: Case = { months: INS, year: "letom" };
const LOCATIVE: Case = { months: LOC, year: "letu" };

/** The date core in the given case: "5. maja 1848" / "maja 1848" / "leta 1848". */
function core(kase: Case, day?: number, month?: number, year?: number): string {
  if (month) return [day !== undefined ? `${day}.` : undefined, kase.months[month - 1], year].filter(Boolean).join(" ");
  return year !== undefined ? `${kase.year} ${year}` : "";
}

function datePhrase(d: GedDate): string {
  if (d.placeholder) return "";
  if (!core(GENITIVE, d.day, d.month, d.year)) return d.raw; // unparseable — keep the recorded text
  switch (d.qualifier) {
    case "about":
      return `okoli ${core(GENITIVE, d.day, d.month, d.year)}`;
    case "before":
      return `pred ${core(INSTRUMENTAL, d.day, d.month, d.year)}`;
    case "after":
      return `po ${core(LOCATIVE, d.day, d.month, d.year)}`;
    case "between": {
      if (d.year2 === undefined && d.month2 === undefined) return `okoli ${core(GENITIVE, d.day, d.month, d.year)}`;
      // Two bare years take the elegant dual: "med letoma 1848 in 1850".
      if (!d.month && !d.month2 && d.year !== undefined && d.year2 !== undefined) {
        return `med letoma ${d.year} in ${d.year2}`;
      }
      return `med ${core(INSTRUMENTAL, d.day, d.month, d.year)} in ${core(INSTRUMENTAL, d.day2, d.month2, d.year2)}`;
    }
    case "from":
      return `od ${core(GENITIVE, d.day, d.month, d.year)}`;
    case "to":
      return `do ${core(GENITIVE, d.day, d.month, d.year)}`;
    case "range": {
      const from = `od ${core(GENITIVE, d.day, d.month, d.year)}`;
      const to = core(GENITIVE, d.day2, d.month2, d.year2);
      return to ? `${from} do ${to}` : from;
    }
    default:
      // exact / interpreted / unknown-qualifier.
      return core(GENITIVE, d.day, d.month, d.year);
  }
}

/** Accusative after "imeti": 1/101 otroka (sg), 2 otroka (dual), 3–4 otroke,
 *  5+ otrok (genitive) — Intl.PluralRules("sl") encodes exactly this split. */
const PLURALS = new Intl.PluralRules("sl");
function childCount(n: number): string {
  const form = PLURALS.select(n);
  return `${n} ${form === "few" ? "otroke" : form === "other" ? "otrok" : "otroka"}`;
}

export const narrativeSl: NarrativeLang = {
  lang: "sl",
  datePhrase,
  // Nominative-safe frames — place names are never declined. An address reads
  // postal-style ("na naslovu Dunajska 5, Kranj"), a bare place gets "v kraju".
  placePhrase: (addr, place) =>
    addr ? `na naslovu ${[addr, place].filter(Boolean).join(", ")}` : `v kraju ${place}`,
  // Slovenian verb forms carry the subject; repeat sentences start verb-first
  // ("Rodil se je …"), so there is no pronoun word to emit.
  pronoun: () => "",
  nameList: (names) =>
    names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} in ${names[names.length - 1]}`,
  childCount,
};
