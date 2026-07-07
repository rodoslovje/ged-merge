import type { Dataset, GedDate, Individual } from "./types";

/** Birth proxies, in order of preference (birth, else baptism/christening). */
const BIRTH_TAGS = ["BIRT", "BAPM", "CHR"] as const;
/** Events that mark a person as deceased (used when no death year is recorded). */
const DEATH_TAGS = ["DEAT", "BURI", "CREM"] as const;

/** The birth year — birth, else baptism/christening as a proxy — if any. */
export function birthYear(indi: Individual | undefined): number | undefined {
  return yearOf(indi, BIRTH_TAGS);
}

/** The recorded death year — death, else burial/cremation — if any. */
export function deathYear(indi: Individual | undefined): number | undefined {
  return yearOf(indi, DEATH_TAGS);
}

function yearOf(indi: Individual | undefined, tags: readonly string[]): number | undefined {
  for (const tag of tags) {
    const year = indi?.events.find((e) => e.tag === tag)?.date?.year;
    if (year !== undefined) return year;
  }
  return undefined;
}

/**
 * A comparable numeric key for sorting siblings by birth (year, then month,
 * then day; missing month/day count as 0). Individuals with no known birth
 * year return `Infinity` so they sort to the end.
 */
export function birthSortKey(indi: Individual | undefined): number {
  for (const tag of BIRTH_TAGS) {
    const d = indi?.events.find((e) => e.tag === tag)?.date;
    if (d?.year !== undefined) return d.year * 10000 + (d.month ?? 0) * 100 + (d.day ?? 0);
  }
  return Infinity;
}

/** The original birth date text (birth, else baptism/christening), if any. */
export function birthDateText(indi: Individual | undefined): string | undefined {
  return dateRawOf(indi, BIRTH_TAGS);
}

/** The original death date text (death, else burial/cremation), if any. */
export function deathDateText(indi: Individual | undefined): string | undefined {
  return dateRawOf(indi, DEATH_TAGS);
}

function dateRawOf(indi: Individual | undefined, tags: readonly string[]): string | undefined {
  for (const tag of tags) {
    const raw = indi?.events.find((e) => e.tag === tag)?.date?.raw;
    if (raw) return raw;
  }
  return undefined;
}

/** The structured birth date (birth, else baptism/christening), if it has a year. */
export function birthDateOf(indi: Individual | undefined): GedDate | undefined {
  return structuredDateOf(indi, BIRTH_TAGS);
}

/** The structured death date (death, else burial/cremation), if it has a year. */
export function deathDateOf(indi: Individual | undefined): GedDate | undefined {
  return structuredDateOf(indi, DEATH_TAGS);
}

function structuredDateOf(indi: Individual | undefined, tags: readonly string[]): GedDate | undefined {
  for (const tag of tags) {
    const d = indi?.events.find((e) => e.tag === tag)?.date;
    if (d?.year !== undefined) return d;
  }
  return undefined;
}

/** True when the record carries any death/burial/cremation event, even undated. */
export function isDeceased(indi: Individual | undefined): boolean {
  return (indi?.events ?? []).some((e) => (DEATH_TAGS as readonly string[]).includes(e.tag));
}

/** Years since a birth still counts a person as possibly living (privacy default). */
const LIVING_WINDOW_YEARS = 100;

/** A rough generational gap (years) used to estimate an undated birth from kin. */
const GENERATION = 28;

/** The kin relation an undated birth estimate was derived from. */
export type EstimateRelation = "father" | "mother" | "spouse" | "child";

/** When a birth estimate is derived from a relative, the single relative whose
 *  date drove it, so callers can explain which relation and how the age follows. */
export interface BirthEstimate {
  /** The year this person's birth is estimated at. */
  estimatedYear: number;
  relation: EstimateRelation;
  relativeId: string;
  relativeName: string;
  /** The relative's own birth year that the estimate was offset from. */
  relativeYear: number;
}

/**
 * Estimate a birth year from dated immediate relatives (parents, spouse,
 * children) when the person carries no birth date of their own, biased toward
 * the most recent evidence so borderline people lean "living" — the safe
 * default for privacy heuristics.
 */
export function estimateBirthYear(indi: Individual, ds: Dataset): BirthEstimate | undefined {
  let best: BirthEstimate | undefined;
  const consider = (rel: Individual | undefined, relation: EstimateRelation, delta: number) => {
    if (!rel) return;
    const ry = birthYear(rel);
    if (ry === undefined) return;
    const v = ry + delta;
    if (best === undefined || v > best.estimatedYear) {
      best = {
        estimatedYear: v,
        relation,
        relativeId: rel.id,
        relativeName: rel.names[0]?.full?.trim() || rel.id,
        relativeYear: ry,
      };
    }
  };
  // Parents → this person was born ~a generation later.
  for (const famId of indi.childOf) {
    const fam = ds.families.get(famId);
    if (!fam) continue;
    consider(fam.husband ? ds.individuals.get(fam.husband) : undefined, "father", GENERATION);
    consider(fam.wife ? ds.individuals.get(fam.wife) : undefined, "mother", GENERATION);
  }
  // Spouse (same generation) and children (~a generation earlier).
  for (const famId of indi.spouseOf) {
    const fam = ds.families.get(famId);
    if (!fam) continue;
    const otherId = fam.husband === indi.id ? fam.wife : fam.husband;
    consider(otherId ? ds.individuals.get(otherId) : undefined, "spouse", 0);
    for (const cid of fam.children) consider(ds.individuals.get(cid), "child", -GENERATION);
  }
  return best;
}

/** How many relationship hops {@link isPresumedLiving}'s network search follows
 *  looking for a dated relative, and how many individuals it will visit doing
 *  so — bounds the search on very large or densely intermarried trees. */
const NETWORK_SEARCH_MAX_HOPS = 8;
const NETWORK_SEARCH_MAX_VISITED = 500;

/**
 * Estimate a birth year by walking the family graph outward from `start` —
 * parents (a generation earlier), spouses (same generation), children (a
 * generation later), and so on transitively — until a relative with their own
 * recorded birth year is found. Unlike {@link estimateBirthYear} this isn't
 * limited to immediate kin, so it reaches e.g. a grandparent when the person's
 * own parent is undated too. Search is bounded by hops and visited-count so it
 * stays cheap on large datasets; among everything found within those bounds it
 * returns the most recent (safe-default, "presume living") estimate.
 */
function estimateBirthYearFromNetwork(start: Individual, ds: Dataset): number | undefined {
  const visited = new Set<string>([start.id]);
  let frontier: { id: string; offset: number }[] = [{ id: start.id, offset: 0 }];
  let best: number | undefined;
  for (let hop = 0; hop < NETWORK_SEARCH_MAX_HOPS && frontier.length && visited.size < NETWORK_SEARCH_MAX_VISITED; hop++) {
    const next: { id: string; offset: number }[] = [];
    const visit = (id: string | undefined, offset: number) => {
      if (!id || visited.has(id) || visited.size >= NETWORK_SEARCH_MAX_VISITED) return;
      visited.add(id);
      next.push({ id, offset });
    };
    for (const { id, offset } of frontier) {
      const person = ds.individuals.get(id);
      if (!person) continue;
      // Parents are a generation earlier: offset(parent) = offset(self) + GENERATION.
      for (const famId of person.childOf) {
        const fam = ds.families.get(famId);
        if (!fam) continue;
        visit(fam.husband, offset + GENERATION);
        visit(fam.wife, offset + GENERATION);
      }
      // Spouses share a generation; children are a generation later.
      for (const famId of person.spouseOf) {
        const fam = ds.families.get(famId);
        if (!fam) continue;
        const otherId = fam.husband === id ? fam.wife : fam.husband;
        visit(otherId, offset);
        for (const cid of fam.children) visit(cid, offset - GENERATION);
      }
    }
    for (const { id, offset } of next) {
      const by = birthYear(ds.individuals.get(id));
      if (by === undefined) continue;
      const candidate = by + offset;
      if (best === undefined || candidate > best) best = candidate;
    }
    frontier = next;
  }
  return best;
}

/**
 * Whether a person is presumed living for chart-privacy purposes. No death
 * event is the starting assumption of "living"; it's overridden only when
 * there's dating evidence that places their birth more than
 * {@link LIVING_WINDOW_YEARS} years ago — their own recorded birth, or,
 * failing that, one estimated from relatives found via `ds` (see
 * {@link estimateBirthYearFromNetwork}). With no death event, no birth, and no
 * datable relative anywhere in reach, there's nothing to disprove "living" —
 * so, per the safe-default policy, they count as living too.
 */
export function isPresumedLiving(
  indi: Individual | undefined,
  ds?: Dataset,
  now: number = new Date().getFullYear(),
): boolean {
  if (!indi || isDeceased(indi)) return false;
  const by = birthYear(indi);
  if (by !== undefined) return now - by < LIVING_WINDOW_YEARS;
  const est = ds && estimateBirthYearFromNetwork(indi, ds);
  return est === undefined || now - est < LIVING_WINDOW_YEARS;
}

/**
 * Birth–death lifespan label:
 *  - `1817–1921` when both years are known,
 *  - `1817–` when born and known dead but the death year is unknown,
 *  - `1817` when born and presumed living,
 *  - `–1921` when only the death year is known, `""` when nothing is dated.
 */
export function formatLifespan(
  birth: number | undefined,
  death: number | undefined,
  deceased: boolean,
): string {
  if (birth !== undefined && death !== undefined) return `${birth}–${death}`;
  if (birth !== undefined) return deceased ? `${birth}–` : `${birth}`;
  if (death !== undefined) return `–${death}`;
  return "";
}

/** The lifespan label for a single individual ({@link formatLifespan}). */
export function lifespanOf(indi: Individual | undefined): string {
  return formatLifespan(birthYear(indi), deathYear(indi), isDeceased(indi));
}

/**
 * Full-date version of {@link formatLifespan} for hover tooltips — the original
 * birth/death date text instead of bare years, e.g. "26 Jan 1908 – 3 Mar 1970",
 * "ABT 1908 –" (living unknown), or "". Locale-neutral (no b./d. abbreviations).
 */
export function datesTooltip(
  birth: string | undefined,
  death: string | undefined,
  deceased: boolean,
): string {
  if (birth && death) return `${birth} – ${death}`;
  if (birth) return deceased ? `${birth} –` : birth;
  if (death) return `– ${death}`;
  return "";
}

/** The full-date tooltip for a single individual ({@link datesTooltip}). */
export function datesTooltipOf(indi: Individual | undefined): string {
  return datesTooltip(birthDateText(indi), deathDateText(indi), isDeceased(indi));
}
