/**
 * The progress cursor for slow main-thread actions — building the save
 * preview, a whole-file Tools pass, undoing one, the copy a Tools scan sends
 * its worker. A cursor change only shows once the browser paints, and a
 * synchronous action holds the very frame that would show it, so each way in
 * here puts the cursor up a paint *before* the work runs:
 *
 * - `withBusyCursor(work)` waits for that paint itself, for callers that can
 *   start their work a frame later;
 * - a button marked `data-busy-cursor` raises it on press: the browser paints
 *   between pointerdown and click, so the click's work runs under it;
 * - `holdBusyCursor()` for a caller already deferring its work behind a paint.
 *
 * Every hold comes down on the paint after the work, so the cursor stays until
 * the result is on screen.
 */

let holds = 0;

/** Resolves once the browser has painted the frame now being committed. */
export function afterPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

/** Raise the cursor; the returned release takes it down after the next paint.
 *  Holds nest — the cursor stays while any is held. */
export function holdBusyCursor(): () => void {
  if (holds++ === 0) document.documentElement.classList.add("app-busy");
  let released = false;
  return () => {
    if (released) return;
    released = true;
    void afterPaint().then(() => {
      if (--holds === 0) document.documentElement.classList.remove("app-busy");
    });
  };
}

let running = false;

/** Run `work` under the cursor, a paint after raising it. A call while another
 *  one is still running is ignored — it is the same press arriving twice. */
export async function withBusyCursor(work: () => unknown): Promise<void> {
  if (running) return;
  running = true;
  const release = holdBusyCursor();
  try {
    await afterPaint();
    await work();
  } finally {
    running = false;
    release();
  }
}

/** Wire `data-busy-cursor` buttons — once, at startup. */
export function installBusyCursorOnPress(): void {
  document.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const button = (e.target as Element | null)?.closest?.("[data-busy-cursor]");
    if (!button || (button as HTMLButtonElement).disabled) return;
    const release = holdBusyCursor();
    // pointerup comes before the click, but the release waits for a paint —
    // and the click's synchronous work runs before the browser can paint.
    const done = () => {
      document.removeEventListener("pointerup", done, true);
      document.removeEventListener("pointercancel", done, true);
      release();
    };
    document.addEventListener("pointerup", done, true);
    document.addEventListener("pointercancel", done, true);
  }, true);
}
