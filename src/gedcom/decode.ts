import type { GedcomCharset, ParseWarning } from "./types";

/**
 * Decode raw GEDCOM bytes into a JavaScript string.
 *
 * GEDCOM is awkward because the declared encoding (HEAD.CHAR) is itself stored
 * *inside* the encoded bytes. We handle this in three steps:
 *   1. Check for a BOM (settles UTF-8 / UTF-16 immediately).
 *   2. Otherwise peek at the header as ASCII to read `1 CHAR <value>`.
 *   3. Decode the whole buffer with the resolved charset.
 */
export interface DecodeResult {
  text: string;
  charset: GedcomCharset;
  warnings: ParseWarning[];
}

export function decodeGedcom(buffer: ArrayBuffer): DecodeResult {
  const bytes = new Uint8Array(buffer);
  const warnings: ParseWarning[] = [];

  // 1. BOM sniffing.
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: decodeUtf8(bytes.subarray(3)), charset: "UTF-8", warnings };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: decodeUtf16(bytes.subarray(2), true), charset: "UNICODE", warnings };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: decodeUtf16(bytes.subarray(2), false), charset: "UNICODE", warnings };
  }

  // 2. Read the declared charset from the header (ASCII-safe peek).
  const declared = sniffDeclaredCharset(bytes);

  switch (declared) {
    case "UTF-8":
      return { text: decodeUtf8(bytes), charset: "UTF-8", warnings };
    case "UNICODE":
      // No BOM but declared UNICODE: assume little-endian, the common case.
      warnings.push({
        kind: "encoding",
        message: "CHAR UNICODE without BOM; assuming little-endian UTF-16.",
      });
      return { text: decodeUtf16(bytes, true), charset: "UNICODE", warnings };
    case "ANSEL":
      return { text: decodeAnsel(bytes, warnings), charset: "ANSEL", warnings };
    case "WINDOWS-1250":
      return { text: decodeWindows1250(bytes), charset: "WINDOWS-1250", warnings };
    case "WINDOWS-1252":
      return { text: decodeWindows1252(bytes), charset: "WINDOWS-1252", warnings };
    case "ANSI":
      // "ANSI" is locale-dependent: it usually means Windows-1252 (Western), but
      // Central-European exporters (Brother's Keeper etc.) emit Windows-1250.
      // Detect which from the byte profile.
      return decodeWindowsAnsi(bytes, warnings, "CHAR ANSI");
    case "ASCII":
      // ASCII shouldn't carry high bytes; when it does the label is wrong, so
      // fall back to the same Windows-codepage detection.
      if (hasHighBytes(bytes)) {
        return decodeWindowsAnsi(bytes, warnings, "CHAR ASCII with non-ASCII bytes");
      }
      return { text: decodeAscii(bytes), charset: "ASCII", warnings };
    default:
      // No usable CHAR: prefer UTF-8 when the bytes are valid UTF-8; otherwise
      // it's some legacy 8-bit encoding, so detect the Windows codepage.
      if (!hasHighBytes(bytes) || isValidUtf8(bytes)) {
        return { text: decodeUtf8(bytes), charset: "UTF-8", warnings };
      }
      return decodeWindowsAnsi(bytes, warnings, "no CHAR header; bytes are not valid UTF-8");
  }
}

/**
 * Decode an "ANSI"/legacy 8-bit buffer, choosing between Windows-1250 and
 * Windows-1252. The two share most code points but differ on the 0xC0-0xFF
 * Latin letters; the giveaway for Central-European text is the presence of the
 * caron letters Š/š/Ž/ž (and code points left undefined by Windows-1252).
 */
function decodeWindowsAnsi(
  bytes: Uint8Array,
  warnings: ParseWarning[],
  reason: string,
): DecodeResult {
  const cp1250 = looksLikeWindows1250(bytes);
  if (cp1250) {
    warnings.push({
      kind: "encoding",
      message: `${reason}: detected Central-European text, decoding as Windows-1250.`,
    });
    return { text: decodeWindows1250(bytes), charset: "WINDOWS-1250", warnings };
  }
  if (reason !== "CHAR ANSI") {
    warnings.push({ kind: "encoding", message: `${reason}: decoding as Windows-1252.` });
  }
  return { text: decodeWindows1252(bytes), charset: "WINDOWS-1252", warnings };
}

/**
 * Bytes that signal Windows-1250 (Central European). Š/š/Ž/ž are caron letters
 * that essentially only occur in Central/SE-European text, and 0x81/0x8D/0x8F/
 * 0x90/0x9D are undefined in Windows-1252 but are valid letters in 1250.
 */
const CP1250_MARKERS = new Set<number>([
  0x8a, 0x9a, 0x8e, 0x9e, // Š š Ž ž
  0x81, 0x8d, 0x8f, 0x90, 0x9d, // undefined in Windows-1252
]);

function looksLikeWindows1250(bytes: Uint8Array): boolean {
  for (const b of bytes) {
    if (CP1250_MARKERS.has(b)) return true;
  }
  return false;
}

function hasHighBytes(bytes: Uint8Array): boolean {
  for (const b of bytes) {
    if (b >= 0x80) return true;
  }
  return false;
}

function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Peek at the first ~2KB as Latin-1 and look for `1 CHAR <value>`. */
function sniffDeclaredCharset(bytes: Uint8Array): GedcomCharset | undefined {
  const head = bytes.subarray(0, Math.min(bytes.length, 2048));
  let ascii = "";
  for (const b of head) ascii += String.fromCharCode(b);
  const m = ascii.match(/\n\s*1\s+CHAR\s+(\w+)/i);
  if (!m) return undefined;
  const v = m[1].toUpperCase();
  if (v === "UTF-8" || v === "UTF8") return "UTF-8";
  if (v === "UNICODE" || v === "UTF-16") return "UNICODE";
  if (v === "ANSEL") return "ANSEL";
  if (v === "ASCII") return "ASCII";
  if (v === "WINDOWS-1250" || v === "CP1250") return "WINDOWS-1250";
  if (v === "WINDOWS-1252" || v === "CP1252") return "WINDOWS-1252";
  if (v === "ANSI") return "ANSI";
  return undefined;
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

function decodeAscii(bytes: Uint8Array): string {
  return new TextDecoder("ascii").decode(bytes);
}

function decodeWindows1252(bytes: Uint8Array): string {
  return new TextDecoder("windows-1252").decode(bytes);
}

function decodeWindows1250(bytes: Uint8Array): string {
  return new TextDecoder("windows-1250").decode(bytes);
}

function decodeUtf16(bytes: Uint8Array, littleEndian: boolean): string {
  return new TextDecoder(littleEndian ? "utf-16le" : "utf-16be").decode(bytes);
}

/**
 * ANSEL decoder (a subset). ANSEL is the legacy GEDCOM 5.5.1 encoding. 0x00-0x7F
 * is ASCII. 0xA0-0xCF are spacing special characters; 0xE0-0xFE are *combining*
 * diacritics that precede the base letter (the reverse of Unicode order).
 *
 * This covers the common Latin diacritics; unmapped bytes are passed through and
 * a single warning is raised. A full ANSEL table can be slotted in later.
 */
function decodeAnsel(bytes: Uint8Array, warnings: ParseWarning[]): string {
  let out = "";
  let pendingCombiners: string[] = [];
  let sawUnmapped = false;

  for (const b of bytes) {
    if (b < 0x80) {
      out += applyCombiners(String.fromCharCode(b), pendingCombiners);
      pendingCombiners = [];
      continue;
    }
    const combiner = ANSEL_COMBINING[b];
    if (combiner) {
      pendingCombiners.push(combiner);
      continue;
    }
    const special = ANSEL_SPECIAL[b];
    if (special) {
      out += special;
      continue;
    }
    sawUnmapped = true;
    out += "�";
  }

  if (sawUnmapped) {
    warnings.push({
      kind: "encoding",
      message: "Some ANSEL bytes were unmapped and replaced with �.",
    });
  }
  return out.normalize("NFC");
}

function applyCombiners(base: string, combiners: string[]): string {
  if (combiners.length === 0) return base;
  // Unicode order: base char first, then combining marks.
  return (base + combiners.join("")).normalize("NFC");
}

/** ANSEL combining diacritics (0xE0-0xFE) → Unicode combining marks. */
const ANSEL_COMBINING: Record<number, string> = {
  0xe0: "̉", // hook above
  0xe1: "̀", // grave
  0xe2: "́", // acute
  0xe3: "̂", // circumflex
  0xe4: "̃", // tilde
  0xe5: "̄", // macron
  0xe6: "̆", // breve
  0xe7: "̇", // dot above
  0xe8: "̈", // umlaut/diaeresis
  0xe9: "̌", // caron/hacek
  0xea: "̊", // ring above
  0xeb: "͡", // ligature left half
  0xec: "̕", // comma above right
  0xed: "̋", // double acute
  0xee: "̐", // candrabindu
  0xef: "̧", // cedilla
  0xf0: "̨", // ogonek
  0xf1: "̣", // dot below
  0xf2: "̤", // double dot below
  0xf3: "̥", // ring below
  0xf4: "̳", // double low line
  0xf5: "̲", // low line
  0xf6: "̦", // comma below
  0xf7: "̜", // left half ring below
  0xf8: "̮", // breve below
  0xf9: "͠", // double tilde left half
  0xfa: "͢", // double inverted breve
  0xfe: "̓", // comma above
};

/** ANSEL spacing special characters (0xA0-0xCF). */
const ANSEL_SPECIAL: Record<number, string> = {
  0xa1: "Ł", // Ł
  0xa2: "Ø", // Ø
  0xa3: "Đ", // Đ
  0xa4: "Þ", // Þ
  0xa5: "Æ", // Æ
  0xa6: "Œ", // Œ
  0xa7: "ʹ", // modifier prime
  0xa8: "·", // middle dot
  0xa9: "♭", // music flat
  0xaa: "®", // ®
  0xab: "±", // ±
  0xac: "Ơ", // Ơ
  0xad: "Ư", // Ư
  0xae: "ʼ", // modifier apostrophe
  0xb0: "ʻ", // ʻ ayn
  0xb1: "ł", // ł
  0xb2: "ø", // ø
  0xb3: "đ", // đ
  0xb4: "þ", // þ
  0xb5: "æ", // æ
  0xb6: "œ", // œ
  0xb8: "ı", // ı dotless i
  0xb9: "£", // £
  0xba: "ð", // ð
  0xbc: "ơ", // ơ
  0xbd: "ư", // ư
  0xc0: "°", // °
  0xc1: "ℓ", // ℓ
  0xc2: "℗", // ℗
  0xc3: "©", // ©
  0xc4: "♯", // music sharp
  0xc5: "¿", // ¿
  0xc6: "¡", // ¡
};
