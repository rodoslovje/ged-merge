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
    case "ANSI":
      return { text: decodeWindows1252(bytes), charset: "ANSI", warnings };
    case "ASCII":
      return { text: decodeAscii(bytes), charset: "ASCII", warnings };
    default:
      warnings.push({
        kind: "encoding",
        message: "Could not determine encoding; defaulting to UTF-8.",
      });
      return { text: decodeUtf8(bytes), charset: "UTF-8", warnings };
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
  if (v === "ANSI" || v === "WINDOWS-1252" || v === "CP1252") return "ANSI";
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
