/** Low-level string-similarity primitives used across the matcher. */

/** Lowercase, strip diacritics, collapse whitespace. */
export function foldToken(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Jaro similarity (0..1). */
function jaro(a: string, b: string): number {
  if (a === b) return 1;
  const la = a.length;
  const lb = b.length;
  if (la === 0 || lb === 0) return 0;

  const matchDist = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const aMatched = new Array<boolean>(la).fill(false);
  const bMatched = new Array<boolean>(lb).fill(false);

  let matches = 0;
  for (let i = 0; i < la; i++) {
    const start = Math.max(0, i - matchDist);
    const end = Math.min(i + matchDist + 1, lb);
    for (let j = start; j < end; j++) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < la; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions /= 2;

  return (matches / la + matches / lb + (matches - transpositions) / matches) / 3;
}

/** Jaro-Winkler similarity (0..1) — rewards a shared prefix (typos/variants). */
export function jaroWinkler(a: string, b: string): number {
  const j = jaro(a, b);
  let prefix = 0;
  const max = Math.min(4, a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }
  return j + prefix * 0.1 * (1 - j);
}

const SOUNDEX_CODES: Record<string, number> = {
  B: 1, F: 1, P: 1, V: 1,
  C: 2, G: 2, J: 2, K: 2, Q: 2, S: 2, X: 2, Z: 2,
  D: 3, T: 3,
  L: 4,
  M: 5, N: 5,
  R: 6,
};

/**
 * Padded character trigrams of a folded string, e.g. "Hribar" -> [" hr", "hri",
 * "rib", "iba", "bar", "ar "]. Used for blocking: unlike Soundex, trigrams don't
 * anchor on the first letter, so they still find candidates when the first
 * letter itself differs (e.g. "Hribar"/"Gribar" transliteration variants).
 */
export function trigrams(s: string): string[] {
  const padded = ` ${foldToken(s)} `;
  if (padded.length < 3) return [];
  const out: string[] = [];
  for (let i = 0; i <= padded.length - 3; i++) {
    out.push(padded.slice(i, i + 3));
  }
  return out;
}

/** Soundex phonetic code (e.g. "Smith"/"Smyth" -> "S530"). Used for blocking. */
export function soundex(s: string): string {
  const letters = foldToken(s).toUpperCase().replace(/[^A-Z]/g, "");
  if (letters === "") return "";

  let result = letters[0];
  let prev = SOUNDEX_CODES[letters[0]] ?? 0;

  for (let i = 1; i < letters.length && result.length < 4; i++) {
    const ch = letters[i];
    const code = SOUNDEX_CODES[ch] ?? 0;
    if (code !== 0 && code !== prev) result += code;
    // H and W are transparent: they don't reset the previous code.
    if (ch !== "H" && ch !== "W") prev = code;
  }
  return (result + "000").slice(0, 4);
}
