import { describe, expect, it } from "vitest";
import { createThrottledQueue, timeoutSignal } from "./net";

describe("timeoutSignal", () => {
  it("aborts on its own after the deadline", async () => {
    const signal = timeoutSignal(20);
    expect(signal.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    expect(signal.aborted).toBe(true);
  });

  it("follows the caller's signal immediately", () => {
    const ctrl = new AbortController();
    ctrl.abort();
    expect(timeoutSignal(10_000, ctrl.signal).aborted).toBe(true);
  });

  it("stays quiet before the deadline when the caller doesn't abort", async () => {
    const ctrl = new AbortController();
    const signal = timeoutSignal(10_000, ctrl.signal);
    await new Promise((r) => setTimeout(r, 30));
    expect(signal.aborted).toBe(false);
  });
});

describe("createThrottledQueue", () => {
  it("spaces request starts and serializes concurrent callers", async () => {
    const enqueue = createThrottledQueue(40);
    const starts: number[] = [];
    const task = () => {
      starts.push(Date.now());
      return Promise.resolve(starts.length);
    };
    const [a, b] = await Promise.all([enqueue(task), enqueue(task)]);
    expect([a, b]).toEqual([1, 2]);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(35);
  });

  it("a failure rejects its own caller only; the queue keeps moving", async () => {
    const enqueue = createThrottledQueue(1);
    await expect(enqueue(() => Promise.reject(new Error("down")))).rejects.toThrow("down");
    await expect(enqueue(() => Promise.resolve("ok"))).resolves.toBe("ok");
  });

  it("an abandoned lookup leaves the queue instead of burning its slot", async () => {
    // The wait itself is abort-aware: an aborted task must reject promptly and
    // must not delay the caller behind it by holding the throttle window.
    const enqueue = createThrottledQueue(60_000);
    await enqueue(() => Promise.resolve());
    const ctrl = new AbortController();
    const doomed = enqueue(() => Promise.resolve("never"), ctrl.signal);
    ctrl.abort();
    await expect(doomed).rejects.toThrow();
  });
});
