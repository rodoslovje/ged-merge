// Shared field-display logic for every diagram renderer (the tree/grid node box,
// the Compare-tree inline SVG, and the radial fan/circle labels). Centralising it
// here keeps all four in sync as the Chart-settings toggles change which fields a
// node shows, and how living people are redacted for privacy.

import type { Individual } from "../gedcom/types";
import { findEvent } from "../match/relatives";
import { localityParts } from "../gedcom/place";

/** The display subset of `ChartSettings` (kept independent of the React context so
 *  pure layout/geometry code can depend on it without importing the provider). */
export interface NodeDisplayOptions {
  showKinship: boolean;
  showPhoto: boolean;
  showLifespan: boolean;
  showPlace: boolean;
  privacyLiving: boolean;
}

/** Everything on. The neutral default when no settings are threaded through. */
export const ALL_DISPLAY: NodeDisplayOptions = {
  showKinship: true,
  showPhoto: true,
  showLifespan: true,
  showPlace: true,
  privacyLiving: false,
};

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
  place?: string;
  /** Kinship-to-home label, when known. */
  kinship?: string;
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
  /** Whether to draw the photo. */
  showPhoto: boolean;
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
    years: opts.showLifespan ? input.years : undefined,
    place: opts.showPlace ? input.place : undefined,
    kinship: opts.showKinship ? input.kinship : undefined,
    showPhoto: opts.showPhoto,
  };
}
