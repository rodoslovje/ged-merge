import type { PersonName } from "./types";

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
  return name;
}
