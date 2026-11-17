/**
 * Who to look for when searching a person elsewhere: the name, a birth-year
 * window and a birth place, read off one Individual — and the prefilled
 * search addresses of the sites that take them in the URL.
 *
 * Pure: no network. The addresses only open in a new tab when the reader
 * clicks one; nothing is sent until then.
 */
import type { Dataset, GedEvent, Individual } from "../gedcom/types";
import { BIRTH_TAGS, DEATH_TAGS, estimateBirthYear, isApproximate } from "../gedcom/lifespan";
import { primaryName } from "../match/relatives";

export interface PersonQuery {
  given: string;
  surname: string;
  /** Birth-year window, when the person has a dated birth or one can be estimated. */
  birthFrom?: number;
  birthTo?: number;
  /** Death-year window — only when no birth window could be set. */
  deathFrom?: number;
  deathTo?: number;
  /** The most specific part of the birth place (the village or town). */
  birthPlace?: string;
}

/** Years either side of a stated birth year: an exact date still differs by a
 *  year or two between a birth and a baptism record, or between two trees. */
const EXACT_SLACK = 2;
/** …and either side of an "about"/range date. */
const APPROX_SLACK = 5;
/** …and either side of a year estimated from relatives. */
const ESTIMATE_SLACK = 15;

function firstDated(indi: Individual, tags: readonly string[]): GedEvent | undefined {
  for (const tag of tags) {
    const e = indi.events.find((ev) => ev.tag === tag && ev.date?.year !== undefined);
    if (e) return e;
  }
  return undefined;
}

function yearWindow(e: GedEvent): [number, number] {
  const year = e.date!.year!;
  const slack = isApproximate(e.date) ? APPROX_SLACK : EXACT_SLACK;
  return [year - slack, year + slack];
}

/** The search for one person, or undefined when they have no surname and no
 *  given name — nothing a search could go on. */
export function personQuery(indi: Individual, ds?: Dataset): PersonQuery | undefined {
  const name = primaryName(indi);
  const given = (name?.given ?? "").trim();
  const surname = (name?.surname ?? "").trim();
  if (!given && !surname) return undefined;
  const q: PersonQuery = { given, surname };
  const birth = firstDated(indi, BIRTH_TAGS);
  if (birth) {
    [q.birthFrom, q.birthTo] = yearWindow(birth);
  } else {
    const death = firstDated(indi, DEATH_TAGS);
    if (death) [q.deathFrom, q.deathTo] = yearWindow(death);
    else if (ds) {
      const est = estimateBirthYear(indi, ds);
      if (est) [q.birthFrom, q.birthTo] = [est.estimatedYear - ESTIMATE_SLACK, est.estimatedYear + ESTIMATE_SLACK];
    }
  }
  const place = BIRTH_TAGS.map((tag) => indi.events.find((e) => e.tag === tag)?.place).find(Boolean);
  const locality = place?.parts[0]?.trim();
  if (locality) q.birthPlace = locality;
  return q;
}

export type SearchSite = "index" | "familysearchTree" | "familysearchRecords" | "geni" | "wikitree";

export const SEARCH_SITES: readonly SearchSite[] = ["index", "familysearchTree", "familysearchRecords", "geni", "wikitree"];

/** The public website of the Slovenian genealogical index. */
export const INDEX_SITE = "https://indeks.rodoslovje.si/";

function withParams(base: string, params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") p.set(k, String(v));
  return `${base}?${p.toString()}`;
}

function familySearch(kind: "tree" | "record", q: PersonQuery): string {
  return withParams(`https://www.familysearch.org/search/${kind}/results`, {
    "q.givenName": q.given,
    "q.surname": q.surname,
    "q.birthLikeDate.from": q.birthFrom,
    "q.birthLikeDate.to": q.birthTo,
    "q.deathLikeDate.from": q.deathFrom,
    "q.deathLikeDate.to": q.deathTo,
    "q.birthLikePlace": q.birthPlace,
  });
}

/** The prefilled search page of one site. Geni and WikiTree take only the name
 *  in the address; the reader narrows by year on their page. */
export function searchUrl(site: SearchSite, q: PersonQuery): string {
  switch (site) {
    case "index":
      // The index website's own short parameters (its lib/url.js PARAM_MAP);
      // ex=0 asks for its approximate (fuzzy) search, as the API call does.
      return withParams(INDEX_SITE, {
        t: "person",
        n: q.given,
        sn: q.surname,
        dob: q.birthFrom,
        dobt: q.birthTo,
        dod: q.deathFrom,
        dodt: q.deathTo,
        ex: 0,
      });
    case "familysearchTree":
      return familySearch("tree", q);
    case "familysearchRecords":
      return familySearch("record", q);
    case "geni":
      return withParams("https://www.geni.com/search", {
        search_type: "people",
        names: [q.given, q.surname].filter(Boolean).join(" "),
      });
    case "wikitree":
      return withParams("https://www.wikitree.com/index.php", {
        title: "Special:SearchPerson",
        wpFirst: q.given,
        wpLast: q.surname,
      });
  }
}
