import { describe, expect, it } from "vitest";
import { familySearchPageUrl, linkKey, parseFamilySearchUrl } from "./links";

describe("parseFamilySearchUrl", () => {
  it("parses a language-prefixed ark the same as the plain form", () => {
    // FamilySearch sometimes writes the UI language ahead of the ark; the
    // parser and linkKey must agree that this is the same image page.
    const plain = parseFamilySearchUrl(
      "https://www.familysearch.org/ark:/61903/3:1:3QSQ-G99F-FHWS?i=555&cat=123456",
    );
    const prefixed = parseFamilySearchUrl(
      "https://www.familysearch.org/de/ark:/61903/3:1:3QSQ-G99F-FHWS?i=555&cat=123456",
    );
    expect(plain).toEqual({ kind: "image", ark: "3:1:3QSQ-G99F-FHWS", cat: "123456", cc: undefined, image: "555" });
    expect(prefixed).toEqual(plain);
  });

  it("parses a language-prefixed record ark as a record, not the tree", () => {
    expect(parseFamilySearchUrl("https://familysearch.org/sl/ark:/61903/1:1:JFVN-KMV")).toEqual({
      kind: "record",
      ark: "1:1:JFVN-KMV",
    });
  });

  it("still answers tree for non-ark FamilySearch pages", () => {
    expect(parseFamilySearchUrl("https://www.familysearch.org/tree/person/details/KWC1-234")).toEqual({ kind: "tree" });
  });
});

describe("familySearchPageUrl", () => {
  it("folds a language-prefixed ark to the canonical stored form, keeping i/cat", () => {
    expect(familySearchPageUrl("http://www.familysearch.org/de/ark:/61903/3:1:3QSQ-G99F-FHWS?i=555&cat=123456&view=explore")).toBe(
      "https://www.familysearch.org/ark:/61903/3:1:3QSQ-G99F-FHWS?i=555&cat=123456",
    );
  });
});

describe("linkKey", () => {
  it("folds http and https copies of one page to the same key", () => {
    expect(linkKey("http://data.matricula-online.eu/sl/slovenia/ljubljana/kranj/04120/?pg=56")).toBe(
      linkKey("https://data.matricula-online.eu/sl/slovenia/ljubljana/kranj/04120/?pg=56"),
    );
  });

  it("folds scheme, host case, trailing slash and Matricula language together", () => {
    expect(linkKey("HTTP://DATA.matricula-online.eu/de/slovenia/ljubljana/kranj/04120/")).toBe(
      linkKey("https://data.matricula-online.eu/sl/slovenia/ljubljana/kranj/04120"),
    );
  });

  it("keys a language-prefixed FamilySearch ark the same as its www form", () => {
    expect(linkKey("https://www.familysearch.org/de/ark:/61903/3:1:3QSQ-G99F-FHWS?i=555&cat=123456")).toBe(
      linkKey("http://familysearch.org/ark:/61903/3:1:3qsq-g99f-fhws?cat=123456"),
    );
  });

  it("keeps different pages distinct", () => {
    expect(linkKey("https://data.matricula-online.eu/sl/x/?pg=56")).not.toBe(
      linkKey("https://data.matricula-online.eu/sl/x/?pg=57"),
    );
  });

  it("keeps case-sensitive resource ids distinct through the fold", () => {
    expect(linkKey("https://www.youtube.com/watch?v=AbCdEf12345")).not.toBe(
      linkKey("https://www.youtube.com/watch?v=abcdef12345"),
    );
  });
});
