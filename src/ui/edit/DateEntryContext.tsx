import { useEffect } from "react";
import type { Dataset, DateOrder } from "../../gedcom/types";
import type { DateFormatProfile } from "../../normalize/types";
import { inferDateProfile } from "../../normalize/profile";
import { applyDateOverrides, type FormatOverrides } from "../../normalize/formatOverrides";
import { dateFixContext } from "../../tools/fixDates";

// A typed date is written in the main file's own style, the way the date fix
// and Normalize file write one — wherever it is typed: an event row, a
// source's coverage in Organize sources, a media item in the viewer. Those
// forms sit in different parts of the tree (the media viewer above the whole
// app), so the main file is registered once, here, rather than handed down.
// Learning its style reads every date in the file, which is more than a page
// should pay up front: it is learned the first time a date is typed and kept
// for the file (a style does not drift with one edit).

export interface DateEntryStyle {
  /** The file's date style, with the Settings → GEDCOM choices applied. */
  profile: DateFormatProfile;
  /** Which number is the day in a typed `5.6.1850`: the file's own habit. */
  order: DateOrder;
}

/** Before a file is in: standard GEDCOM, day first. */
const STANDARD: DateEntryStyle = { profile: inferDateProfile([]), order: "DMY" };

let source: { dataset: Dataset; overrides: Pick<FormatOverrides, "date" | "datePlaceholder"> } | null = null;
let learned: DateEntryStyle | undefined;

/** The style a date typed now is written in. */
export function dateEntryStyle(): DateEntryStyle {
  if (!source) return STANDARD;
  if (!learned) {
    const ctx = dateFixContext(source.dataset);
    const profile = applyDateOverrides(ctx.profile, source.overrides);
    // A chosen numeric pattern says outright which number is the day.
    const chosen = profile.numeric?.order;
    learned = { profile, order: chosen && chosen !== "YMD" ? chosen : ctx.sourceOrder };
  }
  return learned;
}

/** Register the main file whose style typed dates follow (null: none loaded). */
export function useDateEntrySource(dataset: Dataset | null | undefined, overrides: FormatOverrides): void {
  const { date, datePlaceholder } = overrides;
  useEffect(() => {
    source = dataset ? { dataset, overrides: { date, datePlaceholder } } : null;
    learned = undefined;
  }, [dataset, date, datePlaceholder]);
}

/** For the date field: the getter it calls when a date is typed. */
export function useDateEntryStyle(): () => DateEntryStyle {
  return dateEntryStyle;
}
