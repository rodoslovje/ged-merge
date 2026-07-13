import { describe, expect, it } from "vitest";
import { parseGedcom } from "./parser";
import { collectMediaRefs, detectMediaMode, mediaNodeAt } from "./media";

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

describe("collectMediaRefs", () => {

  const TEXT = [
    ...HEAD,
    "0 @I1@ INDI",
    "1 NAME Janez /Novak/",
    "1 OBJE",
    "2 FILE portrait.jpg",
    "3 TITL Portrait",
    "1 BIRT",
    "2 DATE 1 JAN 1900",
    "2 OBJE @O1@",
    "1 RESI",
    "1 RESI",
    "2 OBJE",
    "3 FILE house.jpg",
    "1 SOUR @S1@",
    "2 OBJE",
    "3 FILE scan.jpg",
    "0 @O1@ OBJE",
    "1 FILE christening.jpg",
    "0 @S1@ SOUR",
    "1 TITL Book",
    "0 TRLR",
    "",
  ].join("\n");

  it("collects record-level and event-level media with addresses", () => {
    const recs = records(TEXT);
    const indi = recs.find((r) => r.xref === "@I1@")!;
    const refs = collectMediaRefs(indi, recs);
    expect(refs.map((r) => r.file)).toEqual(["portrait.jpg", "christening.jpg", "house.jpg"]);
    // Record-level ref has no event address.
    expect(refs[0].objeIndex).toBe(0);
    expect(refs[0].eventTag).toBeUndefined();
    // Pointer OBJE under BIRT resolves through the shared record and keeps its xref.
    expect(refs[1]).toMatchObject({ eventTag: "BIRT", eventIndex: 0, objeIndex: 0, xref: "@O1@" });
    // Second RESI: eventIndex counts same-tag siblings, including the empty first one.
    expect(refs[2]).toMatchObject({ eventTag: "RESI", eventIndex: 1, objeIndex: 0 });
  });

  it("skips media under SOUR citations (it belongs to the source)", () => {
    const recs = records(TEXT);
    const indi = recs.find((r) => r.xref === "@I1@")!;
    const refs = collectMediaRefs(indi, recs);
    expect(refs.some((r) => r.file === "scan.jpg")).toBe(false);
  });

  it("mediaNodeAt resolves each collected address back to its OBJE node", () => {
    const recs = records(TEXT);
    const indi = recs.find((r) => r.xref === "@I1@")!;
    for (const ref of collectMediaRefs(indi, recs)) {
      const node = mediaNodeAt(indi, ref);
      expect(node?.tag).toBe("OBJE");
    }
    expect(mediaNodeAt(indi, { eventTag: "BIRT", eventIndex: 0, objeIndex: 5 })).toBeUndefined();
    expect(mediaNodeAt(indi, { eventTag: "DEAT", eventIndex: 0, objeIndex: 0 })).toBeUndefined();
  });

  it("collects media on a FAM record and its MARR event", () => {
    const recs = records([
      ...HEAD,
      "0 @F1@ FAM",
      "1 OBJE",
      "2 FILE family.jpg",
      "1 MARR",
      "2 DATE 1920",
      "2 OBJE",
      "3 FILE wedding.jpg",
      "0 TRLR",
      "",
    ].join("\n"));
    const fam = recs.find((r) => r.xref === "@F1@")!;
    const refs = collectMediaRefs(fam, recs);
    expect(refs.map((r) => r.file)).toEqual(["family.jpg", "wedding.jpg"]);
    expect(refs[1]).toMatchObject({ eventTag: "MARR", eventIndex: 0, objeIndex: 0 });
  });
});

describe("vendor media metadata", () => {
  it("orders a _PRIM-marked photo first and _SEQ-numbered links in sequence", () => {
    const recs = records([
      ...HEAD,
      "0 @I1@ INDI",
      "1 NAME Ana /Novak/",
      "1 OBJE",
      "2 FILE third.jpg",
      "2 _SEQ 3",
      "1 OBJE",
      "2 FILE second.jpg",
      "2 _SEQ 2",
      "1 OBJE @O1@",
      "2 _PRIM Y",
      "0 @O1@ OBJE",
      "1 FILE primary.jpg",
      "0 TRLR",
      "",
    ].join("\n"));
    const indi = recs.find((r) => r.xref === "@I1@")!;
    expect(collectMediaRefs(indi, recs).map((r) => r.file)).toEqual(["primary.jpg", "second.jpg", "third.jpg"]);
  });

  it("honors webtrees _THUM on the shared record and reads MyHeritage _POSITION as a crop", () => {
    const recs = records([
      ...HEAD,
      "0 @I1@ INDI",
      "1 NAME Ana /Novak/",
      "1 OBJE",
      "2 FILE group.jpg",
      "2 _POSITION 185 5 643 616",
      "1 OBJE @O1@",
      "0 @O1@ OBJE",
      "1 FILE thumb.jpg",
      "1 _THUM Y",
      "0 TRLR",
      "",
    ].join("\n"));
    const indi = recs.find((r) => r.xref === "@I1@")!;
    const refs = collectMediaRefs(indi, recs);
    expect(refs.map((r) => r.file)).toEqual(["thumb.jpg", "group.jpg"]);
    expect(refs[1].crop).toEqual({ left: 185, top: 5, width: 458, height: 611 });
  });

  it("keeps a GEDCOM 7 CROP authoritative over _POSITION and folds _KEYS into the description", () => {
    const recs = records([
      ...HEAD,
      "0 @I1@ INDI",
      "1 OBJE",
      "2 FILE pic.jpg",
      "2 _POSITION 0 0 10 10",
      "2 CROP",
      "3 TOP 5",
      "3 LEFT 6",
      "3 WIDTH 100",
      "3 HEIGHT 120",
      "1 OBJE",
      "2 FILE card.jpg",
      "2 NOTE Razglednica",
      "2 _KEYS Krško, Koprivnik",
      "0 TRLR",
      "",
    ].join("\n"));
    const indi = recs.find((r) => r.xref === "@I1@")!;
    const refs = collectMediaRefs(indi, recs);
    expect(refs[0].crop).toEqual({ top: 5, left: 6, width: 100, height: 120 });
    expect(refs[1].description).toBe("Razglednica · Krško, Koprivnik");
  });
});
