import { describe, it, expect } from "vitest";
import { dateStamp, baseStem, savedName } from "./download";

describe("dateStamp", () => {
  it("formats a date as zero-padded YYYY-MM-DD", () => {
    expect(dateStamp(new Date(2026, 6, 5))).toBe("2026-07-05"); // month is 0-based
    expect(dateStamp(new Date(2026, 11, 31))).toBe("2026-12-31");
  });
});

describe("baseStem", () => {
  it("strips a plain .ged extension", () => {
    expect(baseStem("Smith-tree.ged")).toBe("Smith-tree");
    expect(baseStem("Smith-tree.GED")).toBe("Smith-tree");
  });

  it("leaves a name without extension untouched", () => {
    expect(baseStem("Smith-tree")).toBe("Smith-tree");
  });

  it("strips a prior dated save so stamps do not stack", () => {
    expect(baseStem("Smith-tree.2026-07-22.gedmerge.ged")).toBe("Smith-tree");
  });

  it("strips a prior undated .gedmerge save", () => {
    expect(baseStem("Smith-tree.gedmerge.ged")).toBe("Smith-tree");
  });

  it("keeps a dotted base that is not a GED Merge stamp", () => {
    expect(baseStem("family.tree.v2.ged")).toBe("family.tree.v2");
  });
});

describe("savedName", () => {
  it("builds the {base}.{date}.gedmerge.{ext} convention", () => {
    const d = new Date(2026, 6, 22);
    expect(savedName("Smith-tree.ged", "ged", d)).toBe("Smith-tree.2026-07-22.gedmerge.ged");
    expect(savedName("Smith-tree.ged", "report.txt", d)).toBe(
      "Smith-tree.2026-07-22.gedmerge.report.txt",
    );
  });

  it("re-stamps an already-saved file instead of stacking", () => {
    const d = new Date(2026, 6, 23);
    expect(savedName("Smith-tree.2026-07-22.gedmerge.ged", "ged", d)).toBe(
      "Smith-tree.2026-07-23.gedmerge.ged",
    );
  });
});
