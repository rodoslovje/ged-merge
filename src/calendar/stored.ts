import { rememberTarget, targetFileKey } from "../normalize/target";

/**
 * The family calendar's work, remembered per main file and recipient while the
 * reader keeps their workspace in the browser (Settings → "local browser
 * data"), as the website tool remembers its choices: the settings, the pictures
 * and the picked moments — a present put together over several evenings. A
 * picture of one's own (a file picked from the computer) cannot be kept; the
 * caller leaves those out. With that setting off nothing is kept.
 */

const KEY = "gedmerge.calendar";

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function readAll(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const entryKey = (fileName: string, rootId: string) => `${targetFileKey(fileName)} ${rootId}`;

/** The calendar kept for this file and recipient, as stored — the caller
 *  checks each field — or undefined. */
export function readSavedCalendar(fileName: string, rootId: string): Record<string, unknown> | undefined {
  const entry = readAll()[entryKey(fileName, rootId)];
  return isRecord(entry) ? entry : undefined;
}

export function writeSavedCalendar(fileName: string, rootId: string, value: Record<string, unknown>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(rememberTarget<unknown>(readAll(), entryKey(fileName, rootId), value)));
  } catch {
    // Storage full or blocked: the work lasts for this visit.
  }
}

/** Forget every calendar — the workspace is no longer kept. */
export function clearSavedCalendars(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to forget where nothing could be kept.
  }
}
