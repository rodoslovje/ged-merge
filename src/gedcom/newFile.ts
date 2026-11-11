import { todayGedcom } from "./chanCrea";
import { isUnknownNameToken } from "./name";
import type { Dataset } from "./types";

/** The name of the submitter record a 5.5.1 file gets when it has none (see
 *  `completeStructure`) and the reader has not given their own in Settings.
 *  5.5.1 requires `HEAD.SUBM` and a SUBM record with a `NAME`; the browser
 *  cannot know the reader's name, so the record then names the program that
 *  wrote it — the name `HEAD.SOUR` carries too — rather than inventing a
 *  person. */
export const SUBMITTER_NAME = "GED Merge";

/** The reader as a file's author, from Settings: what a submitter record
 *  GED Merge writes carries. Values are stored as typed; trimmed here. */
export interface Submitter {
  name: string;
  email?: string;
  www?: string;
}

const clean = (value?: string) => value?.replace(/\s+/g, " ").trim() ?? "";

/** The name a submitter record GED Merge writes carries: the reader's own
 *  (Settings → Editing → "Your name"), trimmed, or {@link SUBMITTER_NAME}
 *  when none is set. */
export function submitterName(author?: Submitter): string {
  return clean(author?.name) || SUBMITTER_NAME;
}

/** The level-1 lines of a submitter record GED Merge writes: the name, then
 *  the reader's e-mail and website when set. EMAIL and WWW sit directly under
 *  SUBM in both 5.5.1 (its address structure) and 7.0. */
export function submitterFields(author?: Submitter): [tag: string, value: string][] {
  const fields: [string, string][] = [["NAME", submitterName(author)]];
  const email = clean(author?.email);
  const www = clean(author?.www);
  if (email) fields.push(["EMAIL", email]);
  if (www) fields.push(["WWW", www]);
  return fields;
}

/** Base name (without extension) of the file "Start a new file" creates. */
export const NEW_FILE_BASENAME = "new-tree";

/** Characters a file name can't carry — path separators, the Windows-reserved
 *  set, whitespace, and the dots our `{base}.{date}.gedmerge.ged` convention
 *  reads as field separators. */
const UNSAFE_IN_FILENAME = /[\\/:*?"<>|.\s]+/g;

/**
 * What to call a tree still carrying the `new-tree` placeholder: the surname of
 * the home person, or of the first person in the file when no home person is
 * set — in a tree started from nothing, that is the first person added.
 *
 * A browser cannot see the account name the computer knows its user by (no API
 * exposes it, deliberately), and the tree names itself better than the machine
 * would anyway. Returns null when no surname is on offer — an empty file, or
 * given names only — leaving the placeholder in place.
 */
export function newFileBase(dataset: Dataset, homeId?: string): string | null {
  const home = homeId ? dataset.individuals.get(homeId) : undefined;
  const person = home ?? dataset.individuals.values().next().value;
  const surname = person?.names[0]?.surname?.trim();
  if (!surname || isUnknownNameToken(surname)) return null;
  const safe = surname.normalize("NFC").replace(UNSAFE_IN_FILENAME, "-").replace(/^-+|-+$/g, "");
  return safe || null;
}

/**
 * The skeleton of a brand-new, empty GEDCOM — what "Start a new file" hands to
 * the ordinary load path, so a user with no file of their own can begin from
 * the first person instead of having to import something first.
 *
 * Deliberately minimal: a header naming GED Merge as the writing system,
 * 5.5.1 / UTF-8 (the pair most other genealogy programs read without
 * complaint), the submitter record 5.5.1 requires, and the trailer. The
 * submitter carries the reader's name, e-mail and website from Settings, or
 * the program's name when none is set ({@link submitterFields}) — the same record a save gives a
 * 5.5.1 file that has none. Saved later as 7.0, where a submitter is
 * optional, the record stays.
 */
export function newGedcomText(date: Date = new Date(), author?: Submitter): string {
  return [
    "0 HEAD",
    "1 SOUR GEDMERGE",
    "2 NAME GED Merge",
    `2 VERS ${__APP_VERSION__}`,
    `1 DATE ${todayGedcom(date)}`,
    "1 SUBM @U1@",
    "1 GEDC",
    "2 VERS 5.5.1",
    "2 FORM LINEAGE-LINKED",
    "1 CHAR UTF-8",
    "0 @U1@ SUBM",
    ...submitterFields(author).map(([tag, value]) => `1 ${tag} ${value}`),
    "0 TRLR",
    "",
  ].join("\n");
}
