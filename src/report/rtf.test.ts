import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { displayName, primaryName } from "../match/relatives";
import type { Individual } from "../gedcom/types";
import { buildAhnentafel } from "./ahnentafel";
import { buildDescendants } from "./descendants";
import { esc, reportToRtf } from "./rtf";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

/** Identity translator: tests assert on keys, not localized labels. */
const tr = (key: string) => key;
const nameOf = (indi: Individual) => displayName(primaryName(indi));

const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;

// A fixed "today" so the living window is reproducible.
const NOW = 2000;

// Root Janez with parents Anton ⚭ Marija — enough for headings, a marriage
// line and a child group; non-ASCII (č, š) exercises the \u escaping.
const FAMILY = wrap(
  "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1900\n2 PLAC Škofja Loka\n1 DEAT\n2 DATE 1970\n1 FAMC @F1@\n" +
    "0 @I2@ INDI\n1 NAME Anton /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1870\n1 DEAT\n2 DATE 1940\n1 FAMS @F1@\n" +
    "0 @I3@ INDI\n1 NAME Marija /Kovačič/\n1 SEX F\n1 BIRT\n2 DATE 1872\n1 DEAT\n2 DATE 1950\n1 FAMS @F1@\n" +
    "0 @F1@ FAM\n1 HUSB @I2@\n1 WIFE @I3@\n1 CHIL @I1@\n1 MARR\n2 DATE 1895\n",
);

describe("esc (RTF escaping)", () => {
  it("passes ASCII through and escapes the RTF specials", () => {
    expect(esc("plain text")).toBe("plain text");
    expect(esc("a{b}c\\d")).toBe("a\\{b\\}c\\\\d");
  });

  it("encodes non-ASCII as signed-16-bit \\uN? escapes", () => {
    expect(esc("č")).toBe("\\u269?"); // U+010D
    expect(esc("⚭")).toBe("\\u9901?"); // marriage glyph, U+26AD
    expect(esc("†")).toBe("\\u8224?");
    expect(esc("𝄞")).toBe("\\u-10188?\\u-8930?"); // U+1D11E → surrogate pair D834 DD1E
  });

  it("turns newlines into \\line breaks", () => {
    expect(esc("one\ntwo")).toBe("one\\line two");
    expect(esc("one\r\ntwo")).toBe("one\\line two");
  });
});

describe("reportToRtf (ancestors)", () => {
  const data = buildAhnentafel(dataset(FAMILY), "@I1@", nameOf, NOW)!;
  const rtf = reportToRtf(tr, data, "ancestors", "Janez Novak — Ahnentafel");

  it("is a self-contained ASCII RTF document", () => {
    expect(rtf.startsWith("{\\rtf1\\ansi")).toBe(true);
    expect(rtf.endsWith("}")).toBe(true);
    expect(rtf).toContain("{\\fonttbl");
    expect(rtf).toContain("{\\colortbl");
    // Everything non-ASCII must be escaped — readers only get 7-bit bytes.
    expect(/^[\x00-\x7f]*$/.test(rtf)).toBe(true);
  });

  it("renders the title, generation headings and numbered entries", () => {
    expect(rtf).toContain("\\b\\fs30 Janez Novak \\u8212? Ahnentafel\\par");
    expect(rtf).toContain("{\\caps report.gen.root}");
    // Hanging indent: number, tab, bold name, muted years.
    expect(rtf).toContain("1.\\tab {\\b Janez Novak} {\\cf2 1900\\u8211?1970}");
    expect(rtf).toContain("{\\b Marija Kova\\u269?i\\u269?}");
  });

  it("renders fact lines with their glyphs, escaped", () => {
    expect(rtf).toContain("* 1900, \\u352?kofja Loka"); // birth in Škofja Loka
    expect(rtf).toContain("\\u9901? 1895 \\u8212? Marija Kova\\u269?i\\u269?"); // ⚭ 1895 — spouse
    expect(rtf).toContain("\\u8224? 1970"); // † death
  });

  it("redacts presumed-living entries to number + name when asked", () => {
    const recent = buildAhnentafel(
      dataset(wrap("0 @I1@ INDI\n1 NAME Young /X/\n1 BIRT\n2 DATE 1950\n2 PLAC Kranj\n")),
      "@I1@",
      nameOf,
      NOW,
    )!;
    const out = reportToRtf(tr, recent, "ancestors", "T", { privacyLiving: true });
    expect(out).toContain("{\\b Young X}");
    expect(out).not.toContain("1950");
    expect(out).not.toContain("Kranj");
  });
});

describe("reportToRtf (register / options)", () => {
  it("adds the per-union children heading in register generations", () => {
    const data = buildDescendants(dataset(FAMILY), "@I2@", nameOf, NOW)!;
    const rtf = reportToRtf(tr, data, "descendants", "T");
    expect(rtf).toContain("\\i register.childrenOfBoth\\par");
    // NGSQ child numbering: register number + roman child index.
    expect(rtf).toContain("2 I.\\tab {\\b Janez Novak}");
  });

  it("renders notes as italic paragraphs, multi-line via \\line", () => {
    const noted = buildAhnentafel(
      dataset(wrap("0 @I1@ INDI\n1 NAME Solo /One/\n1 NOTE Line one.\n2 CONT Line two.\n1 BIRT\n2 DATE 1900\n")),
      "@I1@",
      nameOf,
      NOW,
      { notes: true },
    )!;
    const rtf = reportToRtf(tr, noted, "ancestors", "T");
    expect(rtf).toContain("\\i\\cf2 Line one.\\line Line two.\\par");
  });

  it("renders linked sources as HYPERLINK fields, plain ones as text", () => {
    const sourced = buildAhnentafel(
      dataset(
        wrap(
          "0 @I1@ INDI\n1 NAME Solo /One/\n1 SOUR @S1@\n1 BIRT\n2 DATE 1900\n2 SOUR @S1@\n3 PAGE fol. 12\n" +
            "0 @S1@ SOUR\n1 TITL Krstna knjiga\n",
        ),
      ),
      "@I1@",
      nameOf,
      NOW,
      { sources: true },
    )!;
    const rtf = reportToRtf(tr, sourced, "ancestors", "T");
    // No URL resolves from this citation — both lines render as plain text.
    expect(rtf).toContain("\\u167? Krstna knjiga\\par"); // § under the person
    expect(rtf).toContain("\\u167? Krstna knjiga, report.source.page\\par"); // paged, under the fact
    expect(rtf).not.toContain("HYPERLINK");
  });

  it("adds a linked table of contents and heading bookmarks when asked", () => {
    const data = buildAhnentafel(dataset(FAMILY), "@I1@", nameOf, NOW)!;
    const rtf = reportToRtf(tr, data, "ancestors", "T", { toc: true });
    expect(rtf).toContain("\\b\\fs24 report.toc\\par");
    // Each TOC row is an internal hyperlink to its generation's bookmark.
    expect(rtf).toContain(
      '{\\field{\\*\\fldinst{HYPERLINK \\\\l "gen1"}}{\\fldrslt report.gen.n \\u8212? ahnentafel.gen.1 \\u183? report.gen.nos}}',
    );
    expect(rtf).toContain("{\\*\\bkmkstart gen1}{\\*\\bkmkend gen1}");
    // Off by default.
    expect(reportToRtf(tr, data, "ancestors", "T")).not.toContain("bkmkstart");
  });

  it("renders the narrative paragraph and numbered footnotes when injected", () => {
    const data = buildAhnentafel(dataset(FAMILY), "@I1@", nameOf, NOW)!;
    const rtf = reportToRtf(tr, data, "ancestors", "T", {
      narrativeOf: (e) => ({
        paragraph: `${e.name} was born.¹`,
        footnotes: [{ source: { text: "§ Book", url: "https://x.si/p/1" } }],
      }),
    });
    expect(rtf).toContain("Janez Novak was born.\\u185?\\par");
    expect(rtf).toContain('{\\field{\\*\\fldinst{HYPERLINK "https://x.si/p/1"}}{\\fldrslt{\\cf4\\ul \\u185? \\u167? Book}}}');
    // Narrative style replaces the glyph fact lines.
    expect(rtf).not.toContain("* 1900");
  });
});
