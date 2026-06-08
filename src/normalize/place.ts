/**
 * Tidy a place (or address) value's whitespace only: collapse runs of spaces
 * and trim the ends. Place names are deliberately left exactly as the source
 * wrote them — casing and spelling are not changed on import (structural
 * reshaping to the master's layout happens later, during merge).
 */
export function normalizePlaceString(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}
