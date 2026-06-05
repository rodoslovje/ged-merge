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
});
