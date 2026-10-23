// An event's time of day rides in the date field, after the date: "5 MAR 1850
// 14:30". The file keeps them apart, as GEDCOM does — the time in a TIME line
// under the DATE — so the field's text is split on the way in and joined on
// the way out. Times are 24-hour, written hh:mm[:ss], zero-padded as GEDCOM 7
// requires (5.5.1 reads the same form).

const TRAILING_TIME = /^(.*?)\s*\b(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

const pad = (n: string) => n.padStart(2, "0");

/** The field's text cut into the date and, when it ends in a valid 24-hour
 *  time, that time ("14:30", "09:05:30"). An invalid time (25:00) stays in
 *  the date part, where the date field reports it as unreadable. */
export function splitDateTime(text: string): { date: string; time?: string } {
  const trimmed = text.trim();
  const m = trimmed.match(TRAILING_TIME);
  if (!m) return { date: trimmed };
  const [, date, h, min, s] = m;
  if (+h > 23 || +min > 59 || (s !== undefined && +s > 59)) return { date: trimmed };
  return { date: date.trim(), time: [pad(h), min, ...(s !== undefined ? [s] : [])].join(":") };
}

/** The field's text for a date and its time. */
export function joinDateTime(date: string, time: string | undefined): string {
  return time ? (date ? `${date} ${time}` : time) : date;
}
