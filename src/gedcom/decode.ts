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
    return decodeAsUtf8(bytes.subarray(3), warnings, false);
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
      return decodeAsUtf8(bytes, warnings, true);
    case "UNICODE":
      // No BOM but declared UNICODE: assume little-endian, the common case.
      warnings.push({
        kind: "encoding",
        message: "CHAR UNICODE without BOM; assuming little-endian UTF-16.",
      });
      return { text: decodeUtf16(bytes, true), charset: "UNICODE", warnings };
    case "ANSEL":
      if (isMislabelledUtf8(bytes)) return mislabelledUtf8(bytes, warnings, "ANSEL");
      return { text: decodeAnsel(bytes, warnings), charset: "ANSEL", warnings };
    case "WINDOWS-1250":
      if (isMislabelledUtf8(bytes)) return mislabelledUtf8(bytes, warnings, "WINDOWS-1250");
      return { text: decodeWindows1250(bytes), charset: "WINDOWS-1250", warnings };
    case "WINDOWS-1252":
      if (isMislabelledUtf8(bytes)) return mislabelledUtf8(bytes, warnings, "WINDOWS-1252");
      return { text: decodeWindows1252(bytes), charset: "WINDOWS-1252", warnings };
    case "ANSI":
      if (isMislabelledUtf8(bytes)) return mislabelledUtf8(bytes, warnings, "ANSI");
      // "ANSI" is locale-dependent: it usually means Windows-1252 (Western), but
      // Central-European exporters (Brother's Keeper etc.) emit Windows-1250.
      // Detect which from the byte profile.
      return decodeWindowsAnsi(bytes, warnings, "CHAR ANSI");
    case "ASCII":
      // ASCII shouldn't carry high bytes; when it does the label is wrong, so
      // fall back to UTF-8 (if valid) or Windows-codepage detection.
      if (hasHighBytes(bytes)) {
        if (isMislabelledUtf8(bytes)) return mislabelledUtf8(bytes, warnings, "ASCII");
        return decodeWindowsAnsi(bytes, warnings, "CHAR ASCII with non-ASCII bytes");
      }
      return { text: decodeAscii(bytes), charset: "ASCII", warnings };
    default:
      // No usable CHAR: prefer UTF-8 when the bytes are valid UTF-8; otherwise
      // it's some legacy 8-bit encoding, so detect the Windows codepage.
      if (!hasHighBytes(bytes) || isValidUtf8(bytes)) {
        return utf8Result(bytes, warnings);
      }
      return decodeWindowsAnsi(bytes, warnings, "no CHAR header; bytes are not valid UTF-8");
  }
}

/** Note a charset that was declared wrong, then decode the bytes as UTF-8. */
function mislabelledUtf8(
  bytes: Uint8Array,
  warnings: ParseWarning[],
  declared: string,
): DecodeResult {
  warnings.push({
    kind: "encoding",
    message: `CHAR ${declared} but the bytes are valid UTF-8; decoding as UTF-8.`,
  });
  return utf8Result(bytes, warnings);
}

/**
 * Decode bytes known (BOM) or declared (CHAR UTF-8) to be UTF-8, healing a
 * MyHeritage-style split multi-byte character across a CONC/CONT line wrap
 * first if the buffer isn't already valid. When `allowCodepageFallback` is
 * true and healing doesn't fully fix it, falls through to the existing
 * mislabelled-8-bit heuristic; a BOM is an unambiguous UTF-8 signal, so that
 * guesswork doesn't apply there.
 */
function decodeAsUtf8(
  bytes: Uint8Array,
  warnings: ParseWarning[],
  allowCodepageFallback: boolean,
): DecodeResult {
  if (isValidUtf8(bytes)) return utf8Result(bytes, warnings);
  const { bytes: healed, count } = healSplitUtf8AcrossConc(bytes);
  if (count > 0 && isValidUtf8(healed)) {
    warnings.push({
      kind: "encoding",
      message: `Repaired ${count} multi-byte character(s) split across a line-wrap boundary.`,
    });
    return utf8Result(healed, warnings);
  }
  if (allowCodepageFallback) return recoverInvalidUtf8(healed, warnings);
  return utf8Result(healed, warnings);
}

/**
 * Reassemble multi-byte UTF-8 characters split by a GEDCOM line-wrap: the
 * lead byte(s) end one physical line, and the exporter starts a fresh
 * `<level> CONC `/`<level> CONT ` line right in the middle of the character,
 * so the remaining continuation byte(s) begin the next line's content. Moves
 * the completing byte(s) back before the line-break marker, closing the gap,
 * so the character decodes correctly and the CONC/CONT line structure is
 * otherwise untouched (its own remaining content still follows the marker).
 */
function healSplitUtf8AcrossConc(bytes: Uint8Array): { bytes: Uint8Array; count: number } {
  const out: number[] = [];
  let count = 0;
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const b = bytes[i];
    const seqLen = utf8LeadLen(b);
    if (seqLen > 1) {
      let have = 0;
      while (have < seqLen - 1 && (bytes[i + 1 + have] & 0xc0) === 0x80) have++;
      if (have < seqLen - 1) {
        const breakStart = i + 1 + have;
        const markerLen = matchConcOrContBreak(bytes, breakStart);
        if (markerLen !== undefined) {
          const need = seqLen - 1 - have;
          const contStart = breakStart + markerLen;
          let complete = true;
          for (let k = 0; k < need; k++) {
            if ((bytes[contStart + k] & 0xc0) !== 0x80) {
              complete = false;
              break;
            }
          }
          if (complete) {
            out.push(b);
            for (let k = 0; k < have; k++) out.push(bytes[i + 1 + k]);
            for (let k = 0; k < need; k++) out.push(bytes[contStart + k]);
            for (let k = 0; k < markerLen; k++) out.push(bytes[breakStart + k]);
            count++;
            i = contStart + need;
            continue;
          }
        }
      }
    }
    out.push(b);
    i++;
  }
  return count > 0 ? { bytes: Uint8Array.from(out), count } : { bytes, count: 0 };
}

/** UTF-8 sequence length for a lead byte (1 for ASCII/continuation/invalid). */
function utf8LeadLen(b: number): number {
  if (b < 0x80) return 1;
  if ((b & 0xe0) === 0xc0) return 2;
  if ((b & 0xf0) === 0xe0) return 3;
  if ((b & 0xf8) === 0xf0) return 4;
  return 1;
}

/** Matches `(\r\n|\n)<digits> (CONC|CONT) ` at `pos`; returns its byte length, or undefined. */
function matchConcOrContBreak(bytes: Uint8Array, pos: number): number | undefined {
  let i = pos;
  const n = bytes.length;
  if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a) i += 2;
  else if (bytes[i] === 0x0a) i += 1;
  else return undefined;
  const digitsStart = i;
  while (i < n && bytes[i] >= 0x30 && bytes[i] <= 0x39) i++;
  if (i === digitsStart || bytes[i] !== 0x20) return undefined;
  i += 1;
  const tag = String.fromCharCode(bytes[i] ?? 0, bytes[i + 1] ?? 0, bytes[i + 2] ?? 0, bytes[i + 3] ?? 0);
  if (tag !== "CONC" && tag !== "CONT") return undefined;
  i += 4;
  if (bytes[i] !== 0x20) return undefined;
  return i + 1 - pos;
}

/**
 * Bytes declared UTF-8 that don't fully validate. A genuine 8-bit file
 * mislabelled as UTF-8 yields about one undecodable byte per accented letter, so
 * roughly as many replacements as high bytes; real UTF-8 with sparse damage
 * yields only a handful. Use that ratio to pick the recovery path.
 */
function recoverInvalidUtf8(bytes: Uint8Array, warnings: ParseWarning[]): DecodeResult {
  const text = decodeUtf8(bytes);
  const replacements = countChar(text, "�");
  const high = countHighBytes(bytes);
  if (replacements > 0 && replacements * 4 >= high) {
    warnings.push({
      kind: "encoding",
      message: "CHAR UTF-8 but the bytes are not valid UTF-8; decoding as a Windows codepage.",
    });
    return decodeWindowsAnsi(bytes, warnings, "CHAR UTF-8 but invalid");
  }
  return utf8Result(bytes, warnings);
}

/**
 * Decode UTF-8, then repair double-encoding (mojibake) and surface any bytes
 * that could not be decoded. Double-encoding happens when CP1250 text was read
 * as UTF-8 once too often, leaving sequences like "GorĹˇiÄŤ" for "Goršič".
 */
function utf8Result(bytes: Uint8Array, warnings: ParseWarning[]): DecodeResult {
  let text = decodeUtf8(bytes);
  const { text: repaired, count } = repairMojibake(text);
  if (count > 0) {
    text = repaired;
    warnings.push({
      kind: "encoding",
      message: `Repaired ${count} double-encoded (mojibake) text run(s).`,
    });
  }
  const bad = countChar(text, "�");
  if (bad > 0) {
    warnings.push({
      kind: "encoding",
      message: `${bad} byte(s) could not be decoded and were replaced with �; the source file may be corrupted.`,
    });
  }
  return { text, charset: "UTF-8", warnings };
}

function countChar(text: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text[i] === ch) n++;
  return n;
}

function countHighBytes(bytes: Uint8Array): number {
  let n = 0;
  for (const b of bytes) if (b >= 0x80) n++;
  return n;
}

/**
 * Whether the bytes contain a UTF-8 two-byte sequence with a lead in 0xC2–0xDF —
 * the range that encodes Latin-1/Latin-Extended letters (š, č, ž, ä, …). Real
 * Central-European UTF-8 always has these; a coincidentally-valid 8-bit run
 * (often a 3-byte CJK sequence) does not.
 */
function hasLatinMultibyte(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length - 1; i++) {
    if (bytes[i] >= 0xc2 && bytes[i] <= 0xdf && (bytes[i + 1] & 0xc0) === 0x80) return true;
  }
  return false;
}

/**
 * Whether the bytes contain the UTF-8 encoding of U+FFFD (EF BF BD). The
 * replacement character is an unambiguous UTF-8 signal: it has no meaning in
 * 8-bit encodings and only appears in files that were already processed as
 * Unicode (e.g. a Windows-1252 file exported to UTF-8 with the original chars
 * already lost, as seen in files like Habsburg.ged).
 */
function hasReplacementChar(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length - 2; i++) {
    if (bytes[i] === 0xef && bytes[i + 1] === 0xbf && bytes[i + 2] === 0xbd) return true;
  }
  return false;
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

/**
 * Whether a non-UTF-8 declared charset is actually UTF-8 bytes mislabelled.
 * Only called from branches that need it, so files declaring (and decoding
 * as) UTF-8 or UNICODE — the common case — never pay for this check.
 *
 * Trusts the bytes over an 8-bit label whenever they're valid UTF-8 *and*
 * carry a Latin two-byte sequence (as all real Slovenian/German UTF-8 does).
 * Requiring the Latin lead avoids treating a short 8-bit run that is
 * coincidentally valid UTF-8 (e.g. a CJK-range 3-byte sequence like 0xE8 0x9A
 * 0x9E = U+689E) as mislabelled. The UTF-8 replacement character U+FFFD (EF
 * BF BD) is also accepted as an unambiguous signal — it cannot meaningfully
 * appear in 8-bit text.
 */
function isMislabelledUtf8(bytes: Uint8Array): boolean {
  return isValidUtf8(bytes) && (hasLatinMultibyte(bytes) || hasReplacementChar(bytes));
}

/** Peek at the first ~2KB as Latin-1 and look for `1 CHAR <value>`. */
function sniffDeclaredCharset(bytes: Uint8Array): GedcomCharset | undefined {
  const head = bytes.subarray(0, Math.min(bytes.length, 2048));
  let ascii = "";
  for (const b of head) ascii += String.fromCharCode(b);
  const m = ascii.match(/\n\s*1\s+CHAR\s+([\w-]+)/i);
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

/** Char → Windows-1250 byte, built by inverting the decoder (0x80–0xFF). */
const CP1250_ENCODE: Map<string, number> = (() => {
  const map = new Map<string, number>();
  const dec = new TextDecoder("windows-1250");
  for (let b = 0x80; b <= 0xff; b++) {
    const ch = dec.decode(Uint8Array.of(b));
    if (ch && ch !== "�") map.set(ch, b);
  }
  return map;
})();

/** A CP1250-misread UTF-8 lead byte (Â/Ã/Ä/Å/Ĺ/Ă) next to another high char. */
const MOJIBAKE_SIGNATURE = /[ÂÃÄÅĹĂ][\u0080-\uffff]/;

/**
 * Repair double-encoded (mojibake) text in place. We scan each run of non-ASCII
 * characters; if it begins with a tell-tale lead character, we re-encode the run
 * as Windows-1250 bytes and decode those *strictly* as UTF-8. The strict decode
 * only succeeds for genuine mojibake, so correctly-encoded text (incl. legitimate
 * German umlauts) is left untouched.
 */
function repairMojibake(text: string): { text: string; count: number } {
  if (!MOJIBAKE_SIGNATURE.test(text)) return { text, count: 0 };
  let count = 0;
  const out = text.replace(/[\u0080-\uffff]+/g, (run) => {
    if (!/[ÂÃÄÅĹĂ]/.test(run)) return run;
    const fixed = roundTripCp1250(run);
    if (fixed !== undefined && fixed !== run) {
      count++;
      return fixed;
    }
    return run;
  });
  return { text: out, count };
}

/** Re-encode a run as Windows-1250 bytes and strict-decode as UTF-8, or undefined. */
function roundTripCp1250(run: string): string | undefined {
  const bytes: number[] = [];
  for (const ch of run) {
    const code = ch.codePointAt(0)!;
    if (code < 0x80) {
      bytes.push(code);
      continue;
    }
    const b = CP1250_ENCODE.get(ch);
    if (b === undefined) return undefined; // not representable → not this kind of mojibake
    bytes.push(b);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return undefined;
  }
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
