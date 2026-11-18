// DNA helpers (Tools → DNA): what a DNA testing site asks of a tester's tree,
// read off the file instead of retyped — the ancestral surnames with their
// places (FamilyTreeDNA's Surname/Location CSV), and the direct paternal (Y)
// and maternal (mtDNA) lines with the earliest known ancestor on each.
//
// Only *birth* parent links are followed (`birthParentFamilies`): an adoptive
// or foster parent is family, but not the line a DNA test reads.

import type { Dataset, GedEvent, GedPlace, Individual, PersonName } from "../gedcom/types";
import { birthParentFamilies } from "../gedcom/couple";
import { birthDateOf, deathYear } from "../gedcom/lifespan";
import { isUnknownNameToken } from "../gedcom/name";

/** How much of a place goes into the Location column. */
export type PlaceLevel = "full" | "locality" | "localityCountry" | "country" | "none";
export const PLACE_LEVELS: PlaceLevel[] = ["localityCountry", "locality", "full", "country", "none"];

/** Where a person's place is read from, in order: birth, its proxies, then death. */
const PLACE_TAGS = ["BIRT", "BAPM", "CHR", "DEAT", "BURI"] as const;

/** The father and mother a person has by birth, either of them absent. */
export function birthParents(ds: Dataset, indi: Individual): { father?: Individual; mother?: Individual } {
  const fams = birthParentFamilies(indi, ds);
  const famF = fams.find((f) => f.husband && ds.individuals.has(f.husband));
  const famM = fams.find((f) => f.wife && ds.individuals.has(f.wife));
  return {
    father: famF ? ds.individuals.get(famF.husband!) : undefined,
    mother: famM ? ds.individuals.get(famM.wife!) : undefined,
  };
}

function known(text: string | undefined): string | undefined {
  const t = text?.trim();
  return t && !isUnknownNameToken(t) ? t : undefined;
}

/** A surname written in capitals (the "NOVAK" convention) in its ordinary case. */
function surnameCase(s: string): string {
  if (s !== s.toUpperCase() || s === s.toLowerCase()) return s;
  return s.toLowerCase().replace(/(^|[\s\-'’])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}

/**
 * The name a person was born with: a name typed birth/maiden, else the first
 * name that is not a married one. A woman's married name says nothing of the
 * line she came from, which is what a DNA site asks about.
 */
export function birthName(indi: Individual): PersonName | undefined {
  const typed = (n: PersonName) => n.type?.trim().toLowerCase();
  return (
    indi.names.find((n) => typed(n) === "birth" || typed(n) === "maiden") ??
    indi.names.find((n) => typed(n) !== "married") ??
    indi.names[0]
  );
}

/** The person's birth surname, when the file knows it. */
export function birthSurname(indi: Individual): string | undefined {
  const s = known(birthName(indi)?.surname?.replace(/\//g, ""));
  return s ? surnameCase(s) : undefined;
}

/** The person's given name, when the file knows it. */
export function givenName(indi: Individual): string | undefined {
  return known(birthName(indi)?.given);
}

/** The event a person's place is taken from: birth, baptism, christening, death, burial. */
export function placeEvent(indi: Individual): GedEvent | undefined {
  for (const tag of PLACE_TAGS) {
    const e = indi.events.find((ev) => ev.tag === tag && ev.place?.raw.trim());
    if (e) return e;
  }
  return undefined;
}

function placeParts(place: GedPlace): string[] {
  return place.parts.map((p) => p.trim()).filter(Boolean);
}

/** The country of a place: its outermost part. */
export function placeCountry(place: GedPlace | undefined): string {
  const parts = place ? placeParts(place) : [];
  return parts.length > 1 ? parts[parts.length - 1] : "";
}

/** A place cut to the chosen level. */
export function placeAt(place: GedPlace | undefined, level: PlaceLevel): string {
  if (!place || level === "none") return "";
  const parts = placeParts(place);
  if (parts.length === 0) return "";
  switch (level) {
    case "full":
      return parts.join(", ");
    case "locality":
      return parts[0];
    case "country":
      return parts[parts.length - 1];
    case "localityCountry":
      return parts.length > 1 ? `${parts[0]}, ${parts[parts.length - 1]}` : parts[0];
  }
}

// ---------------------------------------------------------------------------
// Ancestral surnames
// ---------------------------------------------------------------------------

export interface SurnameRow {
  /** Stable key for the row: surname + location, case-folded. */
  key: string;
  surname: string;
  location: string;
  /** The ancestors who carry it there, nearest generation first. */
  personIds: string[];
  /** The nearest generation it appears in (1 = parents). */
  generation: number;
  /** Earliest and latest birth year among them, when any is known. */
  fromYear?: number;
  toYear?: number;
}

export interface SurnameOptions {
  /** Generations above the root to walk; 0 walks them all. */
  maxGenerations: number;
  place: PlaceLevel;
}

/**
 * Every (birth surname, place) pair among the root's ancestors, one row each.
 * The root is left out — the list is of ancestors — and an ancestor reached
 * twice (pedigree collapse) is counted once.
 */
export function ancestorSurnames(ds: Dataset, rootId: string, opts: SurnameOptions): SurnameRow[] {
  const root = ds.individuals.get(rootId);
  if (!root) return [];
  const rows = new Map<string, SurnameRow>();
  const seen = new Set<string>([root.id]);
  let queue: Individual[] = [root];
  for (let gen = 1; queue.length > 0 && (opts.maxGenerations === 0 || gen <= opts.maxGenerations); gen++) {
    const next: Individual[] = [];
    for (const child of queue) {
      const { father, mother } = birthParents(ds, child);
      for (const p of [father, mother]) {
        if (!p || seen.has(p.id)) continue;
        seen.add(p.id);
        next.push(p);
        const surname = birthSurname(p);
        if (!surname) continue;
        const location = placeAt(placeEvent(p)?.place, opts.place);
        const key = `${surname.toLocaleLowerCase()}\u0000${location.toLocaleLowerCase()}`;
        const year = birthDateOf(p)?.year;
        const row = rows.get(key) ?? { key, surname, location, personIds: [], generation: gen };
        row.personIds.push(p.id);
        if (year !== undefined) {
          row.fromYear = row.fromYear === undefined ? year : Math.min(row.fromYear, year);
          row.toYear = row.toYear === undefined ? year : Math.max(row.toYear, year);
        }
        rows.set(key, row);
      }
    }
    queue = next;
  }
  return [...rows.values()].sort(
    (a, b) => a.surname.localeCompare(b.surname) || a.location.localeCompare(b.location),
  );
}

/** The rows as FamilyTreeDNA's surname upload wants them: two columns, `Surname` and `Location`. */
export function ftdnaSurnameRows(rows: SurnameRow[]): string[][] {
  return [["Surname", "Location"], ...rows.map((r) => [r.surname, r.location])];
}

// ---------------------------------------------------------------------------
// Direct lines and the earliest known ancestor
// ---------------------------------------------------------------------------

export type LineSide = "paternal" | "maternal";

export interface LineStep {
  id: string;
  /** 1 = the root's parent, 2 = grandparent, … */
  generation: number;
  given?: string;
  surname?: string;
  birthYear?: number;
  /** The birth year stands on an approximate or ranged date. */
  birthApprox: boolean;
  deathYear?: number;
  /** The place the step's place fields come from, and the event that holds it. */
  place?: GedPlace;
  placeTag?: string;
  /** Named well enough to stand as an earliest known ancestor. */
  usable: boolean;
}

/**
 * The root's father, his father, … (paternal) or mother, her mother, …
 * (maternal), nearest first, as far as the file follows birth links.
 */
export function directLine(ds: Dataset, rootId: string, side: LineSide): LineStep[] {
  const out: LineStep[] = [];
  const seen = new Set<string>([rootId]);
  let cur = ds.individuals.get(rootId);
  for (let gen = 1; cur; gen++) {
    const parents = birthParents(ds, cur);
    const next = side === "paternal" ? parents.father : parents.mother;
    if (!next || seen.has(next.id)) break;
    seen.add(next.id);
    const given = givenName(next);
    const surname = birthSurname(next);
    const birth = birthDateOf(next);
    const ev = placeEvent(next);
    out.push({
      id: next.id,
      generation: gen,
      given,
      surname,
      birthYear: birth?.year,
      birthApprox: !!birth && birth.qualifier !== "exact",
      deathYear: deathYear(next),
      place: ev?.place,
      placeTag: ev?.tag,
      usable: !!given && !!surname,
    });
    cur = next;
  }
  return out;
}

/**
 * The earliest known ancestor of a line: the farthest step named with both a
 * given name and a surname. A mother known only as "Marija" is the end of what
 * the file knows, but no use to a match looking for a shared ancestor — the
 * generation below her, fully named, is.
 */
export function earliestKnown(line: LineStep[]): LineStep | undefined {
  for (let i = line.length - 1; i >= 0; i--) if (line[i].usable) return line[i];
  return undefined;
}
