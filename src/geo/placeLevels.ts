import { decomposePlace } from "../gedcom/place";
import { countryCode } from "../gedcom/countryCode";
import { foldToken } from "../match/text";
import { placeFormFor } from "../normalize/profile";
import type { PlaceTargetFormat } from "../normalize/types";
import type { GazEntry, GazetteerIndex } from "./gazetteer";

// Which level a file writes above a settlement.
//
// A register describes two of them. Every entry names the municipality it
// belongs to (`admin` — občina, općina), and the entries of some countries also
// carry the code of the division above that (`admin1` — županija, county),
// whose names the index holds separately. A file writes one or the other, and
// which one is a house style: the same researcher writes "Bektež, Kutjevo,
// Croatia" or "Bektež, Požega-Slavonia, Croatia" throughout, never both.
//
// Reading that style matters twice over. A place composed from a register entry
// has to name the level the file's other places name, or it does not look like
// them; and the compliance check must hold a county against counties, since a
// county held against a municipality can only ever be reported as disagreeing.
//
// The style is inferred, never asked for: the file already says what it does,
// in its own `PLAC.FORM` labels where it writes them, and in the names it puts
// in that slot where it does not.

/** The register level a file names above a settlement. */
export type ParentLevel = "admin" | "division";

/** What a file's `FORM` label calls each level, folded. A label naming neither
 *  (a parish, an "Upravna enota", a wording we don't know) leaves the decision
 *  to the names the file actually writes, which is the more reliable evidence
 *  anyway — these only settle a file whose names are ambiguous. */
const LEVEL_WORDS: Record<ParentLevel, string[]> = {
  division: ["zupanija", "county", "regija", "region", "pokrajina", "provinca", "province", "provincia", "state", "bundesland", "megye", "varmegye", "komitat", "gespanschaft"],
  admin: ["obcina", "opcina", "opstina", "municipality", "commune", "comune", "gemeinde", "kreis", "upravna enota", "okres"],
};

/** The level a `FORM` label names, when it names one of the two at all. */
function levelOfLabel(label: string): ParentLevel | undefined {
  const folded = foldToken(label);
  if (!folded) return undefined;
  for (const level of ["division", "admin"] as const) {
    if (LEVEL_WORDS[level].some((w) => folded.includes(w))) return level;
  }
  return undefined;
}

/** How this file names the level above a settlement, per country, and what to
 *  write there for a given register entry. */
export interface PlaceParentLevels {
  /** The level this file writes above a settlement in this country — the
   *  municipality unless its own places say otherwise. */
  levelOf(country: string): ParentLevel;
  /** The entry's parent at that level, in the file's own wording: its division
   *  where the file writes divisions and the register knows which one this is,
   *  its municipality otherwise. */
  parentOf(entry: GazEntry): string | undefined;
  /** Every name the entry's own division goes by — what a parent the file
   *  writes has to match to be the right one. Empty where the register files
   *  the entry under no division. */
  divisionNamesOf(entry: GazEntry): readonly string[];
  /** That division under the one name this file would write for it: the
   *  spelling it already uses for this very division, else the kind of name it
   *  reaches for elsewhere (the official form, the bare adjective, the English
   *  one). Undefined where the entry has no division. */
  divisionNameOf(entry: GazEntry): string | undefined;
  /** Every division name in this country, for recognizing a segment as one. */
  divisionNamesIn(country: string): readonly string[];
}

/** A file that has no places yet, or an index with nothing in it: municipality
 *  everywhere, which is what every caller did before this existed. */
export const MUNICIPALITY_LEVELS: PlaceParentLevels = {
  levelOf: () => "admin",
  parentOf: (entry) => entry.admin,
  divisionNamesOf: () => [],
  divisionNameOf: () => undefined,
  divisionNamesIn: () => [],
};

/** The division key an entry is filed under, e.g. `"HR:11"`. */
function divisionKey(entry: GazEntry): string | undefined {
  return entry.admin1 ? `${entry.country}:${entry.admin1}` : undefined;
}

/**
 * Read a file's parent-level style off its own places.
 *
 * Two passes, the second deciding only what the first leaves open:
 *
 * 1. The names the file writes in the parent slot, each tested against the
 *    country's division names and its municipality names. A segment matching
 *    exactly one of the two is evidence for that level; one matching both says
 *    nothing and is passed over — Croatia has a Karlovac county and a Karlovac
 *    city, and the word alone cannot tell which the file means.
 * 2. The file's own `FORM` labels, which name the level outright. They settle a
 *    country whose names were all ambiguous, and are not allowed to overrule
 *    attested names: a `FORM` is written once and then goes stale, while the
 *    places are the file as it actually stands.
 */
export function inferPlaceParentLevels(
  places: readonly string[],
  index: GazetteerIndex,
  fmt?: PlaceTargetFormat,
): PlaceParentLevels {
  // Every division of every country the index covers, by folded name.
  const divisionOfName = new Map<string, string>();
  const namesOfDivision = new Map<string, string[]>();
  const divisionsByCountry = new Map<string, string[]>();
  for (const [key, names] of index.divisions ?? []) {
    namesOfDivision.set(key, names);
    const country = key.split(":")[0];
    const all = divisionsByCountry.get(country) ?? [];
    for (const name of names) {
      const folded = foldToken(name);
      if (!folded) continue;
      all.push(name);
      // A name two divisions share would make either unrecognizable; the first
      // keeps it, the way the register's own county join drops the ties.
      if (!divisionOfName.has(folded)) divisionOfName.set(folded, key);
    }
    divisionsByCountry.set(country, all);
  }
  // Every municipality name, per country — the other level a parent may name.
  const municipalities = new Map<string, Set<string>>();
  for (const e of index.entries) {
    if (!e.admin) continue;
    const set = municipalities.get(e.country) ?? new Set<string>();
    set.add(foldToken(e.admin));
    municipalities.set(e.country, set);
  }

  const tally = new Map<string, { division: number; admin: number }>();
  /** The file's own spelling of a division it names, by division key. */
  const writtenName = new Map<string, string>();
  /** Which of a division's names the file reaches for, as an index into the
   *  name list — how it would write one it has never written before. */
  const nameRank = new Map<number, number>();
  const sampleOf = new Map<string, string>();

  for (const value of places) {
    const components = decomposePlace(value);
    if (!components.country) continue;
    const country = countryCode(components.country)?.toUpperCase();
    if (!country) continue;
    if (!sampleOf.has(country)) sampleOf.set(country, value);
    const towns = municipalities.get(country);
    for (const part of components.jurisdiction.slice(1)) {
      const folded = foldToken(part.trim());
      if (!folded) continue;
      const key = divisionOfName.get(folded);
      const isDivision = !!key && key.startsWith(`${country}:`);
      const isTown = !!towns?.has(folded);
      if (isDivision === isTown) continue; // neither, or both — no evidence
      const counts = tally.get(country) ?? { division: 0, admin: 0 };
      counts[isDivision ? "division" : "admin"]++;
      tally.set(country, counts);
      if (!isDivision || !key) continue;
      if (!writtenName.has(key)) writtenName.set(key, part.trim());
      const at = (namesOfDivision.get(key) ?? []).findIndex((n) => foldToken(n) === folded);
      if (at >= 0) nameRank.set(at, (nameRank.get(at) ?? 0) + 1);
    }
  }

  const levels = new Map<string, ParentLevel>();
  for (const [country, counts] of tally) {
    if (counts.division !== counts.admin) levels.set(country, counts.division > counts.admin ? "division" : "admin");
  }
  // Only now the labels, and only where the names left the question open.
  if (fmt) {
    for (const [country, sample] of sampleOf) {
      if (levels.has(country)) continue;
      const form = placeFormFor(fmt, sample, decomposePlace(sample).country);
      if (!form) continue;
      const labels = form.split(",").slice(1, -1);
      const level = labels.map(levelOfLabel).find((l) => l !== undefined);
      if (level) levels.set(country, level);
    }
  }

  // The rank the file reaches for most often — how it spells a division it has
  // never written. A list too short for that rank ends at its last name.
  let preferredRank = 0;
  let best = 0;
  for (const [at, n] of nameRank) {
    if (n > best || (n === best && at < preferredRank)) {
      preferredRank = at;
      best = n;
    }
  }

  const divisionNamesOf = (entry: GazEntry): readonly string[] => {
    const key = divisionKey(entry);
    return (key && namesOfDivision.get(key)) || [];
  };
  const divisionNameOf = (entry: GazEntry): string | undefined => {
    const key = divisionKey(entry);
    const written = key && writtenName.get(key);
    if (written) return written;
    const names = divisionNamesOf(entry);
    return names[Math.min(preferredRank, names.length - 1)];
  };

  return {
    levelOf: (country) => levels.get(country) ?? "admin",
    divisionNamesOf,
    divisionNameOf,
    divisionNamesIn: (country) => divisionsByCountry.get(country) ?? [],
    // No division on the entry (the register could not join one) leaves the
    // municipality: a level too low is still true, an invented one is not.
    parentOf: (entry) =>
      (levels.get(entry.country) === "division" ? divisionNameOf(entry) : undefined) ?? entry.admin,
  };
}
