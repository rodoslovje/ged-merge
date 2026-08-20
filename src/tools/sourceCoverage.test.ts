import { describe, expect, it } from "vitest";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import { normalizeSourceCoverage } from "./sourceReshape";

function records(lines: string[]) {
  return parseGedcom(new TextEncoder().encode(lines.join("\n")).buffer).records;
}

// The pass that puts a file's sources in one shape. Converting the flat
// PLAC/DATE into the standard's DATA > EVEN is the visible half; moving the
// archive's id from the source's FILN onto the repository link's CALN — the
// standard's own spot for it — is the other.
describe("normalizeSourceCoverage → standard", () => {
  it("restates a flat source and moves its filing number", () => {
    const recs = records([
      "0 HEAD", "1 CHAR UTF-8",
      "0 @S1@ SOUR",
      "1 TITL Krstna knjiga / Taufbuch - 02329 | Stara Loka",
      "1 PLAC Stara Loka",
      "1 DATE 1790-1803",
      "1 FILN 02329",
      "1 REPO @R1@",
      "0 @R1@ REPO", "1 NAME Nadškofijski arhiv Ljubljana",
      "0 TRLR",
    ]);
    const { changed } = normalizeSourceCoverage(recs, "standard", "BIRT");
    const text = serializeGedcom(recs);
    expect(changed).toBe(1);
    expect(text).toMatch(/1 DATA\n2 EVEN BIRT/);
    expect(text).toMatch(/1 REPO @R1@\n2 CALN 02329/);
    expect(text).not.toContain("1 FILN");
  });

  it("moves the filing number of a source that is already standard", () => {
    // What an earlier run (or another program) leaves: coverage already in the
    // standard shape, the id still in the vendor field. The pass used to skip
    // this source outright — "already standard" — so nothing ever moved its
    // filing number, and Normalize offered no work on a file full of them.
    const recs = records([
      "0 HEAD", "1 CHAR UTF-8",
      "0 @S1@ SOUR",
      "1 TITL Krstna knjiga / Taufbuch - 02329 | Stara Loka",
      "1 DATA",
      "2 EVEN BIRT",
      "3 DATE FROM 1790 TO 1803",
      "3 PLAC Stara Loka",
      "1 FILN 02329",
      "1 REPO @R1@",
      "0 @R1@ REPO", "1 NAME Nadškofijski arhiv Ljubljana",
      "0 TRLR",
    ]);
    const { changed, examples } = normalizeSourceCoverage(recs, "standard", "BIRT");
    const text = serializeGedcom(recs);
    expect(changed).toBe(1);
    expect(examples[0]).toEqual({ before: "FILN 02329", after: "CALN 02329" });
    expect(text).toMatch(/1 REPO @R1@\n2 CALN 02329/);
    expect(text).not.toContain("1 FILN");
    // The coverage it already had is left exactly as it was.
    expect(text).toMatch(/1 DATA\n2 EVEN BIRT\n3 DATE FROM 1790 TO 1803\n3 PLAC Stara Loka/);
  });

  it("leaves a filing number with nowhere to go", () => {
    // No repository link means no repository citation to carry a call number.
    const recs = records([
      "0 HEAD", "1 CHAR UTF-8",
      "0 @S1@ SOUR",
      "1 TITL Krstna knjiga",
      "1 DATA", "2 EVEN BIRT", "3 PLAC Stara Loka",
      "1 FILN 02329",
      "0 TRLR",
    ]);
    const { changed } = normalizeSourceCoverage(recs, "standard", "BIRT");
    expect(changed).toBe(0);
    expect(serializeGedcom(recs)).toContain("1 FILN 02329");
  });

  it("says nothing twice: a second run has no work left", () => {
    const recs = records([
      "0 HEAD", "1 CHAR UTF-8",
      "0 @S1@ SOUR",
      "1 TITL Krstna knjiga / Taufbuch - 02329 | Stara Loka",
      "1 PLAC Stara Loka",
      "1 FILN 02329",
      "1 REPO @R1@",
      "0 @R1@ REPO", "1 NAME Nadškofijski arhiv Ljubljana",
      "0 TRLR",
    ]);
    expect(normalizeSourceCoverage(recs, "standard", "BIRT").changed).toBe(1);
    expect(normalizeSourceCoverage(recs, "standard", "BIRT").changed).toBe(0);
  });
});

describe("normalizeSourceCoverage → vendor", () => {
  it("flattens DATA > EVEN coverage into the program fields", () => {
    const recs = records([
      "0 HEAD", "1 CHAR UTF-8",
      "0 @S1@ SOUR",
      "1 TITL Krstna knjiga",
      "1 DATA",
      "2 AGNC Nadškofijski arhiv",
      "2 EVEN BIRT",
      "3 DATE FROM 1790 TO 1803",
      "3 PLAC Stara Loka",
      "0 TRLR",
    ]);
    const { changed } = normalizeSourceCoverage(recs, "vendor", "BIRT");
    const text = serializeGedcom(recs);
    expect(changed).toBe(1);
    expect(text).toContain("1 PLAC Stara Loka");
    expect(text).toContain("1 AGNC Nadškofijski arhiv");
    expect(text).not.toContain("1 DATA");
  });

  it("leaves a record whose flat AGNC disagrees with its DATA > AGNC untouched", () => {
    const lines = [
      "0 HEAD", "1 CHAR UTF-8",
      "0 @S1@ SOUR",
      "1 TITL Krstna knjiga",
      "1 AGNC Župnijski urad",
      "1 DATA",
      "2 AGNC Nadškofijski arhiv",
      "2 EVEN BIRT",
      "3 PLAC Stara Loka",
      "0 TRLR",
    ];
    const recs = records(lines);
    const before = serializeGedcom(recs);
    // The disagreement is not this pass's to settle — deleting the DATA > AGNC
    // would silently erase one of the two claims.
    expect(normalizeSourceCoverage(recs, "vendor", "BIRT").changed).toBe(0);
    expect(serializeGedcom(recs)).toBe(before);
  });

  it("leaves a record whose EVEN carries more than DATE/PLAC untouched", () => {
    const recs = records([
      "0 HEAD", "1 CHAR UTF-8",
      "0 @S1@ SOUR",
      "1 TITL Krstna knjiga",
      "1 DATA",
      "2 EVEN BIRT",
      "3 DATE FROM 1790 TO 1803",
      "3 NOTE prepisano iz izvirnika",
      "0 TRLR",
    ]);
    const before = serializeGedcom(recs);
    expect(normalizeSourceCoverage(recs, "vendor", "BIRT").changed).toBe(0);
    expect(serializeGedcom(recs)).toBe(before);
  });
});
