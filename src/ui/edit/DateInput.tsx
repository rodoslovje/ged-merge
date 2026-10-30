import React, { forwardRef, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { parseDate } from "../../gedcom/date";
import { displayDate } from "../../gedcom/dateDisplay";
import { joinDateTime, splitDateTime } from "../../gedcom/dateTime";
import { isApproximate } from "../../gedcom/lifespan";
import { entryDate, isReadable } from "../../normalize/date";
import { narrativeLangFor } from "../../report/narrativeText";
import type { Translate } from "../../locales/i18n";
import { useSettingsSlice } from "../SettingsContext";
import { ClearableInput } from "./ClearableInput";
import { useDateEntryStyle } from "./DateEntryContext";
import { previewDate, type DatePreview } from "./dateEntry";

// The one date field, wherever a GEDCOM date is typed — an event row, a
// citation, a source's coverage, a media item. It reads a date as it is
// written by hand, says while it is typed how it reads and what will be
// written, writes it in the file's own style when it is left, shows the
// chosen date display while it is not being edited, and reads the date in
// words on hover. The host keeps the value; this only shapes it.

const DATE_DISPLAY_KEYS = ["dateDisplay"] as const;

type InputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "onBlur" | "title">;

export interface DateInputProps extends InputProps {
  /** The date as the file writes it. */
  value: string;
  onChange: (value: string) => void;
  /** Leaving the field, with the value as written — a typed date already in
   *  the file's style (the host has been handed it through `onChange` too). */
  onBlur?: (value: string) => void;
  /** Show the × that empties the field. */
  onClear?: () => void;
  /** What the field is, the first line of its hover ("Birth date"). */
  label?: string;
  /** Class of the element wrapping the field and its preview line. */
  wrapClassName?: string;
  /** The field holds a span of time (a source's coverage): "1850-1900" is
   *  written as the period FROM 1850 TO 1900. */
  period?: boolean;
  /** The value may end in a 24-hour time of day ("5 MAR 1850 14:30"): the
   *  date part is read and restyled, and the time rides along after it. */
  withTime?: boolean;
}

export const DateInput = forwardRef<HTMLInputElement, DateInputProps>(function DateInput(
  { value, onChange, onBlur, onClear, label, wrapClassName, period, withTime, className, onFocus, ...rest },
  ref,
) {
  const opts = period ? { period } : undefined;
  const { t, i18n } = useTranslation();
  const style = useDateEntryStyle();
  const { dateDisplay } = useSettingsSlice(DATE_DISPLAY_KEYS);
  const [focused, setFocused] = useState(false);
  // What the field held when it was entered: only a date typed since is
  // previewed and restyled — a value left as it was is the file's own.
  const atFocus = useRef(value);

  const { date, time } = withTime ? splitDateTime(value) : { date: value, time: undefined };
  const withT = (text: string) => joinDateTime(text, time);
  const parsed = date.trim() ? parseDate(date) : undefined;
  const preview =
    focused && value.trim() && value !== atFocus.current
      ? timedPreview(previewDate(date, style(), i18n.language, opts), date, time, value)
      : undefined;
  // At rest the field reads in the chosen date display; entered, it is the file's text.
  const shown = dateDisplay && !focused && parsed ? withT(displayDate(parsed)) : value;
  const words = parsed && isReadable(parsed) ? withT(narrativeLangFor(i18n.language).dateLabel(parsed)) : undefined;
  const hover = [label, words]
    .concat(shown !== value ? [value] : [])
    .filter((line, i, all): line is string => !!line && all.indexOf(line) === i && line !== shown)
    .join("\n");

  const approx = !!parsed && isApproximate(parsed);
  const inputProps = {
    ...rest,
    ref,
    className: (className ?? "") + (approx ? " is-approx" : ""),
    // Safari and Firefox size the Edit row from a field's `size`, not its CSS
    // width: an approximate date's slot may outgrow the default 20, and the
    // date would drop under its label. Generous, since a `size` counts
    // narrower characters than the monospace digits the field shows.
    size: approx ? Math.max(20, Math.ceil(shown.length * 1.6)) : rest.size,
    value: shown,
    title: hover || undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value),
    onFocus: (e: React.FocusEvent<HTMLInputElement>) => {
      atFocus.current = value;
      setFocused(true);
      onFocus?.(e);
    },
    onBlur: () => {
      setFocused(false);
      let written = value;
      if (value !== atFocus.current) {
        const s = style();
        written = withT(entryDate(date, s.profile, s.order, opts));
        if (written !== value) onChange(written);
      }
      onBlur?.(written);
    },
  };

  return (
    // An approximate date is set in italics and carries its qualifier, so it
    // runs longer than the slot sized for a plain date: the wrapper tells the
    // stylesheet its length (see `.is-approx` in index.css), and a slot that
    // is this wrapper sizes itself to it rather than cutting it short.
    <div
      className={"date-input" + (wrapClassName ? ` ${wrapClassName}` : "")}
      style={approx ? ({ "--date-chars": shown.length } as React.CSSProperties) : undefined}
    >
      {onClear ? (
        <ClearableInput {...inputProps} onClear={onClear} clearTitle={label} />
      ) : (
        <input {...inputProps} />
      )}
      {preview && <DatePreviewLine preview={preview} t={t} onSwap={onChange} />}
    </div>
  );
});

/** A date's preview with its time of day put back after it: the reading, the
 *  value to be written and the other reading all carry the time. */
function timedPreview(preview: DatePreview, date: string, time: string | undefined, typed: string): DatePreview {
  if (!time || preview.kind === "unreadable") return preview;
  const written = joinDateTime(preview.saved ?? date, time);
  return {
    ...preview,
    label: `${preview.label} ${time}`,
    saved: written !== typed.trim() ? written : undefined,
    swap: preview.swap && { label: `${preview.swap.label} ${time}`, saved: joinDateTime(preview.swap.saved, time) },
  };
}

/** The line under a date being typed: the date in words, what it will be
 *  written as, and — for a numeric date whose day and month could swap — the
 *  other reading, a click away. */
function DatePreviewLine({ preview, t, onSwap }: { preview: DatePreview; t: Translate; onSwap: (saved: string) => void }) {
  if (preview.kind === "unreadable") {
    return (
      <div className="edit-date-preview is-unreadable" role="status">
        <span className="edit-date-preview-label">{t("event.dateEntry.unreadable")}</span>
      </div>
    );
  }
  return (
    <div className={`edit-date-preview is-${preview.kind}`} role="status">
      <span className={"edit-date-preview-label" + (preview.approx ? " gm-approx" : "")}>{preview.label}</span>
      {preview.kind === "impossible" && <span className="edit-date-preview-warn"> · {t("event.dateEntry.impossible")}</span>}
      {preview.saved && <span className="gm-data"> · {t("event.dateEntry.savedAs", { value: preview.saved })}</span>}
      {preview.swap && (
        <button
          type="button"
          className="edit-date-preview-swap"
          title={t("event.dateEntry.swapTitle")}
          // Keep the focus in the field: a blur would write the first reading
          // and take this line away before the click lands.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onSwap(preview.swap!.saved)}
        >
          {t("event.dateEntry.swap", { value: preview.swap.label })}
        </button>
      )}
    </div>
  );
}
