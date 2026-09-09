/** Low-level string-similarity primitives used across the matcher and review layer. */

/**
 * Memo caches for the two hottest, purest primitives below. `foldToken` runs an
 * expensive `NFD` normalize + Unicode-property regex, and both it and
 * `jaroWinkler` are called repeatedly on the *same* inputs across the matcher's
 * inner loop (a main-side surname is folded — and compared — once per candidate
 * it's paired with, and again in the gate and each scoring pass). Caching by
 * input collapses that redundancy. Both functions are pure, so a hit is always
 * valid; {@link clearTextCaches} resets them between match runs so the
 * jaro-winkler pair cache can't grow without bound over many reloads.
 */
const foldCache = new Map<string, string>();
/** Two-level, keyed by the two strings themselves: a concatenated pair key
 *  meant building — and hashing — a fresh string per lookup, which cost more
 *  than the similarity it saved. */
let jaroWinklerCache = new Map<string, Map<string, number>>();
let jaroWinklerCacheSize = 0;

/** Entries the jaro-winkler pair cache may hold before it is emptied and
 *  refilled. A 500k-person duplicate scan compares tens of millions of
 *  distinct pairs; unbounded, the cache outgrew the dataset itself and the
 *  collector, not the scorer, set the pace. Hits are overwhelmingly local (a
 *  surname against its own block), so a refill costs little. */
const JARO_WINKLER_CACHE_MAX = 1_000_000;

/** Reset the memo caches — called at the start of each match run. */
export function clearTextCaches(): void {
  foldCache.clear();
  jaroWinklerCache = new Map();
  jaroWinklerCacheSize = 0;
}

/** Lowercase, strip diacritics, collapse whitespace. Memoized (see above). */
export function foldToken(s: string): string {
  let folded = foldCache.get(s);
  if (folded === undefined) {
    folded = s
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    foldCache.set(s, folded);
  }
  return folded;
}

/**
 * Placeholder tokens masquerading as name parts. Real files are full of them:
 * privacy-scrubbed exports ("Living", "Privat"/"Private"), unknown-name
 * markers ("NN", "N.N.", "nn", "neznan/-a/-o", "unknown"/"unbekannt"), and
 * template placeholders ("?Ime?", "?Priimek?" — Slovene for name/surname).
 */
const PLACEHOLDER_NAME_TOKENS = new Set([
  "nn",
  "living",
  "privat",
  "private",
  "unknown",
  "unbekannt",
  "neznan",
  "neznana",
  "neznano",
  "ime",
  "priimek",
]);

/**
 * True when a recorded name part carries no identifying content — a
 * placeholder, not a name. Compared literally, placeholders match each other
 * *perfectly* ("Living" ~ "Living" = 1.0), flooding results with pairs of
 * unnamed siblings and privacy-scrubbed strangers; matching must treat them
 * as missing instead. A value is a placeholder when every letter-token is
 * either a known placeholder word or a bare initial, or when it contains no
 * letters at all ("?", "???", "__"). Display code keeps showing the original
 * text — this is a matching-layer judgement only.
 */
export function isPlaceholderName(value: string): boolean {
  const tokens = foldToken(value)
    .split(/[^\p{L}]+/u)
    .filter(Boolean);
  if (tokens.length === 0) return true; // no letters at all: "?", "___", "..."
  return tokens.every((t) => t.length <= 1 || PLACEHOLDER_NAME_TOKENS.has(t));
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

/** Jaro-Winkler similarity (0..1) — rewards a shared prefix (typos/variants).
 *  Memoized by input pair (see {@link clearTextCaches}). */
export function jaroWinkler(a: string, b: string): number {
  let row = jaroWinklerCache.get(a);
  const cached = row?.get(b);
  if (cached !== undefined) return cached;
  const j = jaro(a, b);
  let prefix = 0;
  const max = Math.min(4, a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }
  const value = j + prefix * 0.1 * (1 - j);
  if (jaroWinklerCacheSize >= JARO_WINKLER_CACHE_MAX) {
    jaroWinklerCache = new Map();
    jaroWinklerCacheSize = 0;
    row = undefined;
  }
  if (!row) jaroWinklerCache.set(a, (row = new Map()));
  row.set(b, value);
  jaroWinklerCacheSize++;
  return value;
}

const SOUNDEX_CODES: Record<string, number> = {
  B: 1, F: 1, P: 1, V: 1,
  C: 2, G: 2, J: 2, K: 2, Q: 2, S: 2, X: 2, Z: 2,
  D: 3, T: 3,
  L: 4,
  M: 5, N: 5,
  R: 6,
};

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

/**
 * Canonical comparison key for a plain text field: fold case/diacritics then
 * strip all whitespace, so spacing differences don't count as conflicts.
 * Shared between the match engine's agree/conflict detection and the review panel.
 */
export function compareKey(value: string): string {
  return foldToken(value).replace(/\s+/g, "");
}
