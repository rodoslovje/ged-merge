import type { Sex } from "../gedcom/types";
import { sexGlyph, sexMod } from "./sex";

/**
 * Small ♀/♂ chip rendered before a person's name. Additive to the existing
 * sex-coloured name; nothing is shown when the sex is unknown.
 */
export function SexBadge({ sex }: { sex: Sex }) {
  const glyph = sexGlyph(sex);
  if (!glyph) return null;
  return (
    <span className={`sex-badge ${sexMod(sex)}`} aria-hidden="true">
      {glyph}
    </span>
  );
}
