import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "../testing/fakeReact";
import type { WorkerResponse } from "../worker/messages";
import { useGedcomWorker } from "./useGedcomWorker";

vi.mock("react", () => import("../testing/fakeReact"));

/** A stand-in for the browser's Worker: records every instance so a test can
 *  fire its handlers as the real one would. */
class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage() {}
  terminate() {
    this.terminated = true;
  }
  emit(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

afterEach(() => {
  FakeWorker.all = [];
  vi.unstubAllGlobals();
});

describe("useGedcomWorker", () => {
  it("ignores a message from a worker that reset replaced", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const seen: WorkerResponse[] = [];
    const failures: string[] = [];
    const h = renderHook(() => useGedcomWorker((msg) => seen.push(msg), (m) => failures.push(m)));
    const first = FakeWorker.all[0];
    const before = { type: "matching" } as unknown as WorkerResponse;
    first.emit(before);
    expect(seen).toEqual([before]);

    h.result.current.reset();
    const second = FakeWorker.all[1];
    expect(first.terminated).toBe(true);
    // The old worker's queued message (and error) land after the reset.
    first.emit({ type: "matched" });
    first.onerror?.({ message: "late" } as ErrorEvent);
    expect(seen).toEqual([before]);
    expect(failures).toEqual([]);

    const fresh = { type: "matched" } as unknown as WorkerResponse;
    second.emit(fresh);
    expect(seen).toEqual([before, fresh]);
    h.unmount();
  });
});
