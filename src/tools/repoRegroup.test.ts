import { describe, expect, it } from "vitest";
import { parseGedcom } from "../gedcom/parser";
import { buildDataset } from "../gedcom/builder";
import { childText, childrenByTag, firstChild } from "../gedcom/node";
import type { GedNode } from "../gedcom/types";
import { regroupRepositories, scanRepoRegroup } from "./repoRegroup";

function dataset(lines: string[]) {
  return buildDataset(parseGedcom(new TextEncoder().encode(lines.join("\n")).buffer));
}

/** A file in the shape the per-collection habit leaves behind: a repository
 *  per FamilySearch collection, one Matricula archive alongside. */
const PER_COLLECTION = [
  "0 HEAD",
  "1 GEDC",
  "2 VERS 5.5.1",
  "0 @R1@ REPO",
  "1 NAME FamilySearch.org - Illinois, Cook County Deaths, 1871-1998",
  "1 WWW https://www.familysearch.org/search/collection/2128172",
  "0 @R2@ REPO",
  "1 NAME FamilySearch.org - Indiana, Marriages, 1811-2019",
  "0 @R3@ REPO",
  "1 NAME FamilySearch.org - Croatia Church Books 1516-1994",
  "0 @R4@ REPO",
  "1 NAME Matricula Online - Nadškofijski arhiv Ljubljana",
  "1 WWW https://data.matricula-online.eu/sl/slovenia/ljubljana/",
  "0 @S1@ SOUR",
  "1 TITL Illinois, Cook County Deaths, 1871-1998",
  "1 PLAC Chicago, Cook, Illinois, United States",
  "1 REPO @R1@",
  "2 CALN 108918058",
  "0 @S2@ SOUR",
  "1 TITL Indiana, Marriages, 1811-2019",
  "1 REPO @R2@",
  "0 @S3@ SOUR",
  "1 TITL Croatia, Church Books, 1516-1994",
  "1 PLAC Ravna Gora, Primorje-Gorski Kotar, Croatia",
  "1 REPO @R3@",
  "0 @S4@ SOUR",
  "1 TITL Krstna knjiga - Šenčur",
  "1 PLAC Šenčur, Slovenia",
  "1 REPO @R4@",
  "0 TRLR",
];

describe("scanRepoRegroup", () => {
  it("gathers each place's FamilySearch sources under one repository", () => {
    const report = scanRepoRegroup(dataset(PER_COLLECTION).records);
    expect(report.total).toBe(3);
    // American records are published state by state, so the state is the
    // repository; elsewhere the country is.
    expect(report.groups.map((g) => g.repoName)).toEqual([
      "FamilySearch.org - Croatia",
      "FamilySearch.org - United States, Illinois",
      "FamilySearch.org - United States, Indiana",
    ]);
    const illinois = report.groups.find((g) => g.id === "us:illinois")!;
    // The place names the state outright, the Indiana collection's title does.
    expect(illinois.moves.map((m) => m.sourceXref)).toEqual(["@S1@"]);
    expect(illinois.targetXref).toBeUndefined();
    expect(illinois.emptied.map((e) => e.xref)).toEqual(["@R1@"]);
    expect(report.groups.find((g) => g.id === "us:indiana")!.moves.map((m) => m.sourceXref)).toEqual(["@S2@"]);
  });

  it("keeps a national collection under the country itself", () => {
    const report = scanRepoRegroup(
      dataset([
        "0 HEAD",
        "0 @R1@ REPO", "1 NAME FamilySearch.org - United States, Census, 1930",
        "0 @S1@ SOUR", "1 TITL United States, Census, 1930", "1 REPO @R1@",
        "0 TRLR",
      ]).records,
    );
    expect(report.groups.map((g) => g.repoName)).toEqual(["FamilySearch.org - United States"]);
    expect(report.groups[0].id).toBe("us");
  });

  it("leaves other sites' repositories alone", () => {
    const report = scanRepoRegroup(dataset(PER_COLLECTION).records);
    for (const group of report.groups) {
      expect(group.moves.map((m) => m.sourceXref)).not.toContain("@S4@");
      expect(group.emptied.map((e) => e.xref)).not.toContain("@R4@");
    }
  });

  it("joins the country's own repository when the file already keeps one", () => {
    const report = scanRepoRegroup(
      dataset([
        "0 HEAD",
        "0 @R1@ REPO",
        "1 NAME FamilySearch.org - Hrvaška",
        "1 WWW https://www.familysearch.org/",
        "0 @R2@ REPO",
        "1 NAME FamilySearch.org - Croatia Church Books 1516-1994",
        "0 @S1@ SOUR",
        "1 TITL Croatia, Church Books, 1516-1994",
        "1 REPO @R2@",
        "0 @S2@ SOUR",
        "1 TITL Hrvatska, matične knjige",
        "1 PLAC Ravna Gora, Croatia",
        "1 REPO @R1@",
        "0 TRLR",
      ]).records,
    );
    const hr = report.groups.find((g) => g.id === "hr")!;
    expect(hr.targetXref).toBe("@R1@");
    // The file's own spelling of the country is kept, and the source already
    // sitting there is not listed as a move.
    expect(hr.repoName).toBe("FamilySearch.org - Hrvaška");
    expect(hr.moves.map((m) => m.sourceXref)).toEqual(["@S1@"]);
  });

  it("says nothing about a source whose country nothing names", () => {
    const report = scanRepoRegroup(
      dataset([
        "0 HEAD",
        "0 @R1@ REPO",
        "1 NAME FamilySearch.org",
        "1 WWW https://www.familysearch.org/",
        "0 @S1@ SOUR",
        "1 TITL FamilySearch film 108918058",
        "1 REPO @R1@",
        "0 TRLR",
      ]).records,
    );
    expect(report.groups).toEqual([]);
  });

  it("adopts a repository-less FamilySearch source only where the file uses repositories", () => {
    // The same repository-less source in two files: one whose sources hang off
    // repositories, one whose sources never do.
    const lines = (repoHabit: boolean) => [
      "0 HEAD",
      "0 @S1@ SOUR",
      "1 TITL Croatia, Church Books, 1516-1994",
      "1 OBJE @O1@",
      "0 @S2@ SOUR",
      "1 TITL Druga zbirka",
      "1 PLAC Zagreb, Croatia",
      ...(repoHabit ? ["1 REPO @R1@"] : []),
      "0 @S3@ SOUR",
      "1 TITL Tretja zbirka",
      "1 PLAC Zagreb, Croatia",
      ...(repoHabit ? ["1 REPO @R1@"] : []),
      ...(repoHabit ? ["0 @R1@ REPO", "1 NAME FamilySearch.org - Croatia", "1 WWW https://www.familysearch.org/"] : []),
      "0 @O1@ OBJE",
      "1 FILE https://www.familysearch.org/ark:/61903/3:1:ABCD?i=4",
      "0 TRLR",
    ];
    expect(scanRepoRegroup(dataset(lines(false)).records).groups).toEqual([]);
    const withRepos = scanRepoRegroup(dataset(lines(true)).records);
    expect(withRepos.groups[0].moves.map((m) => m.sourceXref)).toEqual(["@S1@"]);
  });
});

describe("regroupRepositories", () => {
  const repoOf = (records: GedNode[], xref: string) =>
    firstChild(records.find((r) => r.xref === xref)!, "REPO");

  it("re-points the sources, keeps their call numbers and drops the emptied records", () => {
    const before = dataset(PER_COLLECTION).records;
    const { records, counts } = regroupRepositories(before, scanRepoRegroup(before).groups);
    expect(counts).toEqual({ sourcesMoved: 3, reposCreated: 3, reposRemoved: 3 });
    // The input forest is untouched — the caller diffs the two.
    expect(repoOf(before, "@S1@")?.value).toBe("@R1@");

    const named = (name: string) => records.find((r) => r.tag === "REPO" && childText(r, "NAME") === name)!;
    const illinois = named("FamilySearch.org - United States, Illinois");
    expect(repoOf(records, "@S1@")?.value).toBe(illinois.xref);
    expect(repoOf(records, "@S2@")?.value).toBe(named("FamilySearch.org - United States, Indiana").xref);
    expect(childText(repoOf(records, "@S1@")!, "CALN")).toBe("108918058");
    expect(childText(illinois, "WWW")).toBe("https://www.familysearch.org/");
    // Matricula's archive and its source stay exactly where they were.
    expect(repoOf(records, "@S4@")?.value).toBe("@R4@");
    expect(records.some((r) => r.xref === "@R4@")).toBe(true);
    expect(records.some((r) => r.xref === "@R1@" || r.xref === "@R2@" || r.xref === "@R3@")).toBe(false);
  });

  it("keeps a repository a source left out of the run still cites", () => {
    const before = dataset(PER_COLLECTION).records;
    const report = scanRepoRegroup(before);
    // Only Croatia is applied; the American sources keep their records.
    const { records, counts } = regroupRepositories(before, report.groups.filter((g) => g.id === "hr"));
    expect(counts.sourcesMoved).toBe(1);
    expect(records.some((r) => r.xref === "@R1@")).toBe(true);
    expect(records.some((r) => r.xref === "@R3@")).toBe(false);
  });

  it("gives a source that had no repository one, with its filing number as the call number", () => {
    const before = dataset([
      "0 HEAD",
      "0 @R1@ REPO",
      "1 NAME FamilySearch.org - Croatia",
      "1 WWW https://www.familysearch.org/",
      "0 @S1@ SOUR",
      "1 TITL Croatia, Church Books, 1516-1994",
      "1 FILN 5498154",
      "1 REPO @R1@",
      "0 @S3@ SOUR",
      "1 TITL Croatia, Baptisms",
      "1 FILN 5498155",
      "1 REPO @R1@",
      "0 @S2@ SOUR",
      "1 TITL Croatia, Civil Registration",
      "1 PLAC Rijeka, Croatia",
      "1 FILN 4826234",
      "1 OBJE @O1@",
      "0 @O1@ OBJE",
      "1 FILE https://www.familysearch.org/ark:/61903/3:1:ABCD?i=4",
      "0 TRLR",
    ]).records;
    const { records, counts } = regroupRepositories(before, scanRepoRegroup(before).groups);
    expect(counts).toEqual({ sourcesMoved: 1, reposCreated: 0, reposRemoved: 0 });
    const link = repoOf(records, "@S2@")!;
    expect(link.value).toBe("@R1@");
    expect(childText(link, "CALN")).toBe("4826234");
    expect(childrenByTag(records.find((r) => r.xref === "@S2@")!, "REPO")).toHaveLength(1);
  });
});
