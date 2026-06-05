import { parsePlace } from "../gedcom/place";
import type { PlaceFormatProfile } from "./types";

/**
 * Normalize a place string toward the master's conventions:
 *  1. If the whole place (case-insensitively) is known to the master, adopt the
 *     master's exact canonical spelling.
 *  2. Otherwise canonicalize each jurisdiction part's casing/spelling from the
 *     master's per-part vocabulary, and tidy separators/whitespace.
 *
 * Depth is intentionally left unchanged — inferring missing jurisdictions would
 * risk inventing data — but callers can compare against `profile.modalDepth`.
 */
export function normalizePlaceString(raw: string, profile: PlaceFormatProfile): string {
  const { parts } = parsePlace(raw);
  if (parts.length === 0) return raw.trim();

  const fullKey = parts.map((p) => p.toLowerCase()).join("|");
  const canonicalFull = profile.fullCanonical.get(fullKey);
  if (canonicalFull) return canonicalFull;

  const normalizedParts = parts.map((part) => {
    const canonical = profile.partCanonical.get(part.toLowerCase());
    return (canonical ?? part).replace(/\s+/g, " ").trim();
  });
  return normalizedParts.join(", ");
}
