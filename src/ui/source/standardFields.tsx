import { useEffect, type Dispatch, type SetStateAction } from "react";
import type { GedNode } from "../../gedcom/types";
import { keepsFlatCoverage, keepsSourceTag, titleWithPeriodical, writesIdAsCallNumber } from "../../gedcom/edit";
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
 * `PERI` and `FILN` are the file's own lines where they are offered at all:
 * elsewhere the periodical joins the title and the id is a call number (see
 * {@link periodicalOffered}, {@link idField}). A source's `PLAC` and
 * `AGNC` are only extensions where the file writes them flat: the standard
 * states both inside `DATA > EVEN`, which is exactly what a standard-coverage
 * file does, and there the same two fields are the spec's own.
 */
export function nonStandardTag(
  key: SourceFieldKey,
  coverage: "vendor" | "standard",
): string | undefined {
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
 * `hasRepo` is false where the source will hang off no repository at all.
 * The standard's form keeps the call number even then, on a link to no
 * repository; a file that writes its own `FILN` falls back to it there.
 */
export function idField(
  records: GedNode[],
  coverage: "vendor" | "standard",
  hasRepo = true,
  standard?: "5.5.1" | "7.0",
): { labelKey: string; nonStandard: string | undefined; caln: boolean } {
  const caln = (hasRepo || !keepsSourceTag(records, "FILN", { standard })) && writesIdAsCallNumber(records, coverage, { standard });
  return {
    labelKey: caln ? "addSource.field.caln" : "addSource.field.filingNumber",
    // A call number is written on the source's repository link, so a dialog
    // puts the field beside the repository rather than among the source's own.
    nonStandard: caln ? undefined : nonStandardTag("filingNumber", coverage),
    caln,
  };
}

/** Whether a source form offers the periodical as a field of its own: only
 *  where the file keeps its `PERI` lines — elsewhere it is part of the title. */
export function periodicalOffered(records: GedNode[], standard?: "5.5.1" | "7.0"): boolean {
  return keepsSourceTag(records, "PERI", { standard });
}

/**
 * Whether a source form offers the place and the years a source covers. The
 * standard states them only inside `DATA › EVEN`, under the register the
 * source covers: where the source has that block, or its register is known,
 * they are the standard's own fields. Elsewhere they would stand flat on the
 * record, which only a file kept with its variations that already writes them
 * so keeps.
 */
export function coverageFieldsOffered(records: GedNode[], standard: "5.5.1" | "7.0" | undefined, statesCoverage: boolean): boolean {
  return statesCoverage || keepsFlatCoverage(records, { standard });
}

/** Where the form offers no periodical, one a paste or a lookup proposed
 *  joins the title as soon as it arrives — where the save writes it, so the
 *  reader sees it there first. */
export function useTitleTakesPeriodical<T extends { title: string; periodical: string }>(
  offered: boolean,
  periodical: string,
  setFields: Dispatch<SetStateAction<T>>,
): void {
  useEffect(() => {
    if (offered || !periodical.trim()) return;
    setFields((f) => foldPeriodical(f, offered));
  }, [offered, periodical, setFields]);
}

/** The fold {@link useTitleTakesPeriodical} makes, for a form that is not on
 *  screen (an Add written once its lookup answers): the periodical joins the
 *  title where the form offers no periodical of its own. */
export function foldPeriodical<T extends { title: string; periodical: string }>(f: T, offered: boolean): T {
  if (offered || !f.periodical.trim()) return f;
  return { ...f, title: titleWithPeriodical(f.title, f.periodical) ?? "", periodical: "" };
}
