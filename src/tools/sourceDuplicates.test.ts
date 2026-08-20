import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import { findSourceDuplicates, dedupeSources } from "./sourceDuplicates";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

/** All groups of a kind, sorted is already by the finder. */
function ofKind(text: string, kind: string) {
  return findSourceDuplicates(dataset(text)).groups.filter((g) => g.kind === kind);
}

describe("findSourceDuplicates — media", () => {
  it("groups OBJE records with the same URL (language/slash variants normalized)", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @O1@ OBJE
1 FILE https://data.matricula-online.eu/de/slovenia/parish/01/
0 @O2@ OBJE
1 FILE https://data.matricula-online.eu/sl/slovenia/parish/01
0 TRLR`);
    const media = findSourceDuplicates(ds).groups.filter((g) => g.kind === "media");
    expect(media).toHaveLength(1);
    expect(media[0].members.map((m) => m.xref).sort()).toEqual(["@O1@", "@O2@"]);
    expect(media[0].removable).toBe(1);
  });

  it("groups local media by bare filename, ignoring path and case", () => {
    const groups = ofKind(`0 HEAD
1 CHAR UTF-8
0 @O1@ OBJE
1 FILE media/Scan.JPG
0 @O2@ OBJE
1 FILE C:\\photos\\scan.jpg
0 TRLR`, "media");
    expect(groups).toHaveLength(1);
  });

  it("splits a shared basename whose records carry conflicting titles", () => {
    // Two cameras both produce an IMG_0001.jpg — same basename, different
    // photos. Conflicting titles split them; the untitled copy then groups
    // with neither.
    const groups = ofKind(`0 HEAD
1 CHAR UTF-8
0 @O1@ OBJE
1 FILE a/IMG_0001.jpg
1 TITL Poroka 1901
0 @O2@ OBJE
1 FILE b/IMG_0001.jpg
1 TITL Vas Ravna Gora
0 @O3@ OBJE
1 FILE c/IMG_0001.jpg
0 TRLR`, "media");
    expect(groups).toHaveLength(0);
  });

  it("still joins an untitled copy where every title agrees", () => {
    const groups = ofKind(`0 HEAD
1 CHAR UTF-8
0 @O1@ OBJE
1 FILE a/IMG_0001.jpg
1 TITL Poroka 1901
0 @O2@ OBJE
1 FILE b/IMG_0001.jpg
0 TRLR`, "media");
    expect(groups).toHaveLength(1);
    expect(groups[0].members).toHaveLength(2);
  });

  it("keeps case-sensitive video/volume ids apart, however the URL is cased", () => {
    // dQw4… and DQW4… are different YouTube videos; a case-folding key would
    // merge them. The same id twice (mod slash) still groups.
    const groups = ofKind(`0 HEAD
1 CHAR UTF-8
0 @O1@ OBJE
1 FILE https://www.youtube.com/watch?v=dQw4w9WgXcQ
0 @O2@ OBJE
1 FILE https://www.youtube.com/watch?v=DQW4W9WGXCQ
0 @O3@ OBJE
1 FILE https://www.youtube.com/watch?v=dQw4w9WgXcQ/
0 TRLR`, "media");
    expect(groups).toHaveLength(1);
    expect(groups[0].members.map((m) => m.xref).sort()).toEqual(["@O1@", "@O3@"]);
  });

  it("keeps distinct files apart", () => {
    expect(ofKind(`0 HEAD
1 CHAR UTF-8
0 @O1@ OBJE
1 FILE a.jpg
0 @O2@ OBJE
1 FILE b.jpg
0 TRLR`, "media")).toHaveLength(0);
  });

  it("picks the richest record as the survivor", () => {
    const groups = ofKind(`0 HEAD
1 CHAR UTF-8
0 @O1@ OBJE
1 FILE a.jpg
0 @O2@ OBJE
1 FILE a.jpg
1 TITL A nice scan
1 DATE 1900
0 TRLR`, "media");
    expect(groups[0].members.find((m) => m.survivor)?.xref).toBe("@O2@");
  });
});

describe("findSourceDuplicates — sources & repos", () => {
  it("groups SOUR records with identical descriptive content under different xrefs", () => {
    expect(ofKind(`0 HEAD
1 CHAR UTF-8
0 @S1@ SOUR
1 TITL Parish register Ljubljana
1 AUTH Curia
0 @S2@ SOUR
1 TITL Parish register Ljubljana
1 AUTH Curia
0 TRLR`, "source")).toHaveLength(1);
  });

  it("does not group sources with different content", () => {
    expect(ofKind(`0 HEAD
1 CHAR UTF-8
0 @S1@ SOUR
1 TITL Register A
0 @S2@ SOUR
1 TITL Register B
0 TRLR`, "source")).toHaveLength(0);
  });

  it("groups REPO records with identical content", () => {
    expect(ofKind(`0 HEAD
1 CHAR UTF-8
0 @R1@ REPO
1 NAME Archive
1 WWW https://arhiv.si
0 @R2@ REPO
1 NAME Archive
1 WWW https://arhiv.si
0 TRLR`, "repo")).toHaveLength(1);
  });

  it("keeps same-titled sources apart when their call numbers differ", () => {
    // The regroup tool's own output shape: many collection sources on one
    // shared repository, told apart only by REPO > CALN — collapsing them
    // would re-point citations onto the wrong film.
    expect(ofKind(`0 HEAD
1 CHAR UTF-8
0 @S1@ SOUR
1 TITL Slovenia Church Books - FamilySearch
1 REPO @R1@
2 CALN 007548250
0 @S2@ SOUR
1 TITL Slovenia Church Books - FamilySearch
1 REPO @R1@
2 CALN 004520
0 @R1@ REPO
1 NAME FamilySearch.org - Slovenia
0 TRLR`, "source")).toHaveLength(0);
  });

  it("groups true duplicates that differ only in their CHAN stamps", () => {
    // Two exports of overlapping lines virtually always differ in CHAN —
    // bookkeeping must never keep real duplicates apart.
    expect(ofKind(`0 HEAD
1 CHAR UTF-8
0 @S1@ SOUR
1 TITL Parish register Ljubljana
1 CHAN
2 DATE 1 JAN 2020
0 @S2@ SOUR
1 TITL Parish register Ljubljana
1 CHAN
2 DATE 15 AUG 2026
3 TIME 10:15:00
0 TRLR`, "source")).toHaveLength(1);
  });
});

describe("dedupeSources", () => {
  it("re-points citations onto the survivor and drops the duplicate media", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 OBJE @O2@
0 @O1@ OBJE
1 FILE a.jpg
1 TITL Better
0 @O2@ OBJE
1 FILE a.jpg
0 TRLR`);
    const report = findSourceDuplicates(ds);
    const { records, removed } = dedupeSources(ds.records, report.groups);
    expect(removed).toBe(1);
    const text = serializeGedcom(records);
    expect(text).toContain("1 OBJE @O1@"); // citation re-pointed to survivor
    expect(text).not.toContain("@O2@"); // duplicate record dropped
    expect(records.filter((r) => r.tag === "OBJE")).toHaveLength(1);
  });

  it("folds a removed source's media links onto the survivor", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @S1@ SOUR
1 TITL Register
1 OBJE @O1@
0 @S2@ SOUR
1 TITL Register
1 OBJE @O2@
0 @O1@ OBJE
1 FILE p1.jpg
0 @O2@ OBJE
1 FILE p2.jpg
0 TRLR`);
    const report = findSourceDuplicates(ds);
    const survivor = report.groups[0].members.find((m) => m.survivor)!.xref;
    const { records } = dedupeSources(ds.records, report.groups);
    const surv = records.find((r) => r.xref === survivor)!;
    const objeLinks = surv.children.filter((c) => c.tag === "OBJE").map((c) => c.value);
    expect(objeLinks).toEqual(expect.arrayContaining(["@O1@", "@O2@"]));
    expect(records.filter((r) => r.tag === "SOUR")).toHaveLength(1);
  });

  it("collapses duplicate sibling pointers created by re-pointing", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 OBJE @O1@
1 OBJE @O2@
0 @O1@ OBJE
1 FILE a.jpg
0 @O2@ OBJE
1 FILE a.jpg
0 TRLR`);
    const report = findSourceDuplicates(ds);
    const { records } = dedupeSources(ds.records, report.groups);
    const indi = records.find((r) => r.xref === "@I1@")!;
    expect(indi.children.filter((c) => c.tag === "OBJE")).toHaveLength(1);
  });

  it("does not mutate the input records", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @O1@ OBJE
1 FILE a.jpg
0 @O2@ OBJE
1 FILE a.jpg
0 TRLR`);
    const before = ds.records.length;
    dedupeSources(ds.records, findSourceDuplicates(ds).groups);
    expect(ds.records.length).toBe(before);
  });

  it("leaves pre-existing duplicate citations untouched (minimal change)", () => {
    // @I1@ cites @S9@ twice already — unrelated to the media group being merged.
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 SOUR @S9@
1 SOUR @S9@
1 OBJE @O2@
0 @O1@ OBJE
1 FILE a.jpg
1 TITL keep
0 @O2@ OBJE
1 FILE a.jpg
0 @S9@ SOUR
1 TITL Unique
0 TRLR`);
    const { records } = dedupeSources(ds.records, findSourceDuplicates(ds).groups);
    const indi = records.find((r) => r.xref === "@I1@")!;
    expect(indi.children.filter((c) => c.tag === "SOUR")).toHaveLength(2); // not collapsed
    expect(indi.children.filter((c) => c.tag === "OBJE")).toHaveLength(1); // re-pointed @O2@→@O1@
  });

  it("preserves two citations of the same source that differ by PAGE", () => {
    // The two @S1@/@S2@ describe the same source (merged); @I1@ cites the
    // survivor twice but for different pages, so both must survive.
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 SOUR @S1@
2 PAGE 12
1 SOUR @S2@
2 PAGE 99
0 @S1@ SOUR
1 TITL Register
0 @S2@ SOUR
1 TITL Register
0 TRLR`);
    const report = findSourceDuplicates(ds);
    const survivor = report.groups[0].members.find((m) => m.survivor)!.xref;
    const { records } = dedupeSources(ds.records, report.groups);
    const indi = records.find((r) => r.xref === "@I1@")!;
    const sour = indi.children.filter((c) => c.tag === "SOUR");
    expect(sour).toHaveLength(2);
    expect(sour.every((c) => c.value === survivor)).toBe(true);
    expect(sour.map((c) => c.children.find((g) => g.tag === "PAGE")?.value).sort()).toEqual(["12", "99"]);
  });

  it("collapses only the duplicate created by re-pointing (identical PAGE)", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 SOUR @S1@
2 PAGE 5
1 SOUR @S2@
2 PAGE 5
0 @S1@ SOUR
1 TITL Register
0 @S2@ SOUR
1 TITL Register
0 TRLR`);
    const { records } = dedupeSources(ds.records, findSourceDuplicates(ds).groups);
    const indi = records.find((r) => r.xref === "@I1@")!;
    expect(indi.children.filter((c) => c.tag === "SOUR")).toHaveLength(1);
  });
});
