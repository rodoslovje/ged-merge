import { describe, expect, it } from "vitest";
import { extractUrl, parseSourceInput } from "./citationParse";

describe("extractUrl", () => {
  it("pulls the last URL out and trims trailing punctuation", () => {
    const { url, rest } = extractUrl("see https://example.com/page.");
    expect(url).toBe("https://example.com/page");
    expect(rest).toBe("see");
  });

  it("returns no url and the trimmed text when there isn't one", () => {
    expect(extractUrl("  just some text  ")).toEqual({ rest: "just some text" });
  });
});

describe("parseSourceInput", () => {
  it("parses the Slovenian institute-style citation into its fields", () => {
    const text =
      "Marta Rendla, »Jožef Celar«, Smrtne žrtve druge svetovne vojne in zaradi nje v Sloveniji " +
      "(Ljubljana: Inštitut za novejšo zgodovino, 2026), pridobljeno 21. 6. 2026, " +
      "https://www.sistory.si/ww2/5046DECC-E88C-4EA6-8B61-82D7A78C8626";

    expect(parseSourceInput(text)).toEqual({
      url: "https://www.sistory.si/ww2/5046DECC-E88C-4EA6-8B61-82D7A78C8626",
      title: "Jožef Celar",
      author: "Marta Rendla",
      periodical: "Smrtne žrtve druge svetovne vojne in zaradi nje v Sloveniji",
      publisher: "Inštitut za novejšo zgodovino",
      place: "Ljubljana",
      note: "pridobljeno 21. 6. 2026",
    });
  });

  it("returns just the url for a bare URL with no surrounding text", () => {
    const url = "https://data.matricula-online.eu/sl/slovenia/ljubljana/podzemelj/01728/?pg=11";
    expect(parseSourceInput(url)).toEqual({ url });
  });

  it("does not mistake the access-date paren the URL left behind for a publisher", () => {
    // Pulling the URL out of "(https://… : Aug 17, 2026)" leaves "( : Aug 17,
    // 2026)" — the citation's own access note, not a "(Place: Publisher)".
    const result = parseSourceInput(
      '"Chicago, Cook, Illinois, United States records," images, FamilySearch ' +
        "(https://www.familysearch.org/ark:/61903/3:1:3QHJ-5QHW-FSYM-6?view=explore : Aug 17, 2026), " +
        "image 23 of 35; National Archives and Records Administration.",
    );
    expect(result.title).toBe("Chicago, Cook, Illinois, United States records");
    expect(result.publisher).toBeUndefined();
    expect(result.place).toBeUndefined();
  });

  it("falls back to a note when there's no quoted title or parens", () => {
    const result = parseSourceInput("some free-text reference, no structure here");
    expect(result.title).toBeUndefined();
    expect(result.publisher).toBeUndefined();
    expect(result.note).toBe("some free-text reference, no structure here");
  });

  it("returns an empty object for empty input", () => {
    expect(parseSourceInput("   ")).toEqual({});
  });
});
