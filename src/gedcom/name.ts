import type { PersonName } from "./types";

/**
 * Parse a `NAME` line into structured parts.
 *
 * GEDCOM stores the surname between slashes in the value (e.g.
 * "John /Smith/ Jr"), and may additionally provide GIVN/SURN/NPFX/NSFX/NICK
 * sub-tags which, when present, take precedence.
 */
export function parseName(value: string | undefined, subTags: Map<string, string>): PersonName {
  let given = subTags.get("GIVN");
  let surname = subTags.get("SURN");
  const prefix = subTags.get("NPFX");
  const suffix = subTags.get("NSFX");
  const nickname = subTags.get("NICK");
  const type = subTags.get("TYPE");

  const raw = (value ?? "").trim();

  if (given === undefined || surname === undefined) {
    const slash = raw.match(/^(.*?)\/([^/]*)\/(.*)$/);
    if (slash) {
      if (given === undefined) given = slash[1].trim() || undefined;
      if (surname === undefined) surname = slash[2].trim() || undefined;
    } else if (given === undefined) {
      given = raw || undefined;
    }
  }

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
