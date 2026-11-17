// Historical events for the Timeline: a short built-in list of the wars,
// reforms, epidemics and migrations that shaped the people on the chart, each
// tagged with the countries it belongs to. Which ones a chart shows follows the
// people on it — a family that lived in Carniola gets the Illyrian Provinces and
// the Franciscan cadastre, one that lived in Ohio the Civil War and Ellis
// Island — so the list never turns into a world almanac.
//
// Pure data + selection; the labels live in the locales (`history.<id>`).

import type { Dataset } from "../gedcom/types";
import { placeCountryFacet } from "../geo/placeCountry";

export interface HistoryEvent {
  /** Locale key suffix: `history.<id>`. */
  id: string;
  from: number;
  /** Last year of a span; absent for a single year. */
  to?: number;
  /** ISO codes (lower case) of the countries it belongs to, or "world" for
   *  an event that touched everyone's ancestors. */
  where: "world" | readonly string[];
}

/** The Habsburg lands as the files write them today. */
const HABSBURG = ["at", "si", "hr", "cz", "sk", "hu"] as const;
/** The countries that made up Yugoslavia. */
const YUGOSLAVIA = ["si", "hr", "rs", "ba", "me", "mk", "xk"] as const;
/** Europe, for the continent-wide turning points. */
const EUROPE = [
  "al", "ad", "at", "by", "be", "ba", "bg", "hr", "cz", "dk", "ee", "fi", "fr", "de", "gr", "hu", "is", "ie",
  "it", "xk", "lv", "li", "lt", "lu", "mt", "md", "mc", "me", "nl", "mk", "no", "pl", "pt", "ro", "ru", "sm",
  "rs", "sk", "si", "es", "se", "ch", "ua", "gb", "va",
] as const;

/** Year order. Kept short on purpose: an event earns its place by explaining
 *  the records (a census, a register reform) or the people's moves (a famine,
 *  an emigration wave, a border), not by being famous. */
export const HISTORY_EVENTS: readonly HistoryEvent[] = [
  { id: "thirtyYearsWar", from: 1618, to: 1648, where: ["de", "at", "cz", "sk"] },
  { id: "viennaSiege", from: 1683, where: HABSBURG },
  { id: "habsburgCensus", from: 1754, where: HABSBURG },
  { id: "houseNumbers", from: 1770, where: HABSBURG },
  { id: "usRevolution", from: 1775, to: 1783, where: ["us"] },
  { id: "serfdom", from: 1781, where: HABSBURG },
  { id: "josephRegisters", from: 1784, where: HABSBURG },
  { id: "firstFleet", from: 1788, where: ["au"] },
  { id: "frenchRevolution", from: 1789, where: EUROPE },
  { id: "usCensus", from: 1790, where: ["us"] },
  { id: "frCivilRegistration", from: 1792, where: ["fr", "be"] },
  { id: "polandPartition", from: 1795, where: ["pl", "lt"] },
  { id: "hreEnd", from: 1806, where: ["de", "at"] },
  { id: "illyria", from: 1809, to: 1813, where: ["si", "hr"] },
  { id: "napoleonEnd", from: 1815, where: EUROPE },
  { id: "noSummer", from: 1816, to: 1817, where: [...EUROPE, "us", "ca"] },
  { id: "franciscanCadastre", from: 1817, where: HABSBURG },
  { id: "gbCivilRegistration", from: 1837, where: ["gb"] },
  { id: "irishFamine", from: 1845, to: 1852, where: ["ie", "gb"] },
  { id: "revolutions1848", from: 1848, where: EUROPE },
  { id: "goldRush", from: 1848, to: 1855, where: ["us"] },
  { id: "auGoldRush", from: 1851, where: ["au"] },
  { id: "southernRailway", from: 1857, where: ["si", "at"] },
  { id: "italyUnified", from: 1861, where: ["it"] },
  { id: "usCivilWar", from: 1861, to: 1865, where: ["us"] },
  { id: "homestead", from: 1862, where: ["us"] },
  { id: "austriaHungary", from: 1867, where: HABSBURG },
  { id: "canadaConfederation", from: 1867, where: ["ca"] },
  { id: "francoPrussian", from: 1870, to: 1871, where: ["fr", "de"] },
  { id: "germanEmpire", from: 1871, where: ["de"] },
  { id: "deCivilRegistration", from: 1876, where: ["de"] },
  { id: "emigration", from: 1880, to: 1914, where: [...HABSBURG, "it", "pl"] },
  { id: "ellisIsland", from: 1892, where: ["us"] },
  { id: "ljubljanaQuake", from: 1895, where: ["si"] },
  { id: "auFederation", from: 1901, where: ["au"] },
  { id: "ww1", from: 1914, to: 1918, where: "world" },
  { id: "isonzo", from: 1915, to: 1917, where: ["si", "it"] },
  { id: "spanishFlu", from: 1918, to: 1920, where: "world" },
  { id: "habsburgEnd", from: 1918, where: ["at", "cz", "sk", "hu", "pl", "ua"] },
  { id: "scs", from: 1918, where: YUGOSLAVIA },
  { id: "rapallo", from: 1920, where: ["si", "it", "hr"] },
  { id: "carinthia", from: 1920, where: ["si", "at"] },
  { id: "irishFreeState", from: 1922, where: ["ie"] },
  { id: "fascism", from: 1922, where: ["it"] },
  { id: "usImmigrationAct", from: 1924, where: ["us"] },
  { id: "depression", from: 1929, to: 1939, where: "world" },
  { id: "nazis", from: 1933, where: ["de", "at"] },
  { id: "anschluss", from: 1938, where: ["at"] },
  { id: "ww2", from: 1939, to: 1945, where: "world" },
  { id: "fprYugoslavia", from: 1945, where: YUGOSLAVIA },
  { id: "parisTreaty", from: 1947, where: ["si", "it", "hr"] },
  { id: "germanySplit", from: 1949, where: ["de"] },
  { id: "hungary1956", from: 1956, where: ["hu"] },
  { id: "pragueSpring", from: 1968, where: ["cz", "sk"] },
  { id: "berlinWall", from: 1989, where: ["de"] },
  { id: "yugoslaviaEnd", from: 1991, where: YUGOSLAVIA },
];

/** One person on the chart: where they lived, and when. */
export interface HistoryPresence {
  countries: ReadonlySet<string>;
  from: number;
  to: number;
}

/**
 * Where and when the given people lived: every ISO country their events'
 * places name, over their bar's years. A place that names no country — the
 * genealogist's own village, written bare — stands in the file's home country
 * when there is one. People with no dated bar say nothing about *when*, and
 * are left out.
 */
export function historyPresence(
  ds: Dataset,
  people: readonly { id: string; from?: number; to?: number }[],
  homeCountry: string,
): HistoryPresence[] {
  const out: HistoryPresence[] = [];
  for (const p of people) {
    if (p.from === undefined || p.to === undefined) continue;
    const indi = ds.individuals.get(p.id);
    if (!indi) continue;
    const countries = new Set<string>();
    let silent = false;
    for (const e of indi.events) {
      const raw = e.place?.raw.trim();
      if (!raw) continue;
      const facet = placeCountryFacet(raw);
      if (/^[a-z]{2}$/.test(facet)) countries.add(facet);
      else if (!facet) silent = true;
    }
    // No place at all says as little as a bare village: both stand at home.
    if (homeCountry && (silent || countries.size === 0)) countries.add(homeCountry);
    out.push({ countries, from: p.from, to: p.to });
  }
  return out;
}

/**
 * The events a chart over `[minYear, maxYear]` shows: the world-wide ones in
 * range, and each country's own while somebody on the chart lived there.
 */
export function pickHistoryEvents(
  presence: readonly HistoryPresence[],
  minYear: number,
  maxYear: number,
  events: readonly HistoryEvent[] = HISTORY_EVENTS,
): HistoryEvent[] {
  return events.filter((e) => {
    const end = e.to ?? e.from;
    if (end < minYear || e.from > maxYear) return false;
    if (e.where === "world") return true;
    const where = e.where;
    return presence.some((p) => p.from <= end && p.to >= e.from && where.some((c) => p.countries.has(c)));
  });
}

/** "1914–18", "1789–1815", "1848" — the years as the label leads with them. */
export function historyYears(e: HistoryEvent): string {
  if (e.to === undefined || e.to === e.from) return String(e.from);
  const sameCentury = Math.floor(e.from / 100) === Math.floor(e.to / 100);
  return `${e.from}–${sameCentury ? String(e.to).slice(2) : e.to}`;
}
