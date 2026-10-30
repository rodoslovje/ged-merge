// "Later" on a notice strip puts it away for a week rather than for this
// load only. Kept in localStorage like the media-folder choices: it is about
// this browser's notices, not about the file or the settings.

const KEY = "noticeSnoozedUntil";
export const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

function read(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** Whether the notice `key` was answered with Later less than a week ago. */
export function noticeSnoozed(key: string, now = Date.now()): boolean {
  const until = read()[key];
  return typeof until === "number" && until > now;
}

/** Put the notice `key` away for a week; expired entries are dropped. */
export function snoozeNotice(key: string, now = Date.now()) {
  const kept = Object.entries(read()).filter(([, until]) => typeof until === "number" && until > now);
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...Object.fromEntries(kept), [key]: now + SNOOZE_MS }));
  } catch {
    // Storage full or blocked: the notice simply comes back next load.
  }
}
