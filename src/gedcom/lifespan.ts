import type { Individual } from "./types";

/** Events that mark a person as deceased (used when no death year is recorded). */
const DEATH_TAGS = ["DEAT", "BURI", "CREM"] as const;

/** The recorded death year — death, else burial/cremation — if any. */
export function deathYear(indi: Individual | undefined): number | undefined {
  for (const tag of DEATH_TAGS) {
    const year = indi?.events.find((e) => e.tag === tag)?.date?.year;
    if (year !== undefined) return year;
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
