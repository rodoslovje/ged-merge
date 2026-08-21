import { describe, expect, it } from "vitest";
import { isPointer, isWebAddress, looksLikeUrl } from "./uri";

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

// `isWebAddress` decides whether an ↗ is drawn at all, so it is stricter than
// `looksLikeUrl` (which only tells a URL from a filename) and more forgiving
// about the scheme: a title, a filing number or a scan's name each turn into
// "https://<text>" and a click that goes nowhere.
describe("isWebAddress", () => {
  it.each([
    ["https://www.sistory.si/ww1/168", true],
    ["www.example.com/scan", true],
    ["arhiv.si", true], // a bare host, which only wants a scheme
    ["gov.si/kje?id=3", true],
    ["example.co.uk:8080/x", true],
    ["Illinois, Cook County Marriages, 1871-1969", false], // a source's title
    ["1030102", false], // a filing number
    ["Nadškofijski arhiv Ljubljana", false], // a repository's name
    ["krst-1841.jpg", false], // a scan, not a host
    ["media/krst.jpg", false],
    ["C:\\photos\\scan.jpg", false],
    ["rodovnik.ged", false],
    ["", false],
    [undefined, false],
  ])("%j → %s", (value, expected) => {
    expect(isWebAddress(value)).toBe(expected);
  });
});
