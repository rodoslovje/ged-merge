import { describe, expect, it } from "vitest";
import { timeoutSignal } from "./net";

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
