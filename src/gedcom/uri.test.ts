import { describe, expect, it } from "vitest";
import { isPointer, looksLikeUrl } from "./uri";

// These two predicates gate URL-vs-file decisions in objeInfoOf, the builder's
// link harvest, the edit layer's "never clobber a local scan" rule and
// serialize — a wrong answer misfiles a value everywhere at once.

describe("isPointer", () => {
  it.each([
    ["@I1@", true],
    ["@S123@", true],
    ["@abc-1@", true],
    ["@I1@ ", false], // trailing space — callers trim first
    ["I1", false],
    ["@@", false], // empty id
    ["@I@1@", false], // stray @ inside
    ["mailto:a@b.si", false],
    ["", false],
  ])("%j → %s", (value, expected) => {
    expect(isPointer(value)).toBe(expected);
  });
});

describe("looksLikeUrl", () => {
  it.each([
    ["https://example.com/a", true],
    ["http://example.com", true],
    ["HTTPS://EXAMPLE.COM/A", true],
    ["www.example.com/scan", true],
    ["krst-1841.jpg", false],
    ["media/krst.jpg", false],
    ["C:\\photos\\scan.jpg", false],
    ["ftp://example.com/a", false], // not a link the app can open in a chip
    ["see https://example.com", false], // mid-string is prose, not a link value
    ["", false],
  ])("%j → %s", (value, expected) => {
    expect(looksLikeUrl(value)).toBe(expected);
  });
});
