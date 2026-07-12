import { describe, expect, it } from "vitest";
import { buildDataset } from "./builder";
import { setEventField } from "./edit";
import { parseGedcom } from "./parser";
import { downloadOptions, ensureUtf8Charset, LINE_LIMIT_551, serializeGedcom } from "./serialize";

/** Parse text (as bytes) then serialize back, using the detected conventions. */
function roundTrip(text: string): string {
  const parsed = parseGedcom(new TextEncoder().encode(text).buffer);
  return serializeGedcom(parsed.records, {
    eol: parsed.eol,
    finalNewline: parsed.finalNewline,
  });
}

const SAMPLE = [
  "0 HEAD",
  "1 GEDC",
  "2 VERS 5.5.1",
  "1 CHAR UTF-8",
  "0 @I1@ INDI",
  "1 NAME Janez /Novak/",
  "1 SEX M",
  "1 BIRT",
  "2 DATE 12 JAN 1850",
  "2 PLAC Kranj, Slovenija",
  "1 NOTE First line",
  "2 CONT second line",
  "2 CONT third line",
  "0 @F1@ FAM",
  "1 HUSB @I1@",
  "0 TRLR",
  "",
].join("\n");

describe("serializeGedcom", () => {
  it("round-trips a LF file byte-for-byte", () => {
    expect(roundTrip(SAMPLE)).toBe(SAMPLE);
  });

  it("round-trips a CRLF file, preserving the line-ending", () => {
    const crlf = SAMPLE.replace(/\n/g, "\r\n");
    expect(roundTrip(crlf)).toBe(crlf);
  });

  it("round-trips a file with no trailing newline", () => {
    const noTrailer = SAMPLE.trimEnd();
    expect(roundTrip(noTrailer)).toBe(noTrailer);
  });

  it("preserves multi-line CONT values", () => {
    const out = roundTrip(SAMPLE);
    expect(out).toContain("1 NOTE First line\n2 CONT second line\n2 CONT third line");
  });

  it("round-trips unparsable lines verbatim, at their original positions", () => {
    const text = [
      "junk line",
      "0 HEAD",
      "1 GEDC",
      "2 VERS 5.5.1",
      "0 @I1@ INDI",
      "1 NAME Janez /Novak/",
      "1SEX M",
      "0 TRLR",
      "",
    ].join("\n");
    expect(roundTrip(text)).toBe(text);
  });

  it("does not add a trailing space when the value starts on a CONT line", () => {
    // A NOTE record with no inline value, text beginning on the next CONT line.
    const text = ["0 @N1@ NOTE", "1 CONT vzgojiteljica v vrtcu", "0 TRLR", ""].join("\n");
    expect(roundTrip(text)).toBe(text);
  });

  it("round-trips a file containing EVEN, AGNC and CAUS without data loss", () => {
    const text = [
      "0 HEAD",
      "1 GEDC",
      "2 VERS 5.5.1",
      "0 @I1@ INDI",
      "1 NAME Test /Person/",
      "1 EVEN",
      "2 TYPE Graduation",
      "2 DATE 1985",
      "1 DEAT",
      "2 AGNC City Hospital",
      "2 CAUS Heart failure",
      "0 TRLR",
      "",
    ].join("\n");
    expect(roundTrip(text)).toBe(text);
  });

  it("round-trips a file with a family-level NOTE containing a URL", () => {
    const text = [
      "0 HEAD",
      "1 GEDC",
      "2 VERS 5.5.1",
      "0 @F1@ FAM",
      "1 NOTE https://example.com/record/123",
      "0 TRLR",
      "",
    ].join("\n");
    expect(roundTrip(text)).toBe(text);
  });

  it("round-trips after a field edit: only the edited sub-node changes", () => {
    const text = [
      "0 HEAD",
      "1 GEDC",
      "2 VERS 5.5.1",
      "0 @I1@ INDI",
      "1 NAME Janez /Novak/",
      "1 BIRT",
      "2 DATE 12 JAN 1850",
      "2 PLAC Kranj, Slovenija",
      "0 TRLR",
      "",
    ].join("\n");
    const parsed = parseGedcom(new TextEncoder().encode(text).buffer);
    const ds = buildDataset(parsed);
    const indi = ds.individuals.get("@I1@")!;
    setEventField(indi, "BIRT", { date: "15 FEB 1850" });
    const out = serializeGedcom(parsed.records, { eol: parsed.eol, finalNewline: parsed.finalNewline });
    // Only the DATE sub-node should have changed; the rest is identical.
    expect(out).toContain("2 DATE 15 FEB 1850");
    expect(out).toContain("2 PLAC Kranj, Slovenija");
    expect(out).toContain("1 NAME Janez /Novak/");
  });

  describe("CONC wrapping (maxLineLength)", () => {
    const parse = (text: string) => parseGedcom(new TextEncoder().encode(text).buffer);
    /** A NOTE record holding `value`, serialized at the 5.5.1 line limit. */
    const noteFile = (value: string) =>
      serializeGedcom(
        [
          { level: 0, tag: "HEAD", children: [] },
          { level: 0, xref: "@N1@", tag: "NOTE", value, children: [] },
          { level: 0, tag: "TRLR", children: [] },
        ],
        { maxLineLength: LINE_LIMIT_551 },
      );
    const longText = Array.from({ length: 60 }, (_, i) => `beseda${i}`).join(" ");

    it("splits an overlong value across CONC lines, none exceeding the limit", () => {
      const out = noteFile(longText);
      expect(out).toContain("\n1 CONC ");
      for (const line of out.split("\n")) expect(line.length).toBeLessThanOrEqual(LINE_LIMIT_551);
    });

    it("re-parsing the wrapped output folds back to the identical value", () => {
      const parsed = parse(noteFile(longText));
      expect(parsed.records.find((r) => r.tag === "NOTE")?.value).toBe(longText);
    });

    it("is idempotent: parse → serialize at the same limit reproduces the text", () => {
      const once = noteFile(longText);
      const twice = serializeGedcom(parse(once).records, { maxLineLength: LINE_LIMIT_551 });
      expect(twice).toBe(once);
    });

    it("cuts mid-word so no CONC boundary touches a space", () => {
      const lines = noteFile(longText).split("\n").filter((l) => l && l !== "0 HEAD" && l !== "0 TRLR");
      for (const line of lines) {
        expect(line.endsWith(" ")).toBe(false);
        const value = line.replace(/^1 CONC |^0 @N1@ NOTE /, "");
        expect(value.startsWith(" ")).toBe(false);
      }
    });

    it("wraps an overlong CONT segment with CONC after the CONT line", () => {
      const value = `first line\n${"x".repeat(300)}`;
      const out = noteFile(value);
      expect(out).toContain("1 CONT x");
      expect(out).toContain("1 CONC x");
      expect(parse(out).records.find((r) => r.tag === "NOTE")?.value).toBe(value);
      for (const line of out.split("\n")) expect(line.length).toBeLessThanOrEqual(LINE_LIMIT_551);
    });

    it("never splits a surrogate pair", () => {
      const value = "👪".repeat(200); // each U+1F46A is two UTF-16 code units
      const out = noteFile(value);
      for (const line of out.split("\n")) {
        const last = line.charCodeAt(line.length - 1);
        expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
      }
      expect(parse(out).records.find((r) => r.tag === "NOTE")?.value).toBe(value);
    });

    it("leaves long lines alone when maxLineLength is unset", () => {
      const out = serializeGedcom([
        { level: 0, xref: "@N1@", tag: "NOTE", value: longText, children: [] },
      ]);
      expect(out).toBe(`0 @N1@ NOTE ${longText}\n`);
    });
  });

  describe("downloadOptions", () => {
    const base = { eol: "\r\n", finalNewline: true } as const;
    it("enables CONC wrapping for 5.5.1 and unknown versions", () => {
      expect(downloadOptions({ ...base, version: "5.5.1" }).maxLineLength).toBe(LINE_LIMIT_551);
      expect(downloadOptions({ ...base, version: "unknown" }).maxLineLength).toBe(LINE_LIMIT_551);
    });
    it("disables CONC wrapping for GEDCOM 7 and keeps line conventions", () => {
      const opts = downloadOptions({ ...base, version: "7.0" });
      expect(opts.maxLineLength).toBeUndefined();
      expect(opts.eol).toBe("\r\n");
      expect(opts.finalNewline).toBe(true);
    });
  });

  describe("ensureUtf8Charset", () => {
    const parse = (text: string) => parseGedcom(new TextEncoder().encode(text).buffer);

    it("rewrites a stale CHAR declaration to UTF-8", () => {
      const parsed = parse("0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR ANSEL\n0 TRLR\n");
      ensureUtf8Charset(parsed.records, { version: parsed.version, charset: "ANSEL" });
      expect(serializeGedcom(parsed.records)).toContain("1 CHAR UTF-8");
      expect(serializeGedcom(parsed.records)).not.toContain("ANSEL");
    });

    it("leaves an already-correct CHAR UTF-8 untouched (byte-faithful)", () => {
      const text = "0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n0 TRLR\n";
      const parsed = parse(text);
      ensureUtf8Charset(parsed.records, { version: parsed.version, charset: "UTF-8" });
      expect(serializeGedcom(parsed.records)).toBe(text);
    });

    it("adds CHAR UTF-8 after GEDC when a non-UTF-8 file declared none", () => {
      const parsed = parse("0 HEAD\n1 SOUR TEST\n1 GEDC\n2 VERS 5.5.1\n0 TRLR\n");
      ensureUtf8Charset(parsed.records, { version: parsed.version, charset: "WINDOWS-1250" });
      expect(serializeGedcom(parsed.records)).toBe(
        "0 HEAD\n1 SOUR TEST\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n0 TRLR\n",
      );
    });

    it("does not add a CHAR line when the source was already UTF-8", () => {
      const text = "0 HEAD\n1 GEDC\n2 VERS 5.5.1\n0 TRLR\n";
      const parsed = parse(text);
      ensureUtf8Charset(parsed.records, { version: parsed.version, charset: "UTF-8" });
      expect(serializeGedcom(parsed.records)).toBe(text);
    });

    it("does not add a CHAR line to a GEDCOM 7 file", () => {
      const text = "0 HEAD\n1 GEDC\n2 VERS 7.0\n0 TRLR\n";
      const parsed = parse(text);
      ensureUtf8Charset(parsed.records, { version: parsed.version, charset: "UNICODE" });
      expect(serializeGedcom(parsed.records)).toBe(text);
    });
  });

  describe("leading at-sign escaping", () => {
    it("doubles a leading @ so the value can't re-read as a pointer", () => {
      const out = serializeGedcom([
        { level: 0, xref: "@N1@", tag: "NOTE", value: "@home with Mother", children: [] },
      ]);
      expect(out).toBe("0 @N1@ NOTE @@home with Mother\n");
    });

    it("escapes each CONT segment's leading @ separately", () => {
      const out = serializeGedcom([
        { level: 0, xref: "@N1@", tag: "NOTE", value: "first\n@second", children: [] },
      ]);
      expect(out).toBe("0 @N1@ NOTE first\n1 CONT @@second\n");
    });

    it("round-trips a file that already uses the @@ escape byte-for-byte", () => {
      const text = ["0 HEAD", "1 GEDC", "2 VERS 5.5.1", "0 @I1@ INDI", "1 NOTE @@home", "0 TRLR", ""].join("\n");
      expect(roundTrip(text)).toBe(text);
    });

    it("leaves pointer values and calendar escapes untouched", () => {
      const text = [
        "0 HEAD",
        "1 GEDC",
        "2 VERS 5.5.1",
        "0 @I1@ INDI",
        "1 BIRT",
        "2 DATE @#DJULIAN@ 14 JAN 1700",
        "1 FAMS @F1@",
        "0 @F1@ FAM",
        "1 HUSB @I1@",
        "0 TRLR",
        "",
      ].join("\n");
      expect(roundTrip(text)).toBe(text);
    });
  });

  it("renders an inserted node tree at the right depth (ignores node.level)", () => {
    const text = serializeGedcom([
      {
        level: 99, // deliberately wrong: depth comes from tree position
        xref: "@I9@",
        tag: "INDI",
        children: [
          { level: 0, tag: "NAME", value: "Ana /Kos/", children: [] },
          {
            level: 0,
            tag: "BIRT",
            children: [{ level: 0, tag: "DATE", value: "1900", children: [] }],
          },
        ],
      },
    ]);
    expect(text).toBe("0 @I9@ INDI\n1 NAME Ana /Kos/\n1 BIRT\n2 DATE 1900\n");
  });
});
