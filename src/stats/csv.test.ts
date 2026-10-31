import { describe, expect, it } from "vitest";
import { csvStyleFor, percentOf, toCsv } from "./csv";

describe("toCsv", () => {
  it("quotes what needs quoting and marks the text as UTF-8", () => {
    expect(toCsv([["Kraj", "Število"], ["Kranj, Slovenija", 3], ['Rekel je "da"', 1]])).toBe(
      '﻿Kraj,Število\r\n"Kranj, Slovenija",3\r\n"Rekel je ""da""",1\r\n',
    );
  });

  it("keeps a text that reads as a formula a text, but not a plain number", () => {
    expect(toCsv([["=HYPERLINK(1)", "@cause", "-10", 45.5]])).toBe("﻿'=HYPERLINK(1),'@cause,-10,45.5\r\n");
  });

  it("writes a semicolon and a decimal comma for a decimal-comma language", () => {
    expect(toCsv([["Kranj, Slovenija", 45.5]], csvStyleFor("sl"))).toBe("﻿Kranj, Slovenija;45,5\r\n");
    expect(csvStyleFor("en").separator).toBe(",");
  });
});

describe("percentOf", () => {
  it("is a number of percent to one decimal, empty for a share of nobody", () => {
    expect(percentOf(1, 3)).toBe(33.3);
    expect(percentOf(0, 0)).toBe("");
  });
});
