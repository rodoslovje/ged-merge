import { describe, expect, it } from "vitest";
import { clearTextCaches, GIVEN_TOKEN_CACHE_MAX, givenTokens } from "./text";

describe("givenTokens", () => {
  it("folds and splits a given name, memoized until the caches are cleared", () => {
    const first = givenTokens("Janez  Krstnik Čop");
    expect(first).toEqual(["janez", "krstnik", "cop"]);
    expect(givenTokens("Janez  Krstnik Čop")).toBe(first);
    clearTextCaches();
    const again = givenTokens("Janez  Krstnik Čop");
    expect(again).toEqual(first);
    expect(again).not.toBe(first);
  });

  it("empties its cache once it reaches the bound", () => {
    clearTextCaches();
    const first = givenTokens("name0");
    for (let i = 1; i < GIVEN_TOKEN_CACHE_MAX; i++) givenTokens(`name${i}`);
    // Still cached: the cache holds exactly the bound.
    expect(givenTokens("name0")).toBe(first);
    // One more spelling refills it from empty.
    givenTokens("one more");
    expect(givenTokens("name0")).not.toBe(first);
    clearTextCaches();
  });
});
