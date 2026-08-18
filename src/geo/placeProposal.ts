import { decomposePlace } from "../gedcom/place";
import { canonicalPlaceToken, placeCompareKey } from "../match/place";
import { reformatPlace } from "../normalize/placeReformat";
import { placeFormFor } from "../normalize/profile";
import type { PlaceTargetFormat } from "../normalize/types";
import type { GeoCoord } from "../gedcom/types";
import type { GazEntry } from "./gazetteer";
import type { PlaceParentLevels } from "./placeLevels";
import type { GovResult } from "./gov";
import type { NominatimResult } from "./nominatim";
import type { RnResult } from "./rn";

// Turning a register hit into a place the *file* would have written.
//
// The lookups already existed for coordinates: they answer "where is this place
// the file names?". This module answers the other direction — "the file does not
// name this place yet; write it the way this file writes places" — so a village
// typed into an event can be completed from GURS/GOV/OpenStreetMap with its
// jurisdiction chain, its house address and its coordinate in one pick.
//
// The shaping is not new: composing a raw place and running it through
// `reformatPlace` is exactly what a merge does to an incoming event, so a
// proposal lands in the main's own layout, separator and country spelling.

/** One completed place a register offers for a partially typed one. */
export interface PlaceProposal {
  /** PLAC text, in the file's own layout. */
  plac: string;
  /** ADDR text, when the source named a house and the layout keeps it apart. */
  addr?: string;
  /**
   * `PLAC`.`FORM` naming what each part of `plac` is, in this file's own
   * wording — written because the chain was composed here (settlement, then
   * administrative parent, then country), so the levels are known rather than
   * counted. Absent when the file writes no FORM, or none for this shape.
   */
  form?: string;
  /** Where the register puts it — picked along with the text. */
  coord: GeoCoord;
  /** Badge text naming the answering register ("GURS", "GOV", "OSM", "SI"). */
  source: string;
  /** Whether that register is an official one (badge styling). */
  official?: boolean;
  /** The source's own full line, kept for the row's tooltip. */
  detail?: string;
  /** GOV id of the place, written back as `PLAC._GOV` when it has one. */
  govId?: string;
}

/** How this file writes places, plus what the UI language can name. */
export interface PlaceStyle {
  /** The main's layout/separator/country spellings — {@link inferPlaceExportFormat}. */
  fmt: PlaceTargetFormat;
  /**
   * How many jurisdiction levels the file's own places carry (modal comma-part
   * count). A register knows more levels than most files use, and a proposal
   * that spelled out every one of them would not look like its neighbours —
   * so the chain is trimmed to what this file writes.
   */
  depth: number;
  /**
   * The same count per country ({@link canonicalPlaceToken} of the country →
   * modal comma-part count of the file's places in it). A file writes its
   * American places deeper than its Slovenian ones — "Chicago, Cook, Illinois,
   * United States" beside "Kranj, Kranj, Slovenija" — so a proposal matches
   * the habit for *its* country; {@link depth} answers for a country the file
   * has never written, and for a chain naming no country at all.
   */
  depthByCountry?: ReadonlyMap<string, number>;
  /** UI language, used to name a country the file has never written. */
  language: string;
  /**
   * Which register level this file writes above a settlement, per country — a
   * municipality for most files, the county above it for the files that write
   * that instead. Absent (or {@link MUNICIPALITY_LEVELS}) means the
   * municipality, which is what every proposal named before the level was read.
   */
  parentLevels?: PlaceParentLevels;
}

/** The file's place depths: the overall modal comma-part count, and the same
 *  mode per country — see {@link PlaceStyle.depthByCountry}. */
export interface PlaceDepths {
  depth: number;
  byCountry: Map<string, number>;
}

/** The modal count, ties to the smaller — trimming a level is recoverable from
 *  the register, an invented one is not. */
function modalOf(counts: ReadonlyMap<number, number>): number {
  let best = 0;
  let bestCount = 0;
  for (const [n, count] of counts) {
    if (count > bestCount || (count === bestCount && n < best)) {
      best = n;
      bestCount = count;
    }
  }
  return best;
}

/** Modal number of comma-separated parts across the file's own PLAC values,
 *  overall and per country the values themselves name. Falls back to 2
 *  (locality + country) for a file with no places yet. */
export function placeDepthsOf(places: readonly string[]): PlaceDepths {
  const global = new Map<number, number>();
  const perCountry = new Map<string, Map<number, number>>();
  for (const p of places) {
    const n = p.split(",").filter((s) => s.trim()).length;
    if (n === 0) continue;
    global.set(n, (global.get(n) ?? 0) + 1);
    const country = decomposePlace(p).country;
    if (!country) continue;
    const key = canonicalPlaceToken(country);
    const counts = perCountry.get(key) ?? new Map<number, number>();
    counts.set(n, (counts.get(n) ?? 0) + 1);
    perCountry.set(key, counts);
  }
  const byCountry = new Map<string, number>();
  for (const [key, counts] of perCountry) byCountry.set(key, modalOf(counts));
  return { depth: modalOf(global) || 2, byCountry };
}

/** {@link placeDepthsOf}, reduced to the file-wide mode. */
export function placeDepthOf(places: readonly string[]): number {
  return placeDepthsOf(places).depth;
}

/** The country's name in the UI language ("SI" → "Slovenija"), or undefined
 *  when the runtime cannot name it. */
export function countryNameOf(code: string, language: string): string | undefined {
  if (!code || code.length !== 2) return undefined;
  try {
    const name = new Intl.DisplayNames([language], { type: "region" }).of(code.toUpperCase());
    return name && name !== code.toUpperCase() ? name : undefined;
  } catch {
    return undefined;
  }
}

/** The file's own spelling of a country, when it writes that country at all.
 *  `reformatPlace` does this for the layouts it reshapes; a pass-through layout
 *  would otherwise keep the UI language's spelling. */
function preferredCountry(name: string | undefined, fmt: PlaceTargetFormat): string | undefined {
  if (!name || !fmt.countryPreferred) return name;
  return fmt.countryPreferred.get(canonicalPlaceToken(name)) ?? name;
}

/**
 * Compose the register's levels into a raw place string and reshape it into the
 * file's layout. The chain is locality → administrative parents (smallest
 * first) → country, cut to the file's own depth: the parent (občina/Kreis) is
 * what a two-level file drops, since it is the disambiguator rather than the
 * address, and a deeper file keeps as many parents as its own places carry —
 * "place, county, state, country" where the register named both levels.
 */
function shape(
  parts: { locality: string; admins?: readonly (string | undefined)[]; country?: string },
  addrRaw: string | undefined,
  style: PlaceStyle,
): { plac: string; addr?: string } | undefined {
  const locality = parts.locality.trim();
  if (!locality) return undefined;
  // A municipality named after its own seat is *not* collapsed: a three-level
  // file writes exactly "Kranj,Kranj,Slovenija" for the town of Kranj, and a
  // proposal that dropped the repetition would not match its neighbours.
  const admins = (parts.admins ?? []).map((a) => a?.trim()).filter((a): a is string => !!a);
  const country = preferredCountry(parts.country?.trim() || undefined, style.fmt);
  // The depth the file writes *this* country at, before its overall habit — a
  // file of three-level Slovenian places still writes its American ones in four.
  const depth = (country ? style.depthByCountry?.get(canonicalPlaceToken(country)) : undefined) ?? style.depth;

  let chain: string[];
  if (depth <= 1) chain = [locality];
  else if (depth === 2) chain = [locality, country ?? admins[0]].filter(Boolean) as string[];
  // The file writes depth − 2 levels between the locality and the country; when
  // the register names more, the ones nearest the country stay — a deep file
  // writes the formal hierarchy (county, state) and omits the township, so the
  // trim drops from the settlement end.
  else chain = [locality, ...admins.slice(-(depth - (country ? 2 : 1))), country].filter(Boolean) as string[];

  const raw = chain.join(style.fmt.separator);
  const out = reformatPlace(raw, addrRaw, style.fmt);
  if (!out.plac) return undefined;
  // The reformatter re-parses the composed text with the file's heuristics —
  // and a real village named with a facility word ("Bela Cerkev", "Grad",
  // "Nova Cerkev") re-parses as a church or castle *detail*, vanishing from
  // its own proposal (and, picked, being written wrong). Here the locality is
  // not a guess — the register said so — so when the reshaped text lost it,
  // keep the plainly composed chain instead.
  const plac = canonicalPlaceToken(out.plac).includes(canonicalPlaceToken(locality)) ? out.plac : raw;
  // Declare the levels, in the file's own wording. Read off the reshaped text
  // rather than `chain`: the layout may have filled in a jurisdiction level the
  // register didn't name, and the FORM has to label what was actually written.
  const form = placeFormFor(style.fmt, plac, country);
  return { plac, ...(out.addr ? { addr: out.addr } : {}), ...(form ? { form } : {}) };
}

/** An offline gazetteer entry (GURS settlements, OpenStreetMap, GeoNames).
 *
 *  The parent it names is the one this file's own places name for that country:
 *  its municipality, or the county above it where the file writes counties — a
 *  proposal that named the other level would not look like its neighbours. */
export function proposalFromGazEntry(entry: GazEntry, style: PlaceStyle): PlaceProposal | undefined {
  const admin = style.parentLevels ? style.parentLevels.parentOf(entry) : entry.admin;
  const shaped = shape(
    { locality: entry.name, admins: [admin], country: countryNameOf(entry.country, style.language) },
    undefined,
    style,
  );
  if (!shaped) return undefined;
  return {
    ...shaped,
    coord: { lat: entry.lat, lon: entry.lon },
    // The full directory id: register code, download key ("HR-OSM"), or the
    // bare country code, which by convention means the GeoNames file.
    source: entry.register ?? entry.source ?? entry.country,
    official: !!entry.register,
    detail: [entry.name, entry.admin].filter(Boolean).join(", "),
  };
}

/** A GURS address-register house: a full place *and* its address. */
export function proposalFromRn(result: RnResult, style: PlaceStyle): PlaceProposal | undefined {
  const shaped = shape(
    {
      locality: result.settlement,
      admins: [result.municipality],
      country: countryNameOf("SI", style.language),
    },
    result.address,
    style,
  );
  if (!shaped) return undefined;
  return { ...shaped, coord: result.coord, source: "GURS", official: true, detail: result.label };
}

/** A GOV object. GOV names no country, so the chain stops at the parent — for
 *  a historical place that is usually the level a file names anyway. */
export function proposalFromGov(result: GovResult, style: PlaceStyle): PlaceProposal | undefined {
  const shaped = shape({ locality: result.name, admins: [result.admin] }, undefined, style);
  if (!shaped) return undefined;
  return { ...shaped, coord: result.coord, source: "GOV", detail: result.label, govId: result.govId };
}

/** Segments of a Nominatim display line that are not jurisdiction levels. */
const NOISE = /^\d[\d\s-]*$/;

/**
 * A Nominatim hit. Its structured parts are read where the service returned
 * them; where it didn't, the display line's head (the feature), the level above
 * it and its tail (the country) are — the rest of that line mixes postcodes and
 * administrative units of every rank and would not survive a re-parse as a
 * jurisdiction chain anyway.
 *
 * A hit on a house is the case the parts are indispensable for: there the
 * feature's own "name" is the bare house number, and the settlement it belongs
 * to is only ever a named part.
 */
export function proposalFromNominatim(result: NominatimResult, style: PlaceStyle): PlaceProposal | undefined {
  const segments = result.label.split(",").map((s) => s.trim()).filter((s) => s && !NOISE.test(s));
  const labelCountry = segments.length > 1 ? segments[segments.length - 1] : undefined;
  const parts = result.parts;
  const country = parts?.country ?? labelCountry;

  // A house: "road number", or "settlement number" where a village numbers its
  // houses directly — the two forms GEDCOM addresses take here.
  if (parts?.house) {
    const locality = parts.locality ?? result.admin;
    if (!locality) return undefined;
    const addr = `${parts.road ?? locality} ${parts.house}`;
    const shaped = shape({ locality, admins: adminsOf(parts.admins ?? [parts.admin], country), country }, addr, style);
    return shaped && { ...shaped, coord: result.coord, source: "OSM", detail: result.label };
  }

  const locality = parts?.locality ?? result.name;
  const admins = adminsOf(parts?.admins ?? [parts?.admin ?? result.admin], country);
  const shaped = shape({ locality, admins, country }, undefined, style);
  if (!shaped) return undefined;
  return { ...shaped, coord: result.coord, source: "OSM", detail: result.label };
}

/** The administrative parents, dropping one that merely repeats the country —
 *  Nominatim returns a state for city-states and small countries, and
 *  "Monaco,Monaco" is a level, not a jurisdiction. */
function adminsOf(admins: readonly (string | undefined)[], country: string | undefined): string[] {
  return admins.filter((a): a is string => !!a && a !== country);
}

/** Stable identity of a proposal, for de-duplicating across registers — the
 *  same village answered by GURS and by OpenStreetMap is one offer. */
export function proposalKey(p: PlaceProposal): string {
  return `${placeCompareKey(p.plac)} ${(p.addr ?? "").trim().toLowerCase()}`;
}
