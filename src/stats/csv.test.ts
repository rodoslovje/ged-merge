import { describe, expect, it } from "vitest";
import { toCsv } from "./csv";

describe("toCsv", () => {
  it("quotes what needs quoting and marks the text as UTF-8", () => {
    expect(toCsv([["Kraj", "Število"], ["Kranj, Slovenija", 3], ['Rekel je "da"', 1]])).toBe(
      '﻿Kraj,Število\r\n"Kranj, Slovenija",3\r\n"Rekel je ""da""",1\r\n',
    );
  });
});
