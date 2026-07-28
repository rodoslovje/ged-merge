import { todayGedcom } from "./chanCrea";

/** Base name (without extension) of the file "Start a new file" creates. */
export const NEW_FILE_BASENAME = "new-tree";

/**
 * The skeleton of a brand-new, empty GEDCOM — what "Start a new file" hands to
 * the ordinary load path, so a user with no file of their own can begin from
 * the first person instead of having to import something first.
 *
 * Deliberately minimal: a header naming GED Merge as the writing system,
 * 5.5.1 / UTF-8 (the pair most other genealogy programs read without
 * complaint), and the trailer. No SUBM record — a submitter with no name is
 * noise in every downstream file, and nothing here requires one.
 */
export function newGedcomText(date: Date = new Date()): string {
  return [
    "0 HEAD",
    "1 SOUR GEDMERGE",
    "2 NAME GED Merge",
    `2 VERS ${__APP_VERSION__}`,
    `1 DATE ${todayGedcom(date)}`,
    "1 GEDC",
    "2 VERS 5.5.1",
    "2 FORM LINEAGE-LINKED",
    "1 CHAR UTF-8",
    "0 TRLR",
    "",
  ].join("\n");
}
