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

  it("keeps the richer media record even when the other is cited more", () => {
    const groups = ofKind(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 OBJE @O1@
0 @I2@ INDI
1 OBJE @O1@
0 @O1@ OBJE
1 FILE a.jpg
0 @O2@ OBJE
1 FILE a.jpg
1 TITL A nice scan
0 TRLR`, "media");
    expect(groups[0].members.map((m) => [m.xref, m.usage])).toEqual([["@O2@", 0], ["@O1@", 2]]);
  });

  it("keeps the more-cited of two equally rich media records", () => {
    const groups = ofKind(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 OBJE @O2@
0 @O1@ OBJE
1 FILE a.jpg
0 @O2@ OBJE
1 FILE a.jpg
0 TRLR`, "media");
    expect(groups[0].members.find((m) => m.survivor)?.xref).toBe("@O2@");
  });
});

describe("findSourceDuplicates — sources & repos", () => {
  it("keeps the more-cited of two identical repositories, whatever their stamps", () => {
    const groups = ofKind(`0 HEAD
1 CHAR UTF-8
0 @S1@ SOUR
1 TITL Baptisms
1 REPO @R2@
0 @S2@ SOUR
1 TITL Deaths
1 REPO @R2@
0 @R1@ REPO
1 NAME Matricula Online
1 CHAN
2 DATE 1 JAN 2020
0 @R2@ REPO
1 NAME Matricula Online
0 TRLR`, "repo");
    expect(groups[0].members.map((m) => [m.xref, m.usage, m.survivor])).toEqual([
      ["@R2@", 2, true],
      ["@R1@", 0, false],
    ]);
  });

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

  it("gives a member the page it opens at, and none where it has no address", () => {
    // A source's own detail is its filing number and its label is a title —
    // neither is a link, so a member without a page image gets no url and the
    // row shows no ↗ (the arrow used to point at "https://<title>").
    const [titled] = ofKind(`0 HEAD
1 CHAR UTF-8
0 @S1@ SOUR
1 TITL Illinois, Cook County Marriages, 1871-1969
1 FILN 1030102
0 @S2@ SOUR
1 TITL Illinois, Cook County Marriages, 1871-1969
1 FILN 1030102
0 TRLR`, "source");
    expect(titled.members.map((m) => m.url)).toEqual([undefined, undefined]);
    expect(titled.members[0].detail).toBe("1030102"); // still shown, just not as a link

    // With a page image, that image's URL is what the row opens.
    const [withPage] = ofKind(`0 HEAD
1 CHAR UTF-8
0 @S1@ SOUR
1 TITL Krstna knjiga
1 OBJE @O1@
0 @S2@ SOUR
1 TITL Krstna knjiga
1 OBJE @O2@
0 @O1@ OBJE
1 FILE https://example.com/knjiga/?pg=11
0 @O2@ OBJE
1 FILE https://example.com/knjiga/?pg=11
0 TRLR`, "source");
    expect(withPage.members.map((m) => m.url)).toEqual([
      "https://example.com/knjiga/?pg=11",
      "https://example.com/knjiga/?pg=11",
    ]);

    // A repository opens at its website; a scan known only as a local file
    // opens nowhere.
    const [repo] = ofKind(`0 HEAD
1 CHAR UTF-8
0 @R1@ REPO
1 NAME Archive
1 WWW https://arhiv.si
0 @R2@ REPO
1 NAME Archive
1 WWW https://arhiv.si
0 TRLR`, "repo");
    expect(repo.members[0].url).toBe("https://arhiv.si");
    const [scan] = ofKind(`0 HEAD
1 CHAR UTF-8
0 @O1@ OBJE
1 FILE C:\\scans\\krst.jpg
0 @O2@ OBJE
1 FILE D:\\arhiv\\krst.jpg
0 TRLR`, "media");
    expect(scan.members[0].url).toBeUndefined();
    expect(scan.members[0].detail).toContain("krst.jpg");
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

  it("keeps same-titled sources apart when different repositories hold them", () => {
    expect(ofKind(`0 HEAD
1 CHAR UTF-8
0 @S1@ SOUR
1 TITL Census 1900
1 REPO @R1@
0 @S2@ SOUR
1 TITL Census 1900
1 REPO @R2@
0 @R1@ REPO
1 NAME National Archives
0 @R2@ REPO
1 NAME State Archives
0 TRLR`, "source")).toHaveLength(0);
  });

  it("reads a source's repositories as a set, whatever their order", () => {
    expect(ofKind(`0 HEAD
1 CHAR UTF-8
0 @S1@ SOUR
1 TITL Census 1900
1 REPO @R1@
1 REPO @R2@
0 @S2@ SOUR
1 TITL Census 1900
1 REPO @R2@
1 REPO @R1@
0 @R1@ REPO
1 NAME National Archives
0 @R2@ REPO
1 NAME State Archives
0 TRLR`, "source")).toHaveLength(1);
  });

  it("keeps sources apart on their own _ tags, but not on a _UPD stamp", () => {
    const text = (a: string, b: string) => `0 HEAD
1 CHAR UTF-8
0 @S1@ SOUR
1 TITL Census 1900
${a}
0 @S2@ SOUR
1 TITL Census 1900
${b}
0 TRLR`;
    expect(ofKind(text("1 _TMPLT\n2 FIELD\n3 NAME Page", "1 _TMPLT\n2 FIELD\n3 NAME Line"), "source")).toHaveLength(0);
    expect(ofKind(text("1 _UPD 1 JAN 2020", "1 _UPD 2 FEB 2024"), "source")).toHaveLength(1);
  });

  it("keeps the _TMPLT block when a lean twin folds into its fuller source", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 SOUR @S1@
1 SOUR @S2@
0 @S1@ SOUR
1 TITL Census 1900
0 @S2@ SOUR
1 TITL Census 1900
1 _TMPLT
2 FIELD
3 NAME Page
0 TRLR`);
    const groups = findSourceDuplicates(ds).groups.filter((g) => g.kind === "source");
    expect(groups).toHaveLength(1);
    expect(groups[0].members[0].xref).toBe("@S2@");
    const text = serializeGedcom(dedupeSources(ds.records, groups).records);
    expect(text).toContain("1 _TMPLT\n2 FIELD\n3 NAME Page");
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

describe("findSourceDuplicates — a source that says less", () => {
  // Ravna Gora, 3 Oct 2026: a merge copied the register in as @S2@ with only
  // its title and repository, beside the full @S1@ the file already had.
  const FILE = `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Marija /Čop/
1 DEAT
2 DATE 4 APR 1893
2 SOUR @S2@
3 PAGE 186
2 SOUR @S1@
3 PAGE 186
3 QUAY 3
1 BURI
2 SOUR @S2@
3 PAGE 187
0 @S1@ SOUR
1 TITL Deaths (Umrli) 1858-1896, Ravna Gora
1 DATA
2 EVEN DEAT
1 REPO @R1@
2 CALN 004679930
0 @S2@ SOUR
1 TITL Deaths (Umrli) 1858-1896, Ravna Gora
1 REPO @R1@
0 @R1@ REPO
1 NAME FamilySearch
0 TRLR`;

  it("groups it with the one fuller record of its title; the more-cited is kept", () => {
    const groups = ofKind(FILE, "source");
    expect(groups).toHaveLength(1);
    expect(groups[0].members.map((m) => [m.xref, m.survivor])).toEqual([["@S2@", true], ["@S1@", false]]);
  });

  it("keeps the fuller record when both are cited alike", () => {
    const groups = ofKind(FILE.replace("1 BURI\n2 SOUR @S2@\n3 PAGE 187\n", ""), "source");
    expect(groups[0].members.map((m) => [m.xref, m.survivor])).toEqual([["@S1@", true], ["@S2@", false]]);
  });

  it("leaves it alone when two different fuller records share its title", () => {
    // @S2@ (no CALN) is covered by @S1@ and by @S3@ — two films of one title.
    const twoFilms = FILE.replace(
      "0 @R1@ REPO",
      "0 @S3@ SOUR\n1 TITL Deaths (Umrli) 1858-1896, Ravna Gora\n1 REPO @R1@\n2 CALN 004679931\n0 @R1@ REPO",
    );
    expect(ofKind(twoFilms, "source")).toHaveLength(0);
  });

  it("drops the lean citation the fold makes say the same page twice", () => {
    const ds = dataset(FILE);
    const { records } = dedupeSources(ds.records, findSourceDuplicates(ds).groups);
    const out = serializeGedcom(records);
    expect(out).toContain("1 DEAT\n2 DATE 4 APR 1893\n2 SOUR @S2@\n3 PAGE 186\n3 QUAY 3\n1 BURI\n2 SOUR @S2@\n3 PAGE 187\n");
    expect(out).not.toContain("0 @S1@ SOUR");
    // The kept lean record takes what only the dropped one said.
    expect(out).toContain("0 @S2@ SOUR\n1 TITL Deaths (Umrli) 1858-1896, Ravna Gora\n1 REPO @R1@\n2 CALN 004679930\n1 DATA\n2 EVEN DEAT\n");
  });

  it("folds the dropped repository's lines into the kept one, stamps aside", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @S1@ SOUR
1 TITL Baptisms
1 REPO @R2@
0 @R1@ REPO
1 NAME Matricula Online
1 ADDR Ljubljana
1 CHAN
2 DATE 1 JAN 2020
0 @R2@ REPO
1 NAME Matricula Online
0 TRLR`);
    const report = findSourceDuplicates(ds);
    expect(report.groups[0].members.find((m) => m.survivor)?.xref).toBe("@R2@");
    const out = serializeGedcom(dedupeSources(ds.records, report.groups).records);
    expect(out).toContain("0 @R2@ REPO\n1 NAME Matricula Online\n1 ADDR Ljubljana\n0 TRLR");
    expect(out).not.toContain("@R1@");
  });

  it("gives the kept link one access date, not each one the other record noted", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @S1@ SOUR
1 TITL Baptisms
1 REPO @R2@
0 @S2@ SOUR
1 TITL Deaths
1 REPO @R2@
0 @R1@ REPO
1 NAME Matricula Online
1 WWW https://data.matricula-online.eu/en/slovenia/ljubljana/
2 DATE 11 MAR 2026
3 TIME 17:18:54
1 WWW https://data.matricula-online.eu/en/slovenia/ljubljana/
2 DATE 31 MAR 2025
3 TIME 11:11:09
0 @R2@ REPO
1 NAME Matricula Online
1 WWW https://data.matricula-online.eu/en/slovenia/ljubljana/
0 TRLR`);
    const report = findSourceDuplicates(ds);
    expect(report.groups[0].members.find((m) => m.survivor)?.xref).toBe("@R2@");
    const out = serializeGedcom(dedupeSources(ds.records, report.groups).records);
    expect(out).toContain(
      "0 @R2@ REPO\n1 NAME Matricula Online\n1 WWW https://data.matricula-online.eu/en/slovenia/ljubljana/\n2 DATE 11 MAR 2026\n3 TIME 17:18:54\n0 TRLR",
    );
  });
});
