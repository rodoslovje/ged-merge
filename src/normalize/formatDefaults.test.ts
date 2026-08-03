import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { DATE_PATTERN_CHOICES } from "./formatOverrides";
import { detectFormatDefaults, placeLayoutSample, sampleDateFor } from "./formatDefaults";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;

describe("sampleDateFor", () => {
  it("renders every curated Settings pattern into a concrete date", () => {
    // The replace chain is order-sensitive (MMMM before MMM before MM before M);
    // a reordering would leave literal pattern letters behind. Nothing that
    // looks like an unreplaced token may survive.
    for (const pattern of DATE_PATTERN_CHOICES) {
      const sample = sampleDateFor(pattern);
      expect(sample, pattern).not.toMatch(/[YMD]/);
    }
  });

  it.each([
    ["DD.MM.YYYY", "15.06.1879"],
    ["D.M.YYYY", "15.6.1879"],
    ["YYYY-MM-DD", "1879-06-15"],
    ["MM/DD/YYYY", "06/15/1879"],
    ["D MMM YYYY", "15 JUN 1879"],
    ["DD MMM YYYY", "15 JUN 1879"],
    ["D Mmm YYYY", "15 Jun 1879"],
  ])("renders %s as %s", (pattern, expected) => {
    expect(sampleDateFor(pattern)).toBe(expected);
  });

  it("distinguishes the month-name widths", () => {
    expect(sampleDateFor("MMMM")).toBe("JUNE");
    expect(sampleDateFor("Mmmm")).toBe("June");
    expect(sampleDateFor("mmmm")).toBe("june");
    expect(sampleDateFor("MMM")).toBe("JUN");
    expect(sampleDateFor("mmm")).toBe("jun");
  });

  it("does not let the single-letter rules eat a month name", () => {
    // `M` and `D` only match when not followed by a lowercase letter, so the
    // "Mmm"/"Mmmm" forms must survive the earlier passes intact.
    expect(sampleDateFor("D Mmmm YYYY")).toBe("15 June 1879");
  });

  it("passes separators and unrelated text through untouched", () => {
    expect(sampleDateFor("DD/MM/YYYY")).toBe("15/06/1879");
    expect(sampleDateFor("")).toBe("");
  });
});

describe("detectFormatDefaults", () => {
  it("omits every dimension the file gives no signal for", () => {
    // A bare record: no dates, no places, no sources, no alternate names.
    const out = detectFormatDefaults(dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n")));

    expect(out.date).toBeUndefined();
    expect(out.datePlaceholder).toBeUndefined();
    expect(out.place).toBeUndefined();
    expect(out.names).toBeUndefined();
    expect(out.pageMedia).toBeUndefined();
  });

  it("never carries an explicitly-undefined key, so callers can use `in`", () => {
    const out = detectFormatDefaults(dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n")));

    for (const [key, value] of Object.entries(out)) {
      expect(value, key).toBeDefined();
    }
    expect(Object.keys(out)).not.toContain("place");
  });

  it("reports the file's own date pattern", () => {
    const out = detectFormatDefaults(
      dataset(
        wrap(
          "0 @I1@ INDI\n1 BIRT\n2 DATE 15.06.1879\n" +
            "0 @I2@ INDI\n1 BIRT\n2 DATE 03.11.1881\n" +
            "0 @I3@ INDI\n1 BIRT\n2 DATE 27.01.1885\n",
        ),
      ),
    );
    expect(out.date).toBeDefined();
    expect(sampleDateFor(out.date!)).toMatch(/1879/);
  });

  it("reports a date placeholder only when the file uses dates", () => {
    const withDates = detectFormatDefaults(dataset(wrap("0 @I1@ INDI\n1 BIRT\n2 DATE 1879\n")));
    const without = detectFormatDefaults(dataset(wrap("0 @I1@ INDI\n1 NAME A /B/\n")));

    expect(withDates.datePlaceholder).toBe("none");
    expect(without.datePlaceholder).toBeUndefined();
  });

  it("defaults unknownName to blank when the file uses no placeholder token", () => {
    const out = detectFormatDefaults(dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n")));
    expect(out.unknownName).toBe("blank");
  });

  it("detects a place layout once places are present", () => {
    const out = detectFormatDefaults(
      dataset(
        wrap(
          "0 @I1@ INDI\n1 BIRT\n2 PLAC Kranj, Gorenjska, Slovenija\n" +
            "0 @I2@ INDI\n1 BIRT\n2 PLAC Bled, Gorenjska, Slovenija\n",
        ),
      ),
    );
    expect(out.place).toBeDefined();
    expect(out.place).not.toBe("unknown");
  });

  it("always reports the doubled-links preference as one of its two values", () => {
    const out = detectFormatDefaults(dataset(wrap("0 @I1@ INDI\n1 NAME A /B/\n")));
    expect(["fold", "keep"]).toContain(out.doubledLinks);
  });

  it("picks up the Matricula link language from a cited URL", () => {
    const out = detectFormatDefaults(
      dataset(
        wrap("0 @I1@ INDI\n1 NAME A /B/\n1 WWW https://data.matricula-online.eu/de/slovenia/ljubljana/kranj/\n"),
      ),
    );
    expect(out.matriculaLang).toBe("de");
  });

  it("reports a privacy dialect only when the file marks something private", () => {
    const plain = detectFormatDefaults(dataset(wrap("0 @I1@ INDI\n1 NAME A /B/\n")));
    const marked = detectFormatDefaults(dataset(wrap("0 @I1@ INDI\n1 NAME A /B/\n1 RESN confidential\n")));

    expect(plain.privacy).toBeUndefined();
    expect(marked.privacy).toBe("RESN");
  });

  it("returns override-shaped string values throughout", () => {
    const out = detectFormatDefaults(
      dataset(wrap("0 @I1@ INDI\n1 BIRT\n2 DATE 15.06.1879\n2 PLAC Kranj, Slovenija\n")),
    );
    for (const [key, value] of Object.entries(out)) {
      expect(typeof value, key).toBe("string");
    }
  });

  it("handles an empty dataset without throwing", () => {
    expect(() => detectFormatDefaults(dataset(wrap("")))).not.toThrow();
  });
});

// Settings › GEDCOM shows the place layout and the comma form on two rows, one
// above the other. Both describe how a place is written, so a layout sample
// spelled with a bare comma while the row below says "comma + space" reads as
// a contradiction.
describe("placeLayoutSample", () => {
  it("spells its jurisdictions with the chosen comma form", () => {
    expect(placeLayoutSample("structured-addr", ", ")).toBe("Kranj, Slovenija › ADDR Cesta 1");
    expect(placeLayoutSample("structured-addr", ",")).toBe("Kranj,Slovenija › ADDR Cesta 1");
    expect(placeLayoutSample("plain-structured", ", ")).toBe("Kranj, Slovenija");
    expect(placeLayoutSample("plain-structured", ",")).toBe("Kranj,Slovenija");
  });

  it("leaves the packed layout's address comma alone — it is not that separator", () => {
    const packed = "Cesta 1, Kranj (Slovenija)";
    expect(placeLayoutSample("packed-plac", ", ")).toBe(packed);
    expect(placeLayoutSample("packed-plac", ",")).toBe(packed);
  });

  it("has no jurisdictions to separate in an address-only layout", () => {
    expect(placeLayoutSample("address-only", ", ")).toBe("Cesta 1");
    expect(placeLayoutSample("unknown", ", ")).toBeUndefined();
  });
});
