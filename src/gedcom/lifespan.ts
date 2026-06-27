import type { Individual } from "./types";

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

/** True when the record carries any death/burial/cremation event, even undated. */
export function isDeceased(indi: Individual | undefined): boolean {
  return (indi?.events ?? []).some((e) => (DEATH_TAGS as readonly string[]).includes(e.tag));
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
