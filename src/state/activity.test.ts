import { describe, expect, it } from "vitest";
import { activitySnapshot, trackActivity, watchActivity } from "./activity";
import { createThrottledQueue } from "../geo/net";

describe("activity", () => {
  it("counts work until it settles, failed or not", async () => {
    let seen = 0;
    const stop = watchActivity(() => seen++);
    let resolve!: () => void;
    let reject!: (e: Error) => void;
    const a = trackActivity("sources", new Promise<void>((r) => (resolve = r)));
    const b = trackActivity("sources", new Promise<void>((_, r) => (reject = r)));
    expect(activitySnapshot().sources).toEqual({ active: 2, total: 2 });
    resolve();
    reject(new Error("x"));
    await a;
    await b.catch(() => undefined);
    await Promise.resolve();
    expect(activitySnapshot().sources).toEqual({ active: 0, total: 0 });
    expect(seen).toBe(4);
    stop();
  });

  it("counts a throttled queue's waiting and running tasks", async () => {
    const enqueue = createThrottledQueue(0, { activity: "addresses" });
    const one = enqueue(async () => 1);
    const two = enqueue(async () => 2);
    expect(activitySnapshot().addresses).toEqual({ active: 2, total: 2 });
    await one;
    await Promise.resolve();
    // One of two done: the run remembers its size until it is over.
    expect(activitySnapshot().addresses).toEqual({ active: 1, total: 2 });
    await two;
    await Promise.resolve();
    expect(activitySnapshot().addresses).toEqual({ active: 0, total: 0 });
  });
});
