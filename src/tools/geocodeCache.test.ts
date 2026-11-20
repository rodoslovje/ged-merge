import { describe, expect, it, vi } from "vitest";
import * as place from "../gedcom/place";
import { isRegisterAddress, REGISTER_ADDRESS_CACHE_MAX } from "./geocode";

// The real decomposition, counted: a call is a cache miss.
vi.mock("../gedcom/place", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gedcom/place")>();
  return { ...actual, decomposePlace: vi.fn(actual.decomposePlace) };
});

describe("isRegisterAddress cache", () => {
  it("answers a value once, and refills from empty at its bound", () => {
    const decompose = vi.mocked(place.decomposePlace);
    expect(isRegisterAddress("Črni vrh 35")).toBe(true);
    expect(isRegisterAddress("Ljubljana")).toBe(false);
    const misses = decompose.mock.calls.length;
    isRegisterAddress("Črni vrh 35");
    expect(decompose.mock.calls.length).toBe(misses);

    // Fill the cache to its bound; the first value is still cached.
    for (let i = 2; i < REGISTER_ADDRESS_CACHE_MAX; i++) isRegisterAddress(`Kraj ${i}`);
    decompose.mockClear();
    isRegisterAddress("Črni vrh 35");
    expect(decompose).not.toHaveBeenCalled();
    // One more value empties it, so the first is answered afresh — the same way.
    isRegisterAddress("one more");
    decompose.mockClear();
    expect(isRegisterAddress("Črni vrh 35")).toBe(true);
    expect(decompose).toHaveBeenCalled();
    // Fills the cache to its bound: seconds of work, which a busy machine stretches past the
    // 5 s default — it timed out in full runs that had nothing wrong with them.
  }, 30_000);
});
