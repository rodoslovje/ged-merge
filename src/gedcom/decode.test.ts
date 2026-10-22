import { describe, expect, it } from "vitest";
import { decodeGedcom, decodeTableText } from "./decode";

/** Build a byte buffer from a list of byte values. */
function buf(...bytes: number[]): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

/** "1 CHAR <name>\n" as ASCII bytes, then the given high bytes on a NAME line. */
function ged(charLabel: string, nameBytes: number[]): ArrayBuffer {
  const header = `0 HEAD\n1 CHAR ${charLabel}\n1 NAME `;
  const head = [...header].map((c) => c.charCodeAt(0));
  return new Uint8Array([...head, ...nameBytes, 0x0a]).buffer;
}

/** ASCII string to byte values. */
function ascii(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

describe("decodeGedcom charset detection", () => {
  it("decodes ANSI Slovenian text as Windows-1250", () => {
    // 0xE8=č, 0x9A=š, 0x9E=ž in CP1250 (would be è/š/ž in CP1252).
    const { text, charset } = decodeGedcom(ged("ANSI", [0xe8, 0x9a, 0x9e]));
    expect(charset).toBe("WINDOWS-1250");
    expect(text).toContain("čšž");
  });

  it("decodes ANSI Western text as Windows-1252", () => {
    // 0xE9=é, 0xE0=à, 0xE7=ç — no Slavic caron markers present.
    const { text, charset } = decodeGedcom(ged("ANSI", [0xe9, 0xe0, 0xe7]));
    expect(charset).toBe("WINDOWS-1252");
    expect(text).toContain("éàç");
  });

  it("recovers when ASCII is declared but high bytes are present", () => {
    const { charset } = decodeGedcom(ged("ASCII", [0x9e, 0xe8]));
    expect(charset).toBe("WINDOWS-1250");
  });

  it("honors a UTF-8 BOM", () => {
    const { charset } = decodeGedcom(buf(0xef, 0xbb, 0xbf, 0x30, 0x20, 0x48));
    expect(charset).toBe("UTF-8");
  });

  it("prefers UTF-8 for valid multibyte content without a CHAR header", () => {
    const bytes = [...new TextEncoder().encode("0 HEAD\n1 NAME Müller\n")];
    const { text, charset } = decodeGedcom(new Uint8Array(bytes).buffer);
    expect(charset).toBe("UTF-8");
    expect(text).toContain("Müller");
  });

  it("recovers a file declared ANSI whose bytes are actually UTF-8", () => {
    // "Tržič" in UTF-8: ž=C5 BE, č=C4 8D.
    const { text, charset, warnings } = decodeGedcom(
      ged("ANSI", [0x54, 0x72, 0xc5, 0xbe, 0x69, 0xc4, 0x8d]),
    );
    expect(charset).toBe("UTF-8");
    expect(text).toContain("Tržič");
    expect(warnings.some((w) => /valid UTF-8/.test(w.message))).toBe(true);
  });

  it("recovers a file declared UTF-8 whose bytes are actually Windows-1250", () => {
    // CP1250 accented letters separated by ASCII: invalid as UTF-8.
    const { text, charset } = decodeGedcom(ged("UTF-8", [0xc8, 0x2d, 0x9a, 0x2d, 0x9e]));
    expect(charset).toBe("WINDOWS-1250");
    expect(text).toContain("Č-š-ž");
  });

  it("repairs double-encoded (mojibake) UTF-8 text", () => {
    const bytes = [...new TextEncoder().encode("0 HEAD\n1 CHAR UTF-8\n1 NAME GorĹˇiÄŤ\n")];
    const { text, charset, warnings } = decodeGedcom(new Uint8Array(bytes).buffer);
    expect(charset).toBe("UTF-8");
    expect(text).toContain("Goršič");
    expect(text).not.toContain("GorĹˇiÄŤ");
    expect(warnings.some((w) => /mojibake/.test(w.message))).toBe(true);
  });

  it("leaves valid text that only looks like mojibake untouched", () => {
    // "ĂŞ", "ÂŞ" and "Ä€" each strict-decode from CP1250 bytes to one UTF-8
    // letter, but they stand among plain Romanian/Latvian letters that never
    // would: the file is not double-encoded.
    const src = "0 HEAD\n1 CHAR UTF-8\n0 @I1@ INDI\n1 NAME Ion /MUREŞAN/\n2 NOTE BRĂŞOV, ŞTEFĂNEŞTI\n" +
      "0 @I2@ INDI\n1 NAME Ana /Pârâu/\n2 NOTE MÂŞ, Ä€, Rīga, Jēkabpils\n";
    const { text, warnings } = decodeGedcom(new TextEncoder().encode(src).buffer);
    expect(text).toBe(src);
    expect(warnings.some((w) => /mojibake/.test(w.message))).toBe(false);
  });

  it("leaves correctly-encoded German umlauts untouched", () => {
    const bytes = [...new TextEncoder().encode("0 HEAD\n1 CHAR UTF-8\n1 NAME Jäger Ärzte\n")];
    const { text } = decodeGedcom(new Uint8Array(bytes).buffer);
    expect(text).toContain("Jäger Ärzte");
  });

  it("decodes ANSI file that is valid UTF-8 with replacement chars (U+FFFD) as UTF-8", () => {
    // Habsburg.ged scenario: declared ANSI but the actual bytes are valid UTF-8
    // containing U+FFFD (EF BF BD) where umlauts were already lost.
    // EF BF BD = U+FFFD (replacement character, 3-byte UTF-8).
    const { text, charset, warnings } = decodeGedcom(
      ged("ANSI", [0xef, 0xbf, 0xbd, 0x4b, 0xef, 0xbf, 0xbd, 0x6e, 0x69, 0x67]),
    );
    expect(charset).toBe("UTF-8");
    expect(text).toContain("�K�nig");
    expect(warnings.some((w) => /valid UTF-8/.test(w.message))).toBe(true);
    // Tagged, so the save/health-check notice can say the characters are gone
    // for good without matching on the message text.
    expect(warnings.some((w) => w.code === "undecodable")).toBe(true);
  });

  it("heals a UTF-8 character split across a CONC line-wrap boundary (MyHeritage)", () => {
    // MyHeritage wraps long CONT/CONC values at a fixed byte width without
    // checking UTF-8 boundaries: here the lead byte of "ć" (C4 87) ends the
    // NAME line, and the continuation byte begins the next CONC line.
    const bytes = new Uint8Array([
      ...ascii("0 HEAD\n1 CHAR UTF-8\n1 NAME Kra"),
      0xc4,
      ...ascii("\r\n2 CONC "),
      0x87,
      ...ascii("an\n"),
    ]);
    const { text, charset, warnings } = decodeGedcom(bytes.buffer);
    expect(charset).toBe("UTF-8");
    expect(text).toContain("Krać");
    expect(text).not.toContain("�");
    expect(warnings.some((w) => /split across a line-wrap/.test(w.message))).toBe(true);
  });

  it("heals a split character in a UTF-8 file with a BOM", () => {
    const bytes = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...ascii("0 HEAD\n1 NAME Kra"),
      0xc4,
      ...ascii("\r\n2 CONC "),
      0x87,
      ...ascii("an\n"),
    ]);
    const { text, charset } = decodeGedcom(bytes.buffer);
    expect(charset).toBe("UTF-8");
    expect(text).toContain("Krać");
    expect(text).not.toContain("�");
  });
});

describe("decodeGedcom ANSEL table", () => {
  it("decodes the GEDCOM and MARC-8 additions to ANSEL", () => {
    // CF ß (GEDCOM), C7 ß and C8 € (MARC-8), BE □ and BF ■ (GEDCOM boxes),
    // B7 ʺ hard sign, CD/CE midline e/o, FC slash through the letter.
    const { text, warnings } = decodeGedcom(
      ged("ANSEL", [0xcf, 0xc7, 0xc8, 0xbe, 0xbf, 0xb7, 0xcd, 0xce, 0xfc, 0x6f]),
    );
    expect(text).toContain("ßß€□■ʺeo" + "o\u0338");
    expect(warnings.some((w) => /unmapped/.test(w.message))).toBe(false);
  });
});

describe("decodeGedcom other declared charsets", () => {
  it.each([
    // Latin-2: 0xA9 Š, 0xE8 č, 0xBE ž (Windows-1250 has Š at 0x8A, ž at 0x9E).
    ["ISO8859-2", [0xa9, 0xe8, 0xbe], "Ščž", "ISO-8859-2"],
    ["ISO-8859-2", [0xa9, 0xe8, 0xbe], "Ščž", "ISO-8859-2"],
    ["LATIN2", [0xa9, 0xe8, 0xbe], "Ščž", "ISO-8859-2"],
    ["ISO-8859-1", [0xe9, 0xfc], "éü", "ISO-8859-1"],
    ["LATIN1", [0xe9, 0xfc], "éü", "ISO-8859-1"],
    // Mac Roman: 0x8E é, 0x9F ü, 0xA7 ß.
    ["MACINTOSH", [0x8e, 0x9f, 0xa7], "éüß", "MACINTOSH"],
    // DOS code pages: 0x82 é, 0x81 ü, 0xE1 ß in both; 0x9B is ¢ in 437, ø in 850.
    ["IBMPC", [0x82, 0x81, 0xe1, 0x9b], "éüß¢", "IBM437"],
    ["IBM850", [0x82, 0x81, 0xe1, 0x9b], "éüßø", "IBM850"],
  ])("decodes CHAR %s with its own code page", (label, bytes, expected, charset) => {
    const res = decodeGedcom(ged(label, bytes));
    expect(res.text).toContain(expected);
    expect(res.charset).toBe(charset);
  });

  it.each(["IBMPC", "IBM850"])("maps every high byte of CHAR %s to one character", (label) => {
    const high = Array.from({ length: 128 }, (_, i) => 0x80 + i);
    const { text } = decodeGedcom(ged(label, high));
    const name = [...text.split("NAME ")[1].replace(/\n$/, "")];
    expect(name).toHaveLength(128);
    expect(name.join("")).not.toMatch(/undefined|�/);
  });
});

describe("decodeGedcom with classic-Mac (CR-only) line endings", () => {
  it("reads the declared CHAR from a CR-only header", () => {
    // ANSEL 0xE2 = combining acute before its letter: "é".
    const bytes = new Uint8Array([...ascii("0 HEAD\r1 CHAR ANSEL\r1 NAME Ren"), 0xe2, 0x65, 0x0d]);
    const { text, charset } = decodeGedcom(bytes.buffer);
    expect(charset).toBe("ANSEL");
    expect(text).toContain("René");
  });

  it("heals a UTF-8 character split across a CR-only CONC wrap", () => {
    const bytes = new Uint8Array([
      ...ascii("0 HEAD\r1 CHAR UTF-8\r1 NAME Kra"),
      0xc4,
      ...ascii("\r2 CONC "),
      0x87,
      ...ascii("an\r"),
    ]);
    const { text } = decodeGedcom(bytes.buffer);
    expect(text).toContain("Krać");
    expect(text).not.toContain("�");
  });
});

describe("decodeTableText (CSV bytes with no charset header)", () => {
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

  it("decodes valid UTF-8 as UTF-8", () => {
    const bytes = new TextEncoder().encode("Ime;Priimek\nJanez;Goršič\n");
    expect(decodeTableText(bytes.buffer)).toBe("Ime;Priimek\nJanez;Goršič\n");
  });

  it("strips a UTF-8 BOM", () => {
    const body = new TextEncoder().encode("a;b\n");
    expect(decodeTableText(buf(0xef, 0xbb, 0xbf, ...body))).toBe("a;b\n");
  });

  it("decodes an Excel export on a Slovenian Windows (Windows-1250) so š/č/ž survive", () => {
    // "Goršič" in cp1250: š = 0x9a, č = 0xe8
    const bytes = buf(...ascii("Ime;Priimek\nJanez;Gor"), 0x9a, 0x69, 0xe8, 0x0a);
    expect(decodeTableText(bytes)).toBe("Ime;Priimek\nJanez;Goršič\n");
  });

  it("decodes Windows-1252 when no Central-European marker byte is present", () => {
    const bytes = buf(...ascii("M"), 0xfc, ...ascii("ller\n")); // ü in cp1252
    expect(decodeTableText(bytes)).toBe("Müller\n");
  });

  it("decodes UTF-16 LE with a BOM (Excel's 'Unicode text')", () => {
    const text = "a\tš\n";
    const u16 = new Uint8Array(2 + text.length * 2);
    u16[0] = 0xff; u16[1] = 0xfe;
    for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); u16[2 + i * 2] = c & 0xff; u16[3 + i * 2] = c >> 8; }
    expect(decodeTableText(u16.buffer)).toBe(text);
  });
});
