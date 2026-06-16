import { describe, expect, it } from "vitest";
import { decodeGedcom } from "./decode";

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
  });
});
