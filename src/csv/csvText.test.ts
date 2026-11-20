import { describe, expect, it } from "vitest";
import { detectDelimiter, parseCsvText } from "./csvText";

describe("detectDelimiter", () => {
  it("reads the separator off the header line", () => {
    expect(detectDelimiter("a,b,c\n1,2,3\n")).toBe(",");
    expect(detectDelimiter("a;b;c\r\n1;2;3\r\n")).toBe(";");
    expect(detectDelimiter("a\tb\tc\n")).toBe("\t");
  });

  it("gives a semicolon inside a note cell no vote", () => {
    // The parish indexes write whole sentences into `opombe`, semicolons and
    // all; only the header decides, and it is comma-separated here.
    const text = 'Ime,Priimek,Opombe\nJanez,Novak,"vdovec; 42 let; kmet"\n';
    expect(detectDelimiter(text)).toBe(",");
    expect(parseCsvText(text)[1]).toEqual(["Janez", "Novak", "vdovec; 42 let; kmet"]);
  });

  it("falls back to a comma when one column is all there is", () => {
    expect(detectDelimiter("Ime\nJanez\n")).toBe(",");
  });
});

describe("parseCsvText", () => {
  it("reads a semicolon-separated file without being told", () => {
    expect(parseCsvText("﻿a;b\r\n1;2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("reads a quote in the middle of a field as that character", () => {
    // An inch mark opened a quoted field and swallowed every row after it.
    expect(parseCsvText('1;he said 6" tall;x\r\n2;y;z\r\n', ";")).toEqual([
      ["1", 'he said 6" tall', "x"],
      ["2", "y", "z"],
    ]);
  });

  it("still reads a quoted field with separators, quotes and line breaks in it", () => {
    expect(parseCsvText('a;"b;c ""d""\ne";f\n"";g;"h"\n', ";")).toEqual([
      ["a", 'b;c "d"\ne', "f"],
      ["", "g", "h"],
    ]);
  });

  it("honours an explicit separator over the detected one", () => {
    expect(parseCsvText("a;b,c\n", ",")).toEqual([["a;b", "c"]]);
  });
});
