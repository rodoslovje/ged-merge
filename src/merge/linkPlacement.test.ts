import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { previewLinkCitation } from "./linkPlacement";

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

  it("leaves a link of an unknown site a plain link", () => {
    expect(previewLinkCitation(records(BOOK), "https://example.com/janez")).toBeUndefined();
  });
});
