import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "../testing/fakeReact";
import { sliced, type BuildSteps } from "../tools/sliced";
import { useSlicedBuild } from "./useSlicedBuild";

vi.mock("react", () => import("../testing/fakeReact"));

/** A build that takes its time: each step outlasts any slice. */
function* slow(progress: number[]): BuildSteps<string> {
  for (const p of progress) {
    const until = performance.now() + 50;
    while (performance.now() < until) { /* busy */ }
    yield p;
  }
  return "done";
}

describe("useSlicedBuild", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("window", globalThis);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("hands out the result of a build that fits the first slice at once", () => {
    const { result } = renderHook(() => useSlicedBuild(() => sliced(slow([])), []));
    expect(result.current).toEqual({ result: "done", progress: 1 });
  });

  it("reports progress, then the result", () => {
    const { result } = renderHook(() => useSlicedBuild(() => sliced(slow([0.25, 0.5, 0.75])), []));
    expect(result.current).toEqual({ result: undefined, progress: 0.25 });
    vi.advanceTimersByTime(0);
    expect(result.current.progress).toBe(0.5);
    vi.runAllTimers();
    expect(result.current).toEqual({ result: "done", progress: 1 });
  });

  it("shows the result of a build that reported 100 % a step before its end", () => {
    const { result } = renderHook(() => useSlicedBuild(() => sliced(slow([0.5, 1, 1])), []));
    vi.runAllTimers();
    expect(result.current).toEqual({ result: "done", progress: 1 });
  });

  it("stops a build that is no longer wanted", () => {
    const steps = slow([0.2, 0.4, 0.6, 0.8]);
    const next = vi.spyOn(steps, "next");
    const { unmount } = renderHook(() => useSlicedBuild(() => sliced(steps), []));
    unmount();
    const calls = next.mock.calls.length;
    vi.runAllTimers();
    expect(next.mock.calls.length).toBe(calls);
  });
});
