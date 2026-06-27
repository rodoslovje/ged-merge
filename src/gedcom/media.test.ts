import { describe, expect, it } from "vitest";
import { parseGedcom } from "./parser";
import { detectMediaMode } from "./media";

function records(text: string) {
  return parseGedcom(new TextEncoder().encode(text).buffer).records;
}

const HEAD = ["0 HEAD", "1 GEDC", "2 VERS 5.5.1"];

describe("detectMediaMode", () => {
  it("detects inline OBJE/FILE blocks", () => {
    const recs = records([
      ...HEAD,
      "0 @I1@ INDI",
      "1 OBJE",
      "2 FILE photo.jpg",
      "0 TRLR",
      "",
    ].join("\n"));
    expect(detectMediaMode(recs)).toBe("inline");
  });

  it("detects shared top-level OBJE referenced by a pointer", () => {
    const recs = records([
      ...HEAD,
      "0 @I1@ INDI",
      "1 OBJE @O1@",
      "0 @O1@ OBJE",
      "1 FILE photo.jpg",
      "0 TRLR",
      "",
    ].join("\n"));
    expect(detectMediaMode(recs)).toBe("shared");
  });

  it("falls back to shared when the file has no photos", () => {
    const recs = records([...HEAD, "0 @I1@ INDI", "1 NAME A /B/", "0 TRLR", ""].join("\n"));
    expect(detectMediaMode(recs)).toBe("shared");
  });

  it("goes by the majority style when mixed", () => {
    const recs = records([
      ...HEAD,
      "0 @I1@ INDI",
      "1 OBJE",
      "2 FILE a.jpg",
      "0 @I2@ INDI",
      "1 OBJE",
      "2 FILE b.jpg",
      "0 @I3@ INDI",
      "1 OBJE @O1@",
      "0 @O1@ OBJE",
      "1 FILE c.jpg",
      "0 TRLR",
      "",
    ].join("\n"));
    expect(detectMediaMode(recs)).toBe("inline");
  });
});
