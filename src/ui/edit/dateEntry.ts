import { isApproximate } from "../../gedcom/lifespan";
import type { DateOrder } from "../../gedcom/types";
import { entryDate, isReadable, parseTypedDate, type TypedDateOptions } from "../../normalize/date";
import { narrativeLangFor } from "../../report/narrativeText";
import type { DateEntryStyle } from "./DateEntryContext";

/** What the date field says under itself while a date is being typed. */
export type DatePreview =
  | { kind: "unreadable" }
  | {
      kind: "ok" | "impossible";
      /** The date in words, in the reader's language ("about 5 May 1848"). */
      label: string;
      approx: boolean;
      /** The value that will be written, when it differs from what was typed. */
      saved?: string;
      /** The other reading of a numeric date whose day and month could swap. */
      swap?: { label: string; saved: string };
    };

/**
 * How a typed date reads and what it will be written as. A numeric date with
 * both of its first numbers 12 or under (`5.6.1850`) is read in the file's
 * order, and the other reading is offered beside it, since a slip there moves
 * the date by months without anything looking wrong.
 */
export function previewDate(typed: string, style: DateEntryStyle, lang: string, opts?: TypedDateOptions): DatePreview {
  const raw = typed.trim();
  const d = parseTypedDate(raw, style.order, opts);
  if (!isReadable(d)) return { kind: "unreadable" };
  const words = narrativeLangFor(lang);
  const saved = entryDate(raw, style.profile, style.order, opts);
  const preview: DatePreview = {
    kind: d.impossible ? "impossible" : "ok",
    label: words.dateLabel(d),
    approx: isApproximate(d),
    ...(saved !== raw ? { saved } : {}),
  };
  // The order only ever decides a numeric date, so a month word, a year-first
  // value or a day over 12 reads the same both ways and offers nothing.
  const other: DateOrder = style.order === "MDY" ? "DMY" : "MDY";
  const alt = parseTypedDate(raw, other);
  if (!alt.impossible && alt.day !== undefined && (alt.day !== d.day || alt.month !== d.month)) {
    preview.swap = { label: words.dateLabel(alt), saved: entryDate(raw, style.profile, other) };
  }
  return preview;
}
