import type { GedNode } from "../../gedcom/types";
import { writesCallNumbers } from "../../gedcom/source";
import type { Translate } from "../../locales/i18n";

/**
 * The vocabulary every source editor shares — the Add Source dialog, the
 * Organize sources field editor, and whatever comes next. Two dialogs asking
 * for the same field must call it the same thing and mark it the same way, or
 * the reader learns two different files' worth of rules for one program.
 */

/** The fields a source form offers, as the GEDCOM lines they write. */
export type SourceFieldKey =
  | "title" | "author" | "periodical" | "publisher" | "agency" | "place" | "filingNumber" | "page" | "url" | "note";

/**
 * The GEDCOM line a field writes when the standard has no such line on a
 * source — so a dialog can say which of its fields your other programs may
 * not read back.
 *
 * `PERI` and `FILN` are extensions wherever they appear. A source's `PLAC` and
 * `AGNC` are only extensions where the file writes them flat: the standard
 * states both inside `DATA > EVEN`, which is exactly what a standard-coverage
 * file does, and there the same two fields are the spec's own.
 */
export function nonStandardTag(key: SourceFieldKey, coverage: "vendor" | "standard"): string | undefined {
  if (key === "periodical") return "PERI";
  if (key === "filingNumber") return "FILN";
  if (coverage === "standard") return undefined;
  if (key === "place") return "PLAC";
  if (key === "agency") return "AGNC";
  return undefined;
}

/** The muted mark beside such a field's label; the tooltip says what it is. */
export function NonStandard({ tag, t }: { tag: string | undefined; t: Translate }) {
  if (!tag) return null;
  return (
    <span className="add-source-nonstd" title={t("addSource.nonStandard", { tag })} aria-label={t("addSource.nonStandard", { tag })}>
      *
    </span>
  );
}

/**
 * What the archive's own id is called in this file, and whether the name is an
 * extension. One id belongs in one place — the repository link's call number
 * (the standard's spot) or the source's own filing number (what MacFamilyTree
 * and its kin read) — and `writesCallNumbers` says which this file uses. A
 * dialog that always said "Filing number" named a line the save would not even
 * write.
 *
 * `hasRepo` is false where the source will hang off no repository at all:
 * there is no call number without one, so the id falls back to the source's
 * own field whatever the file's habit.
 */
export function idField(
  records: GedNode[],
  coverage: "vendor" | "standard",
  hasRepo = true,
): { labelKey: string; nonStandard: string | undefined } {
  const caln = hasRepo && writesCallNumbers(records, coverage);
  return {
    labelKey: caln ? "addSource.field.caln" : "addSource.field.filingNumber",
    nonStandard: caln ? undefined : nonStandardTag("filingNumber", coverage),
  };
}
