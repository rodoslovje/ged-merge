import type { NameOrder } from "./nameDisplay";
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
 * Split a free-typed full name into given/surname parts — used when a person is
 * created from text the user has already typed (the global search query). The
 * surname sits where the display order puts it: last in "given-surname"
 * ("Janez Novak"), first in "surname-given" ("Novak Janez"). Everything else
 * becomes the given name. A single word is taken as a given name, since a lone
 * word typed into a search box is more often a first name — and either way the
 * new person's name field opens focused for correction.
 */
/**
 * Give a name typed in a hurry its capitals: "ana stare" → "Ana Stare". Only
 * words written entirely in lower case are touched, so a deliberate "STARE"
 * (the uppercase-surname convention some files use) or a "McDonald" stays as
 * typed. Hyphenated and apostrophed parts each take their own capital.
 */
export function capitalizeTypedName(text: string): string {
  return text.replace(/\S+/g, (word) =>
    word === word.toLowerCase()
      ? word.replace(/(^|[-'\u2019])(\p{Ll})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase())
      : word,
  );
}

export function splitFullName(text: string, order: NameOrder = "given-surname"): { given?: string; surname?: string } {
  const parts = capitalizeTypedName(text.trim()).split(/\s+/).filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length === 1) return { given: parts[0] };
  if (order === "surname-given") return { surname: parts[0], given: parts.slice(1).join(" ") };
  return { given: parts.slice(0, -1).join(" "), surname: parts[parts.length - 1] };
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
  let suffix = subTags.get("NSFX");
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
    // A token after the closing slash is conventionally a suffix
    // ("John /Smith/ Jr"); when nothing precedes the slashes it's the given
    // name of a surname-first writer ("/Novak/ Janez").
    const trailing = slash[3].trim() || undefined;
    if (trailing) {
      if (given) suffix = trailing;
      else given = trailing;
    }
  } else {
    given = raw || undefined;
  }
  given = given ?? subTags.get("GIVN");
  surname = surname ?? subTags.get("SURN");

  // MacFamilyTree's SECG carries the second given name. It usually restates
  // part of the NAME value; fold it in only when it's genuinely extra
  // ("Sonja //" + `SECG Lidija`), so no given name is lost to matching/edit.
  const secg = subTags.get("SECG");
  if (secg && !(given ?? "").includes(secg)) given = given ? `${given} ${secg}` : secg;

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
