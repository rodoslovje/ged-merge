// Shared field-display logic for every diagram renderer (the tree/grid node box,
// the Compare-tree inline SVG, and the radial fan/circle labels). Centralising it
// here keeps all four in sync as the Chart-settings toggles change which fields a
// node shows, and how living people are redacted for privacy.

import type { Individual, Sex } from "../gedcom/types";
import type { Translate } from "../locales/i18n";
import type { Lineage } from "../match/kinship";
import { findEvent } from "../match/relatives";
import { localityParts } from "../gedcom/place";

/** The display subset of `ChartSettings` (kept independent of the React context so
 *  pure layout/geometry code can depend on it without importing the provider). */
export interface NodeDisplayOptions {
  showKinship: boolean;
  showPhoto: boolean;
  showLifespan: boolean;
  /** Show the person's age — folded into the lifespan line as "(N)", or, when
   *  the lifespan is hidden, standing on its own as "<age-word> N". */
  showAge: boolean;
  showPlace: boolean;
  /** Show the marriage year on the couple's connector / fan collar. */
  showMarriageDate: boolean;
  /** Show the marriage place on the couple's connector / fan collar. */
  showMarriagePlace: boolean;
  privacyLiving: boolean;
}

/** Everything on. The neutral default when no settings are threaded through. */
export const ALL_DISPLAY: NodeDisplayOptions = {
  showKinship: true,
  showPhoto: true,
  showLifespan: true,
  showAge: false,
  showPlace: true,
  showMarriageDate: true,
  showMarriagePlace: true,
  privacyLiving: false,
};

/** Marriage glyph (U+26AD) — language-neutral, prefixed on every marriage label. */
export const MARRIAGE_SYMBOL = "⚭";

/** Which marriage fields to include — the two independent Marriage toggles. */
export interface MarriageFields {
  date: boolean;
  place: boolean;
}

/**
 * The connector label for a marriage: `⚭ <year>, <place>` — the year (when `date`)
 * and place (when `place`), joined. Returns undefined when nothing is selected or
 * recorded, so callers render nothing.
 */
export function formatMarriage(
  marriage: { year?: string; place?: string } | undefined,
  fields: MarriageFields,
): string | undefined {
  if (!marriage) return undefined;
  const parts = [fields.date ? marriage.year : undefined, fields.place ? marriage.place : undefined].filter(Boolean);
  if (!parts.length) return undefined;
  return `${MARRIAGE_SYMBOL} ${parts.join(" ")}`;
}

/**
 * The localized "Living" placeholder for a redacted person, gendered when the
 * sex is known (sl "Živ"/"Živa" via the `_M`/`_F` context keys). Unknown sex —
 * and English, which defines only the base key — fall back to the neutral form,
 * the same context convention as the narrative.* templates.
 */
export function livingLabelFor(t: Translate, sex?: Sex | string): string {
  return t("tree.node.living", { context: sex === "M" || sex === "F" ? sex : undefined });
}

/**
 * The full standalone age phrase for a node's own line when the lifespan is
 * hidden — "age 40", or the gendered, unit-bearing Slovenian "star 40 let" /
 * "stara 40 let". Gendered via the same `_M`/`_F` context convention as
 * {@link livingLabelFor}; the number is interpolated so the unit can trail it.
 */
export function ageStandalone(t: Translate, sex: Sex | string | undefined, age: number): string {
  return t("tree.node.agePhrase", { context: sex === "M" || sex === "F" ? sex : undefined, age });
}

/** Place events tried in order — show the first one that records a place. */
const PLACE_TAGS = ["BIRT", "RESI", "DEAT"] as const;

/**
 * The place label for a person: the most-specific locality of the first available
 * birth / residence / death place (so the user always sees at least one place when
 * the person has any), with any house number stripped via {@link localityParts}.
 */
export function placeLabel(indi: Individual | undefined): string | undefined {
  if (!indi) return undefined;
  for (const tag of PLACE_TAGS) {
    const place = findEvent(indi, tag)?.place;
    if (place) {
      const parts = localityParts(place);
      if (parts.length) return parts[0];
    }
  }
  return undefined;
}

export interface NodeDisplayInput {
  name: string;
  years?: string;
  /** The person's whole-years age (at death, or current for the living), when
   *  known — see `lifespanAge`. Folded into the shown lifespan line. */
  age?: number;
  /** The fully-localized standalone age phrase ("age 40" / "star 40 let") —
   *  supply {@link ageStandalone}. Only used when the lifespan line is hidden. */
  ageText?: string;
  place?: string;
  /** Kinship-to-start label, when known. */
  kinship?: string;
  /** Blood lineage of the kinship, for colour-coding the kinship row. */
  kinshipLineage?: Lineage;
  /** True when the person is inferred to be living (privacy candidate). */
  living?: boolean;
  /** Localized "Living" placeholder for a redacted person with no kinship. */
  livingLabel: string;
}

export interface NodeDisplay {
  /** Effective primary label — the name, or for a redacted living person the
   *  kinship label (else the "Living" placeholder). */
  name: string;
  /** Lifespan line, present only when shown and not redacted. */
  years?: string;
  /** Place line, present only when shown and not redacted. */
  place?: string;
  /** Kinship line, present only when shown and not redacted. */
  kinship?: string;
  /** Blood lineage of the shown kinship line, for colour-coding. */
  kinshipLineage?: Lineage;
  /** Whether to draw the photo. */
  showPhoto: boolean;
}

/**
 * The lifespan line with the age folded in, honouring the two toggles:
 * lifespan + age → "1817–1890 (73)"; age only → the standalone "age 73" /
 * "star 73 let" ({@link ageText}); lifespan only → "1817–1890"; neither (or no
 * data) → undefined. Shared by every chart that renders a lifespan line so the
 * behaviour stays identical.
 */
export function lifespanLine(
  opts: { showLifespan: boolean; showAge: boolean },
  input: { years?: string; age?: number; ageText?: string },
): string | undefined {
  const span = opts.showLifespan ? input.years || undefined : undefined;
  if (opts.showAge && input.age !== undefined) {
    return span ? `${span} (${input.age})` : (input.ageText ?? String(input.age));
  }
  return span;
}

/**
 * Resolve which fields a node actually shows under the current settings. A living
 * person in privacy mode collapses to just their relationship (or "Living"): no
 * years, place, kinship line, or photo. Otherwise each field is gated by its toggle.
 */
export function nodeDisplay(opts: NodeDisplayOptions, input: NodeDisplayInput): NodeDisplay {
  if (opts.privacyLiving && input.living) {
    return {
      name: input.kinship || input.livingLabel,
      years: undefined,
      place: undefined,
      kinship: undefined,
      showPhoto: false,
    };
  }
  return {
    name: input.name,
    years: lifespanLine(opts, input),
    place: opts.showPlace ? input.place : undefined,
    kinship: opts.showKinship ? input.kinship : undefined,
    kinshipLineage: opts.showKinship ? input.kinshipLineage : undefined,
    showPhoto: opts.showPhoto,
  };
}
