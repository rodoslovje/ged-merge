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

/**
 * Whether a person is presumed living for chart-privacy purposes. They count
 * as living when they carry no death event *and* either their own birth, or —
 * when that's missing — a birth estimated from dated relatives via `ds`, falls
 * within the last {@link LIVING_WINDOW_YEARS} years. A person with no death
 * event, no birth, and no datable relatives (typically a fully-undated ancient
 * ancestor) is treated as deceased (not redacted) — otherwise every such
 * ancestor would be hidden, which is the opposite of useful on a chart.
 */
export function isPresumedLiving(
  indi: Individual | undefined,
  ds?: Dataset,
  now: number = new Date().getFullYear(),
): boolean {
  if (!indi || isDeceased(indi)) return false;
  const by = birthYear(indi);
  if (by !== undefined) return now - by < LIVING_WINDOW_YEARS;
  const est = ds && estimateBirthYear(indi, ds);
  return est !== undefined && now - est.estimatedYear < LIVING_WINDOW_YEARS;
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
