/**
 * Search the Slovenian genealogical index (indeks.rodoslovje.si) for one
 * person, straight from the browser: the public REST search answers any
 * origin, needs no login, and returns the same fields as the website's CSV
 * search export.
 *
 * Only the name and a year window leave the device — never the file.
 */
import type { Dataset, GedNode, Individual, Sex } from "../gedcom/types";
import { indexDataset, splitRowLinks } from "../csv/giMatches";
import { inferMainProfile } from "../normalize/profile";
import type { MainProfile } from "../normalize/types";
import { normalizeDataset } from "../normalize/normalize";
import { addChild, addPerson, coupleFam, inferSexFromNames, newPeople, node, pushEvent, settleGuessedRoles, type People } from "../csv/people";
import { DEFAULT_CONFIG } from "../match/types";
import { scoreIndividualPair } from "../match/scoreIndividual";
import { INDEX_SITE, type PersonQuery } from "./searchLinks";

export const INDEX_API = "https://indeks-api.rodoslovje.si/api/search/advanced/persons";

/** How many hits to ask for: the search is fuzzy ("Renko" also finds "Benko"),
 *  so the right person can sit well down its list until we rank it. */
const HIT_LIMIT = 50;

export interface IndexRelative {
  id?: string;
  sex?: string;
  name?: string;
  surname?: string;
  date_of_birth?: string;
}

/** One person row of the index's search API. */
export interface IndexHit {
  /** The index's own row id. */
  id: number;
  /** The person's id in the contributor's tree (a GEDCOM xref or a register hash). */
  ext_id?: string;
  contributor: string;
  name?: string;
  surname?: string;
  alt_surname?: string;
  sex?: string;
  date_of_birth?: string;
  place_of_birth?: string;
  date_of_baptism?: string;
  place_of_baptism?: string;
  date_of_death?: string;
  place_of_death?: string;
  date_of_burial?: string;
  place_of_burial?: string;
  parents_list?: IndexRelative[] | null;
  partners_list?: IndexRelative[] | null;
  links?: string[] | null;
}

/** The API address for a query. The place is left out on purpose: the index
 *  spells places as each contributor did, and a mismatch there would hide the
 *  right person — the ranking weighs places instead. */
export function indexApiUrl(q: PersonQuery): string {
  const p = new URLSearchParams();
  if (q.given) p.set("name", q.given);
  if (q.surname) p.set("surname", q.surname);
  if (q.birthFrom !== undefined) p.set("date_of_birth", String(q.birthFrom));
  if (q.birthTo !== undefined) p.set("date_of_birth_to", String(q.birthTo));
  if (q.deathFrom !== undefined) p.set("date_of_death", String(q.deathFrom));
  if (q.deathTo !== undefined) p.set("date_of_death_to", String(q.deathTo));
  p.set("limit", String(HIT_LIMIT));
  return `${INDEX_API}?${p.toString()}`;
}

/** Fetch the hits for a query. Throws on a network failure or a non-OK answer. */
export async function fetchIndexHits(q: PersonQuery, signal?: AbortSignal): Promise<IndexHit[]> {
  const res = await fetch(indexApiUrl(q), { signal, headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`index search: HTTP ${res.status}`);
  const body: unknown = await res.json();
  return Array.isArray(body) ? (body as IndexHit[]) : [];
}

/** The hit's own page on the index website. */
export function indexPersonUrl(hit: IndexHit): string {
  const p = new URLSearchParams({ t: "person" });
  if (hit.name) p.set("n", hit.name);
  if (hit.surname) p.set("sn", hit.surname);
  if (hit.ext_id) {
    p.set("id", hit.ext_id);
    p.set("c", hit.contributor);
  }
  p.set("ex", "1");
  return `${INDEX_SITE}?${p.toString()}`;
}

function sexOf(value: string | undefined): Sex | undefined {
  const v = value?.toLowerCase();
  return v === "m" ? "M" : v === "f" ? "F" : undefined;
}

function nameValue(given: string | undefined, surname: string | undefined): string {
  return `${(given ?? "").trim()} /${(surname ?? "").trim()}/`;
}

function hasName(r: IndexRelative): boolean {
  return !!(r.name?.trim() || r.surname?.trim());
}

/** The xref a hit gets in the records built from it. */
export function hitXref(index: number): string {
  return `@X${index + 1}@`;
}

function addHit(people: People, hit: IndexHit, index: number): void {
  const id = hitXref(index);
  const children: GedNode[] = [node(1, "NAME", nameValue(hit.name, hit.surname))];
  if (hit.alt_surname?.trim()) {
    const alt = node(1, "NAME", nameValue(hit.name, hit.alt_surname));
    alt.children.push(node(2, "TYPE", "aka"));
    children.push(alt);
  }
  const sex = sexOf(hit.sex);
  if (sex) children.push(node(1, "SEX", sex));
  const events = [
    { tag: "BIRT", date: hit.date_of_birth ?? "", place: hit.place_of_birth ?? "" },
    { tag: "CHR", date: hit.date_of_baptism ?? "", place: hit.place_of_baptism ?? "" },
    { tag: "DEAT", date: hit.date_of_death ?? "", place: hit.place_of_death ?? "" },
    { tag: "BURI", date: hit.date_of_burial ?? "", place: hit.place_of_burial ?? "" },
  ];
  const { byTag, recordLinks } = splitRowLinks((hit.links ?? []).join(","), events);
  for (const e of events) pushEvent(children, e.tag, e.date, e.place, byTag.get(e.tag));
  for (const url of [...recordLinks, indexPersonUrl(hit)]) children.push(node(1, "WWW", url));
  addPerson(people, id, children);

  const relative = (r: IndexRelative, rid: string): string => {
    const rc: GedNode[] = [node(1, "NAME", nameValue(r.name, r.surname))];
    const rs = sexOf(r.sex);
    if (rs) rc.push(node(1, "SEX", rs));
    pushEvent(rc, "BIRT", r.date_of_birth ?? "", "");
    addPerson(people, rid, rc);
    return rid;
  };

  const parents = (hit.parents_list ?? []).filter(hasName);
  if (parents.length) {
    const ids = parents.slice(0, 2).map((r, j) => relative(r, `@X${index + 1}P${j + 1}@`));
    // The index lists the father first; its sex column settles it when present.
    let [husb, wife] = ids;
    if (sexOf(parents[0].sex) === "F" || sexOf(parents[1]?.sex) === "M") [husb, wife] = [wife, husb];
    const fam = coupleFam(people, husb, wife, `@F${index + 1}P@`, true);
    addChild(fam.node, id);
    people.indi.get(id)!.children.push(node(1, "FAMC", fam.id));
  }
  (hit.partners_list ?? []).filter(hasName).forEach((r, j) => {
    const pid = relative(r, `@X${index + 1}S${j + 1}@`);
    const partnerIsHusband = sexOf(r.sex) === "M" || sex === "F";
    const rolesKnown = !!sexOf(r.sex) || !!sex;
    coupleFam(people, partnerIsHusband ? pid : id, partnerIsHusband ? id : pid, `@F${index + 1}S${j + 1}@`, rolesKnown);
  });
}

/** GEDCOM records for hits — each person with their parents and partners as
 *  the index lists them — xref'd by position ({@link hitXref}). */
export function hitRecords(hits: readonly IndexHit[]): GedNode[] {
  const people = newPeople();
  hits.forEach((hit, i) => addHit(people, hit, i));
  inferSexFromNames(people);
  settleGuessedRoles(people);
  return people.records;
}

/** A dataset of the hits, for scoring them against a person. */
export function hitsDataset(hits: readonly IndexHit[]): Dataset {
  return indexDataset(hitRecords(hits));
}

export interface RankedHit {
  hit: IndexHit;
  /** The hit's xref in the ranked dataset ({@link hitXref}). */
  id: string;
  /** The ordinary match score of this hit against the searched person, 0–100. */
  score: number;
}

export interface RankedHits {
  /** Every hit with its parents and partners, as one dataset. */
  ds: Dataset;
  /** Best match first. */
  ranked: RankedHit[];
}

/** Hits ordered by how well each matches the person, best first. */
export function rankHits(person: Individual, mainDs: Dataset, hits: readonly IndexHit[]): RankedHits {
  const ds = hitsDataset(hits);
  const ranked = hits
    .map((hit, i) => {
      const id = hitXref(i);
      const indi = ds.individuals.get(id);
      const score = indi ? scoreIndividualPair(person, indi, mainDs, ds, DEFAULT_CONFIG).score : 0;
      return { hit, id, score };
    })
    .sort((a, b) => b.score - a.score);
  return { ds, ranked };
}

/** The main file's conventions, inferred once per dataset: a walk of the
 *  whole file, too slow to repeat for every hit looked at. */
const profiles = new WeakMap<Dataset, MainProfile>();

/** The hits reshaped to the main file's date, place and name conventions —
 *  as Merge reshapes an incoming file — so a comparison shows what really
 *  differs, not how each side spells it. */
export function hitsForComparison(hitsDs: Dataset, mainDs: Dataset): Dataset {
  let profile = profiles.get(mainDs);
  if (!profile) {
    profile = inferMainProfile(mainDs);
    profiles.set(mainDs, profile);
  }
  return normalizeDataset(hitsDs, profile).dataset;
}
