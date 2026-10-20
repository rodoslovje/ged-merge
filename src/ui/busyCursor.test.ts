import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { holdBusyCursor, withBusyCursor } from "./busyCursor";

// No DOM here: a class set on a stub root and a frame that fires on a timer.
const classes = new Set<string>();
beforeEach(() => {
  classes.clear();
  vi.useFakeTimers();
  vi.stubGlobal("document", {
    documentElement: { classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) } },
  });
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => setTimeout(cb, 16));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("busy cursor", () => {
  it("comes down a paint after the last nested hold is released", async () => {
    const outer = holdBusyCursor();
    const inner = holdBusyCursor();
    expect(classes.has("app-busy")).toBe(true);
    inner();
    await vi.runAllTimersAsync();
    expect(classes.has("app-busy")).toBe(true);
    outer();
    outer(); // a second release of the same hold counts nothing
    expect(classes.has("app-busy")).toBe(true);
    await vi.runAllTimersAsync();
    expect(classes.has("app-busy")).toBe(false);
  });

  it("starts the work a paint after the cursor goes up, and ignores a second call meanwhile", async () => {
    const work = vi.fn(() => expect(classes.has("app-busy")).toBe(true));
    const first = withBusyCursor(work);
    const second = withBusyCursor(work);
    expect(work).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    await Promise.all([first, second]);
    expect(work).toHaveBeenCalledTimes(1);
    expect(classes.has("app-busy")).toBe(false);
  });

  it("takes the cursor down when the work throws", async () => {
    const run = withBusyCursor(() => { throw new Error("boom"); });
    const settled = run.catch((e: Error) => e.message);
    await vi.runAllTimersAsync();
    expect(await settled).toBe("boom");
    expect(classes.has("app-busy")).toBe(false);
  });
});
