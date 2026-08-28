import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { previewLinkCitation, previewLinkPlacement } from "./linkPlacement";

function records(body: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(`0 HEAD\n1 CHAR UTF-8\n${body}0 TRLR\n`).buffer)).records;
}

const BOOK =
  "0 @S1@ SOUR\n1 TITL Krstna knjiga - Šenčur\n1 AGNC Nadškofijski arhiv Ljubljana\n1 FILN 03173\n1 OBJE @O1@\n" +
  "0 @O1@ OBJE\n1 FILE https://data.matricula-online.eu/sl/slovenia/ljubljana/sencur/03173/?pg=56\n";

describe("previewLinkCitation", () => {
  it("shows an incoming link as the citation of the book the file already keeps", () => {
    const citation = previewLinkCitation(
      records(BOOK),
      "https://data.matricula-online.eu/de/slovenia/ljubljana/sencur/03173/?pg=58",
    );
    expect(citation).toMatchObject({
      sourceId: "@S1@",
      title: "Krstna knjiga - Šenčur",
      agency: "Nadškofijski arhiv Ljubljana",
      filingNumber: "03173",
      page: "58",
    });
  });

  it("names the source a recognized link would mint, where the file has none", () => {
    const citation = previewLinkCitation(
      records("0 @I1@ INDI\n1 NAME Janez /Novak/\n"),
      "https://data.matricula-online.eu/sl/slovenia/ljubljana/vodice/04407/?pg=12",
    );
    expect(citation).toMatchObject({ sourceId: "", title: "Matricula 04407 | Vodice", page: "12" });
  });

  it("says which event the citation will land on", () => {
    // The file cites this baptism book on the births it documents, and the
    // person has a birth — so Edit must preview the chip there, not on the
    // person, because that is where the save writes it.
    const recs = records(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 1850\n2 SOUR @S1@\n3 PAGE 56\n" + BOOK,
    );
    const person = recs.find((r) => r.xref === "@I1@")!;
    const url = "https://data.matricula-online.eu/sl/slovenia/ljubljana/sencur/03173/?pg=58";
    expect(previewLinkPlacement(person, url, recs)).toMatchObject({
      eventTag: "BIRT",
      citation: { sourceId: "@S1@", page: "58" },
    });
  });

  it("names the page image the citation will be linked with, where the file keeps them", () => {
    const recs = records(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 1850\n2 OBJE @O1@\n2 SOUR @S1@\n3 PAGE 56\n" + BOOK,
    );
    const person = recs.find((r) => r.xref === "@I1@")!;
    const url = "https://data.matricula-online.eu/sl/slovenia/ljubljana/sencur/03173/?pg=58";
    // The file keeps a cited page's image beside the citation, so the preview
    // names the image the merge will link with it — here the page the merge
    // would mint, whose file is the link itself.
    expect(previewLinkPlacement(person, url, recs, { pageMedia: "event" }).pageImage).toBe(url);
    // A page the source already holds is named by the file's own copy of it.
    const known = "https://data.matricula-online.eu/de/slovenia/ljubljana/sencur/03173/?pg=56";
    expect(previewLinkPlacement(person, known, recs, { pageMedia: "event" }).pageImage).toBe(
      "https://data.matricula-online.eu/sl/slovenia/ljubljana/sencur/03173/?pg=56",
    );
    // A file that keeps page images under the source alone gets none.
    expect(previewLinkPlacement(person, url, recs, { pageMedia: "source" }).pageImage).toBeUndefined();
  });

  it("keeps the citation on the person when the event it documents is missing", () => {
    const recs = records("0 @I1@ INDI\n1 NAME Janez /Novak/\n" + BOOK);
    const person = recs.find((r) => r.xref === "@I1@")!;
    const url = "https://data.matricula-online.eu/sl/slovenia/ljubljana/sencur/03173/?pg=58";
    expect(previewLinkPlacement(person, url, recs).eventTag).toBeUndefined();
  });

  it("leaves a link of an unknown site a plain link", () => {
    expect(previewLinkCitation(records(BOOK), "https://example.com/janez")).toBeUndefined();
  });
});
