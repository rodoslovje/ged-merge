import type { PersonName } from "./types";

/** How a person's given name and surname are ordered for display. */
export type NameOrder = "given-surname" | "surname-given";

/** User-configurable name-display preferences (see the Settings panel). */
export interface NameDisplayOptions {
  order: NameOrder;
  /** Render the surname in UPPERCASE (a common genealogy convention). */
  uppercaseSurname: boolean;
  /** Append the married surname in parentheses, e.g. "Ana Novak (Kovač)". */
  marriedSurname: boolean;
}

/** Bare record id for display, without the surrounding `@`s (e.g. `@I12@` → `I12`). */
export function xrefLabel(id: string): string {
  return id.replace(/@/g, "");
}

/** The neutral defaults — these reproduce the app's historical `displayName`. */
export const DEFAULT_NAME_DISPLAY: NameDisplayOptions = {
  order: "given-surname",
  uppercaseSurname: false,
  marriedSurname: false,
};

/** Historical display: the reconstructed full name, with sensible fallbacks. */
function displayBase(n: PersonName): string {
  return n.full?.trim() || [n.given, n.surname].filter(Boolean).join(" ") || "(unnamed)";
}

/**
 * Format a structured name for display according to the user's preferences.
 * With {@link DEFAULT_NAME_DISPLAY} this is identical to the old `displayName`.
 *
 * The married-surname parenthetical attaches to the *surname*, so it stays next
 * to it in either order — "Ana Novak (Kovač)" but "Novak (Kovač), Ana".
 */
export function formatPersonName(n: PersonName | undefined, opts: NameDisplayOptions): string {
  if (!n) return "(unnamed)";

  const given = n.given?.trim();
  const surname = n.surname?.trim();

  // The married surname to show, if any (skipped when it equals the maiden one).
  const married = opts.marriedSurname ? n.married?.trim() : undefined;
  const marriedShown =
    married && married.toLowerCase() !== surname?.toLowerCase()
      ? opts.uppercaseSurname ? married.toUpperCase() : married
      : undefined;
  const marriedTail = marriedShown ? ` (${marriedShown})` : "";

  // No surname to format/re-order: keep the historical full string, just append
  // any married surname at the end.
  if (!surname) {
    const base = displayBase(n);
    return base === "(unnamed)" ? base : `${base}${marriedTail}`;
  }

  const sur = opts.uppercaseSurname ? surname.toUpperCase() : surname;
  const surToken = `${sur}${marriedTail}`;

  if (opts.order === "surname-given") {
    return given ? `${surToken}, ${given}` : surToken;
  }

  // Given-surname order. Reconstruct from parts only when uppercasing is needed;
  // otherwise reuse the exact historical full string so default output is byte
  // -for-byte identical to the old behaviour.
  const base = opts.uppercaseSurname ? [given, sur].filter(Boolean).join(" ") : displayBase(n);
  return `${base}${marriedTail}`;
}
