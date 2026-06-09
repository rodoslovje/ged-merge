import type { Sex } from "../gedcom/types";

/** CSS class colouring a name by sex — cyan for male, pink for female, none if unknown. */
export function sexClass(sex?: Sex | string): string {
  return sex === "M" ? "sex-m" : sex === "F" ? "sex-f" : "";
}

/** The theme token for the sex colour, or undefined when unknown. */
export function sexColorVar(sex?: Sex | string): string | undefined {
  return sex === "M" ? "var(--sex-male)" : sex === "F" ? "var(--sex-female)" : undefined;
}
