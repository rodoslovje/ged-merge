import type { Sex } from "../gedcom/types";

/** ♂ / ♀ glyph for a known sex, else "" (unknown — render nothing). */
export function sexGlyph(sex: Sex): string {
  return sex === "M" ? "♂" : sex === "F" ? "♀" : "";
}

/** CSS class colouring a name by sex — cyan for male, pink for female, none if unknown. */
export function sexClass(sex: Sex): string {
  return sex === "M" ? "sex-m" : sex === "F" ? "sex-f" : "";
}

/** "m" / "f" modifier (badge classes), or "" when unknown. */
export function sexMod(sex: Sex): string {
  return sex === "M" ? "m" : sex === "F" ? "f" : "";
}

/** The theme token for the sex colour, or undefined when unknown. */
export function sexColorVar(sex: Sex): string | undefined {
  return sex === "M" ? "var(--sex-male)" : sex === "F" ? "var(--sex-female)" : undefined;
}
