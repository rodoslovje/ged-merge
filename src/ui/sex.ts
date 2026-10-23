import type { Sex } from "../gedcom/types";

/** CSS class colouring a name by sex — cyan for male, pink for female, the
 *  neutral "other" colour for GEDCOM 7's `X`, none if unknown. */
export function sexClass(sex?: Sex | string): string {
  return sex === "M" ? "sex-m" : sex === "F" ? "sex-f" : sex === "X" ? "sex-x" : "";
}

/** The theme token for the sex colour, or undefined when unknown. */
export function sexColorVar(sex?: Sex | string): string | undefined {
  return sex === "M" ? "var(--sex-male)" : sex === "F" ? "var(--sex-female)" : sex === "X" ? "var(--sex-other)" : undefined;
}
