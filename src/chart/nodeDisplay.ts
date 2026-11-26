// Shared field-display logic for every diagram renderer (the tree/grid node box,
// the Compare-tree inline SVG, and the radial fan/circle labels). Centralising it
// here keeps all four in sync as the Chart-settings toggles change which fields a
// node shows, and how living people are redacted for privacy.

import type { GedEvent, Individual, Sex } from "../gedcom/types";
import type { YearsApprox } from "../gedcom/lifespan";
import type { Translate } from "../locales/i18n";
import type { Lineage } from "../match/kinship";
import { findEvent } from "../match/relatives";
import { EVENT_GLYPHS } from "../gedcom/eventTags";
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
  /** Write the address on the place line where the person has one (the place
   *  stands in where they have none) — see {@link placeLine}. With the place
   *  shown too, a chart with the room writes both, the address above. */
  showAddress: boolean;
  /** How many rows the chart keeps for the address — see `DetailToggles`. */
  addressLines?: 0 | 1 | 2;
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
  showAddress: false,
  showMarriageDate: true,
  showMarriagePlace: true,
  privacyLiving: false,
};

/** Marriage glyph (U+26AD) — language-neutral, prefixed on every marriage
 *  label. The event vocabulary's own mark, so the connector label and the
 *  event lists elsewhere carry the same one. */
export const MARRIAGE_SYMBOL = EVENT_GLYPHS.MARR;

/** Which marriage fields to include — the two independent Marriage toggles. */
export interface MarriageFields {
  date: boolean;
  place: boolean;
}

/**
 * The connector label for a marriage: `⚭ <year>, <place>` — the year (when `date`)
 * and place (when `place`), joined — then the union's status when the file
 * records one: `⚮ 1960` divorced, `⚬⚬` living apart, `⚯` never married.
 * Returns undefined when nothing is selected or recorded, so callers render
 * nothing.
 */
export function formatMarriage(
  marriage: { year?: string; place?: string; living?: boolean; status?: { glyph: string; year?: string } } | undefined,
  fields: MarriageFields,
  /** Redacting the living (the charts' privacy switch): a couple with a living
   *  partner then has no label at all — the wedding is that person's data. */
  redactLiving = false,
): string | undefined {
  if (!marriage) return undefined;
  if (redactLiving && marriage.living) return undefined;
  const parts = [fields.date ? marriage.year : undefined, fields.place ? marriage.place : undefined].filter(Boolean);
  const wedding = parts.length ? `${MARRIAGE_SYMBOL} ${parts.join(" ")}` : undefined;
  const { status } = marriage;
  const ending = status && (fields.date || fields.place)
    ? (fields.date && status.year ? `${status.glyph} ${status.year}` : status.glyph)
    : undefined;
  return [wedding, ending].filter(Boolean).join(" ") || undefined;
}

/** The italics mark for a line whose one year is approximate: the
 *  `yearsSegments` rule "first number of a dashless line" picks it. */
export const APPROX_YEAR: YearsApprox = { birth: true };

/** Which part of a marriage label to set in italics: its year, when the label
 *  carries one and the date is not exact (see `MarriageInfo.approx`). The
 *  label leads with that year, so {@link APPROX_YEAR} marks it. */
export function marriageApprox(
  marriage: { year?: string; approx?: boolean } | undefined,
  text: string | undefined,
): YearsApprox | undefined {
  return marriage?.approx && marriage.year && text?.includes(marriage.year) ? APPROX_YEAR : undefined;
}

/**
 * The localized "Living" placeholder for a redacted person, gendered when the
 * sex is known (sl "živ"/"živa" via the `_M`/`_F` context keys). Unknown sex —
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

/** "124 people · 6 generations" — how far a direction reaches, carried as the
 *  tooltip of the Ancestors / Descendants buttons. Always describes the whole
 *  branch, whatever the generation limit currently draws. */
export function modeSummary(t: Translate, people: number, generations: number): string {
  return `${t("tree.mode.people", { count: people })} · ${t("tree.gen.count", { count: generations })}`;
}

/** The residence the person was last recorded at, among those `has` accepts:
 *  the latest dated one, else the last one written. */
function lastResidence(indi: Individual, has: (e: GedEvent) => unknown = (e) => e.place || e.address): GedEvent | undefined {
  let last: GedEvent | undefined;
  for (const e of indi.events) {
    if (e.tag !== "RESI" || !has(e)) continue;
    const year = e.date?.year;
    const lastYear = last?.date?.year;
    // A dated residence outranks an undated one; among equals the later written wins.
    if (lastYear === undefined || (year !== undefined && year >= lastYear)) last = e;
  }
  return last;
}

/**
 * What a chart writes for where a person is from, read off their events: the
 * last residence that gives `read` a value, else the birth, else the death.
 * The residence leads because a birth is so often recorded at a maternity
 * hospital and a death at a hospital, in the nearest town — and the last one
 * because the home a person was born into can be read off their parents.
 */
function fromHome<T>(indi: Individual, read: (e: GedEvent) => T | undefined): T | undefined {
  const home = lastResidence(indi, read);
  for (const e of [home, findEvent(indi, "BIRT"), findEvent(indi, "DEAT")]) {
    const value = e && read(e);
    if (value) return value;
  }
  return undefined;
}

/**
 * The place label for a person: the most-specific locality of their last
 * residence, else of their birth, else of their death (see {@link fromHome}),
 * with any house number stripped via {@link localityParts}.
 */
export function placeLabel(indi: Individual | undefined): string | undefined {
  if (!indi) return undefined;
  return fromHome(indi, (e) => (e.place ? localityParts(e.place)[0] : undefined));
}

/**
 * The address label for a person: the address (`ADDR`) of their last residence
 * that records one, else of their birth, else of their death, whole — the
 * house number and the house name are the point of it. Undefined when none of
 * them has an address.
 */
export function addressLabel(indi: Individual | undefined): string | undefined {
  if (!indi) return undefined;
  return fromHome(indi, (e) => e.address?.raw.trim().replace(/\s*\n\s*/g, ", ") || undefined);
}

/**
 * The place line under the two toggles: with Address on, the person's address,
 * or their place when they have no address; with only Place on, the place.
 * Shared by every chart that writes the line.
 */
export function placeLine(
  opts: { showPlace: boolean; showAddress: boolean },
  input: { place?: string; address?: string },
): string | undefined {
  if (opts.showAddress) return input.address || input.place;
  return opts.showPlace ? input.place : undefined;
}

/** A person's place as a search list shows it: a short label beside the name,
 *  and the event it came from with the full place and address for the tooltip. */
export interface HomePlace {
  tag: "RESI" | "BIRT" | "DEAT";
  label: string;
  full: string;
}

/**
 * Where a person lived, to tell namesakes apart in a person search: the last
 * residence, else the birth place, else the death place — births and deaths
 * come after the residence because they are often recorded at a hospital. The
 * label is the locality with its house number kept, then the address, since
 * those are what set two people of one village apart.
 */
export function homePlaceOf(indi: Individual | undefined): HomePlace | undefined {
  if (!indi) return undefined;
  const event =
    lastResidence(indi) ??
    [findEvent(indi, "BIRT"), findEvent(indi, "DEAT")].find((e) => e?.place || e?.address);
  if (!event) return undefined;
  // Place · Address, as the app writes the pair everywhere else.
  const label = [event.place?.parts[0], event.address?.raw].filter(Boolean).join(" · ");
  if (!label) return undefined;
  const full = [event.place?.raw, event.address?.raw].filter(Boolean).join(" · ");
  return { tag: event.tag as HomePlace["tag"], label, full };
}

export interface NodeDisplayInput {
  name: string;
  years?: string;
  /** Which of `years` stand on an approximate date — set in italics. */
  yearsApprox?: YearsApprox;
  /** The person's whole-years age (at death, or current for the living), when
   *  known — see `lifespanAge`. Folded into the shown lifespan line. */
  age?: number;
  /** The fully-localized standalone age phrase ("age 40" / "star 40 let") —
   *  supply {@link ageStandalone}. Only used when the lifespan line is hidden. */
  ageText?: string;
  place?: string;
  /** The person's address ({@link addressLabel}), for the Address toggle. */
  address?: string;
  /** Kinship-to-start label, when known. */
  kinship?: string;
  /** Blood lineage of the kinship, for colour-coding the kinship row. */
  kinshipLineage?: Lineage;
  /** The start person's direct line (ancestor or descendant): name and kinship are bold. */
  kinshipDirect?: boolean;
  /** True when the person is inferred to be living (privacy candidate). */
  living?: boolean;
  /** Localized "Living" placeholder for a redacted person with no kinship. */
  livingLabel: string;
  /** The name a redacted person keeps under the privacy setting's name choice
   *  (initials, given name, whole name) — in place of the kinship / "Living". */
  livingName?: string;
}

export interface NodeDisplay {
  /** Effective primary label — the name, or for a redacted living person the
   *  kinship label (else the "Living" placeholder). */
  name: string;
  /** Lifespan line, present only when shown and not redacted. */
  years?: string;
  /** The input's `yearsApprox`, kept only while the line shows the years. */
  yearsApprox?: YearsApprox;
  /** Place line, present only when shown and not redacted. */
  place?: string;
  /** The address, on a line of its own, when the Address toggle is on and the
   *  person has one. The place then shows beneath it only with the Place
   *  toggle on too; a person with no address shows the place either way. A
   *  chart with one line for the two reads {@link onePlaceLine} instead. */
  address?: string;
  /** Kinship line, present only when shown and not redacted. */
  kinship?: string;
  /** Blood lineage of the shown kinship line, for colour-coding. */
  kinshipLineage?: Lineage;
  kinshipDirect?: boolean;
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
 * person in privacy mode collapses to the name the privacy setting keeps, else
 * their relationship (or "Living"): no years, place, kinship line, or photo.
 * Otherwise each field is gated by its toggle.
 */
export function nodeDisplay(opts: NodeDisplayOptions, input: NodeDisplayInput): NodeDisplay {
  if (opts.privacyLiving && input.living) {
    return {
      name: input.livingName || input.kinship || input.livingLabel,
      years: undefined,
      place: undefined,
      kinship: undefined,
      showPhoto: false,
    };
  }
  const address = opts.showAddress ? input.address || undefined : undefined;
  return {
    name: input.name,
    years: lifespanLine(opts, input),
    yearsApprox: opts.showLifespan ? input.yearsApprox : undefined,
    address,
    place: opts.showPlace || (opts.showAddress && !address) ? input.place : undefined,
    kinship: opts.showKinship ? input.kinship : undefined,
    kinshipLineage: opts.showKinship ? input.kinshipLineage : undefined,
    kinshipDirect: input.kinshipDirect,
    showPhoto: opts.showPhoto,
  };
}

/** A resolved display for a chart with one line for the place: the address
 *  where the person has one, else the place — whatever the two toggles say. */
export function onePlaceLine(disp: NodeDisplay): NodeDisplay {
  if (!disp.address) return disp;
  return { ...disp, place: disp.address, address: undefined };
}

/**
 * The hover text for a chart node: the full name with the lifespan (and the
 * age, when shown) on the first line — whatever the box or wedge had room to
 * draw — then each further field the chart options show on a line of its
 * own: the address, the place and the kinship to the start person. A redacted living
 * person shows only their placeholder, and every line the redaction hides
 * stays hidden here too.
 */
export function nodeTooltip(opts: NodeDisplayOptions, input: NodeDisplayInput): string {
  const h = nodeHover(opts, input);
  return [h.years ? `${h.name}, ${h.years}` : h.name, h.address, h.place, h.kinship].filter(Boolean).join("\n");
}

/** What the hover card shows for a node, field by field: the name (or the
 *  placeholder for a redacted living person), the lifespan with the age when
 *  shown, and the place and kinship lines the settings show. */
export interface NodeHover {
  name: string;
  years?: string;
  yearsApprox?: YearsApprox;
  /** The address line above the place — see {@link NodeDisplay.address}. */
  address?: string;
  place?: string;
  kinship?: string;
  kinshipLineage?: Lineage;
  kinshipDirect?: boolean;
  /** A redacted living person: the name is the placeholder and nothing else shows. */
  redacted: boolean;
}

export function nodeHover(opts: NodeDisplayOptions, input: NodeDisplayInput): NodeHover {
  const disp = nodeDisplay(opts, input);
  if (opts.privacyLiving && input.living) return { name: disp.name, redacted: true };
  return {
    name: input.name,
    years: lifespanLine({ showLifespan: true, showAge: opts.showAge }, { years: input.years, age: input.age }) || undefined,
    yearsApprox: input.yearsApprox,
    address: disp.address,
    place: disp.place,
    kinship: disp.kinship,
    kinshipLineage: disp.kinshipLineage,
    kinshipDirect: disp.kinshipDirect,
    redacted: false,
  };
}
