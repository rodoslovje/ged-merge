import type { PersonName } from "./types";

/**
 * A whole name part used as a stand-in for an *unknown* given or surname:
 *  - runs of placeholder punctuation — `____`, `????`, `---`, `...`, `…`;
 *  - the Latin "nomen nescio" marker — `NN`, `N.N.`, `N N`;
 *  - the word "unknown" (and German/Slovenian/Croatian unbekannt/neznano/
 *    nepoznato, plus the phrases "priimek neznan" / "ime neznano").
 *
 * Deliberately conservative: a single ambiguous letter (`N`, `X`) is *not*
 * treated as a placeholder, since it is far more often a real initial. A blank
 * slot is the absence of a token, not a token — callers handle it separately.
 */
const UNKNOWN_NAME_RE =
  /^(?:[_?\-–—.·*…]+|n\.?\s*n\.?|unknown|unbekannt|neznan[oa]?|nepoznat[oa]?|priimek\s+neznan|ime\s+neznano)$/i;

/** Whether a given/surname slot is a placeholder for an unknown name. */
export function isUnknownNameToken(text: string | undefined): boolean {
  const t = text?.trim();
  return !!t && UNKNOWN_NAME_RE.test(t);
}

/**
 * Parse a `NAME` line into structured parts.
 *
 * GEDCOM stores the surname between slashes in the value (e.g.
 * "John /Smith/ Jr"), and may additionally provide GIVN/SURN/NPFX/NSFX/NICK
 * sub-tags which, when present, take precedence.
 */
export function parseName(value: string | undefined, subTags: Map<string, string>): PersonName {
  const prefix = subTags.get("NPFX");
  const suffix = subTags.get("NSFX");
  const nickname = subTags.get("NICK");
  const type = subTags.get("TYPE");
  // Married surname stored inline (Gramps/PAF/Brother's Keeper style). The
  // value is a bare surname; tolerate a slash-wrapped form too.
  const marnm = subTags.get("_MARNM");
  const married = marnm?.match(/\/([^/]*)\//)?.[1].trim() ?? marnm;

  const raw = (value ?? "").trim();

  // The slash-delimited NAME value is what's actually displayed, so it takes
  // precedence over the GIVN/SURN pieces when present — those are only a
  // fallback for names with no slash form (and occasionally drift out of
  // sync with the value, e.g. a GIVN missing a middle name).
  let given: string | undefined;
  let surname: string | undefined;
  const slash = raw.match(/^(.*?)\/([^/]*)\/(.*)$/);
  if (slash) {
    given = slash[1].trim() || undefined;
    surname = slash[2].trim() || undefined;
  } else {
    given = raw || undefined;
  }
  given = given ?? subTags.get("GIVN");
  surname = surname ?? subTags.get("SURN");

  const full = raw.replace(/\//g, "").replace(/\s+/g, " ").trim() ||
    [prefix, given, surname, suffix].filter(Boolean).join(" ");

  const name: PersonName = { full };
  if (given) name.given = given;
  if (surname) name.surname = surname;
  if (prefix) name.prefix = prefix;
  if (suffix) name.suffix = suffix;
  if (nickname) name.nickname = nickname;
  if (type) name.type = type;
  if (married) name.married = married;
  return name;
}
