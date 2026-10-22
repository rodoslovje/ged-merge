import { createContext, useContext, useMemo } from "react";
import type { Dataset, DateOrder } from "../../gedcom/types";
import type { DateFormatProfile } from "../../normalize/types";
import { inferDateProfile } from "../../normalize/profile";
import { applyDateOverrides, type FormatOverrides } from "../../normalize/formatOverrides";
import { dateFixContext } from "../../tools/fixDates";

// A date typed into an event row is written in the file's own style, the way
// the date fix and Bulk normalize write one. Learning that style reads every
// date in the file, which is more than an edit should pay up front, so the
// Edit view hands its rows a getter that learns it the first time a date is
// typed and keeps it for the file (a style does not drift with one edit).

export interface DateEntryStyle {
  /** The file's date style, with the Settings → GEDCOM choices applied. */
  profile: DateFormatProfile;
  /** Which number is the day in a typed `5.6.1850`: the file's own habit. */
  order: DateOrder;
}

/** Outside the Edit view (and before a file is in): standard GEDCOM, day first. */
const STANDARD: DateEntryStyle = { profile: inferDateProfile([]), order: "DMY" };

const DateEntryContext = createContext<() => DateEntryStyle>(() => STANDARD);

export function DateEntryProvider({
  dataset,
  overrides,
  children,
}: {
  dataset: Dataset;
  overrides: FormatOverrides;
  children: React.ReactNode;
}) {
  const { date, datePlaceholder } = overrides;
  const get = useMemo(() => {
    let style: DateEntryStyle | undefined;
    return () => {
      if (!style) {
        const ctx = dateFixContext(dataset);
        const profile = applyDateOverrides(ctx.profile, { date, datePlaceholder });
        // A chosen numeric pattern says outright which number is the day.
        const chosen = profile.numeric?.order;
        style = { profile, order: chosen && chosen !== "YMD" ? chosen : ctx.sourceOrder };
      }
      return style;
    };
  }, [dataset, date, datePlaceholder]);
  return <DateEntryContext.Provider value={get}>{children}</DateEntryContext.Provider>;
}

export function useDateEntryStyle(): () => DateEntryStyle {
  return useContext(DateEntryContext);
}
