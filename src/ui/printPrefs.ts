// The paper a print last went on, per kind of print (a diagram, each calendar
// format). Kept in localStorage like the media-folder choices: it is about the
// printer beside this browser, not about the file or the settings.

const KEY = "printPaper";

function read(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** What was last printed with in `slot`, over `fallback` for anything missing.
 *  The caller checks the values: a stored one may be from an older version. */
export function loadPrintPrefs<T extends object>(slot: string, fallback: T): T {
  const stored = read()[slot];
  return stored && typeof stored === "object" ? { ...fallback, ...stored } : fallback;
}

export function savePrintPrefs(slot: string, prefs: object) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...read(), [slot]: prefs }));
  } catch {
    // Storage full or blocked: the next print simply starts from the default.
  }
}
