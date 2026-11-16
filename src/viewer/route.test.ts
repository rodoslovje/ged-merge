import { describe, expect, it } from "vitest";
import { nameMatches, parseRoute, routeHash, startRoute, type Route } from "./route";

describe("site routes", () => {
  it("round-trips every page through the hash", () => {
    const routes: Route[] = [
      { page: "home" },
      { page: "person", id: "p1x9k" },
      { page: "charts", id: "p1x9k" },
      { page: "stats" },
      { page: "stats", view: "names" },
    ];
    for (const r of routes) expect(parseRoute(routeHash(r))).toEqual(r);
  });

  it("reads an empty or unknown hash as the front page", () => {
    expect(parseRoute("")).toEqual({ page: "home" });
    expect(parseRoute("#/nowhere")).toEqual({ page: "home" });
    expect(parseRoute("#/p/")).toEqual({ page: "home" });
  });

  it("lands a visit without an address on the author's start page", () => {
    expect(startRoute(undefined, "p1")).toEqual({ page: "home" });
    expect(startRoute("person", "p1")).toEqual({ page: "person", id: "p1" });
    expect(startRoute("charts", "p1")).toEqual({ page: "charts", id: "p1" });
    expect(startRoute("charts", undefined)).toEqual({ page: "home" });
    expect(startRoute("stats", undefined)).toEqual({ page: "stats" });
  });

  it("matches names by word starts, without accents", () => {
    expect(nameMatches("Jože Žnidaršič", "zni jo")).toBe(true);
    expect(nameMatches("Jože Žnidaršič", "daršič")).toBe(false);
    expect(nameMatches("Jože Žnidaršič", " ")).toBe(false);
  });
});
