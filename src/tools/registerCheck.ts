import type { Dataset, GeoCoord } from "../gedcom/types";
import { decomposePlace, isUnknownPlaceValue, placeAddressDetail } from "../gedcom/place";
import { countryCode } from "../gedcom/countryCode";
import { foldToken } from "../match/text";
import { lookupPlace, PARENT_QUALIFIED, type GazEntry, type GazetteerIndex } from "../geo/gazetteer";
import { distanceKm } from "../geo/points";
import { reformatPlace } from "../normalize/placeReformat";
import type { PlaceTargetFormat } from "../normalize/types";
import { coordOf, isRegisterAddress, walkPlaceAddr } from "./geocode";
import { replaceLocality } from "./addresses";
import { placeCollator } from "./places";
import type { GeocodeDecision } from "../persist/geoDb";

// Compliance check: hold every place the file writes in a country covered by an
// official register (GURS for Slovenia, DGU for Croatia) against that register,
// and report the ones that disagree with it.
//
// Deliberately a *report*, never an error list. A register describes the country
// as it is today, while a genealogy file describes it as it was: settlements
// were renamed, merged and abolished, and a name the register no longer knows
// is very often the correct historical one. So every finding is dismissible
// ({@link REGISTER_DISMISSED}, remembered in the geocode decision cache) and
// nothing here writes to the file on its own.
//
// Only names are checked — the house numbers of the address register are the
// Addresses tab's business, and their lookups go online.

/**
 * What a place and its register entry disagree about, worst first.
 *
 * - `notFound` the register knows no such place (research, or a rename)
 * - `ambiguous` the name fits several register entries and nothing tells them
 *   apart — no single entry can be said to be the one meant
 * - `admin` the file files the place under a municipality the register doesn't
 * - `spelling` the register writes the name differently
 * - `site` the directory knows the place from its second level on: the first
 *   names a cemetery, a township, an election precinct — something inside the
 *   place rather than the place itself
 * - `address` the value carries a house address, in a file that keeps addresses
 *   on their own `ADDR` line — the one finding about the file's own convention
 *   rather than the register's, and the reason it belongs here is that a place
 *   holding a house number can never be held to a register of settlements
 * - `far` the coordinate in the file is nowhere near the register's position
 */
export type RegisterVerdict = "notFound" | "ambiguous" | "admin" | "spelling" | "site" | "address" | "far";

export const REGISTER_VERDICTS: RegisterVerdict[] = [
  "notFound",
  "ambiguous",
  "admin",
  "spelling",
  "site",
  "address",
  "far",
];

/** The decision status a dismissed finding is remembered under — "this wording
 *  is right as it stands, stop reporting it" (a historical name the register no
 *  longer knows, most often). */
export const REGISTER_DISMISSED = "historic";

/** Where a dismissal is remembered: the place value behind a prefix, so it sits
 *  beside the geocode tool's "no match" mark for the same place instead of
 *  overwriting it — the two are different judgements and either may be made
 *  without the other. */
export function registerDecisionKey(place: string): string {
  return `register:${place}`;
}

/** How far (km) a file coordinate may sit from the register's position before
 *  the row is reported. Generous on purpose: a register point is the
 *  settlement's centroid while a file coordinate is often the church or the
 *  farm, and a large municipality can legitimately stretch a few kilometres.
 *  Past this the two are not the same place. */
const FAR_KM = 10;

/** A runner-up this close to the best match leaves the name undecided — the
 *  same gap the geocode tool's bulk accept uses. */
const AMBIGUITY_GAP = 0.05;

/** One place value the register disagrees with. */
export interface RegisterFinding {
  /** The exact raw PLAC value — the rename's `from` and the dismissal's key. */
  key: string;
  /** PLAC occurrences of this value in the file. */
  count: number;
  /** Everyone whose events write this place — the individual, or both spouses
   *  of a family event. The row's count, and the list behind it. */
  people: string[];
  verdict: RegisterVerdict;
  /** The locality as the file writes it. */
  written: string;
  /** The register entry the value resolves to (absent for `notFound`). */
  entry?: GazEntry;
  /** The whole place value with the register's spelling of the locality —
   *  what "Use official name" writes. Absent when the value's leading segment
   *  is not its settlement (packed formats), so nothing can be swapped safely. */
  official?: string;
  /** The house address to move onto the event's own `ADDR` line, with `official`
   *  holding the place left behind (`address`). */
  officialAddr?: string;
  /** The municipality the file names, when it is one the register knows but
   *  does not file this place under (`admin`). */
  writtenAdmin?: string;
  /** The register entries a `ambiguous` name fits equally well. */
  alternatives?: GazEntry[];
  /** The settlement coordinate the file carries for this value, when any. */
  fileCoord?: GeoCoord;
  /** Distance from `fileCoord` to the entry, km (`far`). */
  distanceKm?: number;
  /** Dismissed earlier — off the worklist, still listed on request. */
  dismissed: boolean;
}

export interface RegisterCheckReport {
  /** Every disagreement, dismissed ones included, worst verdict first. */
  findings: RegisterFinding[];
  /** Place values held against a register (findings included). */
  checked: number;
  /** Of those, the ones the register agrees with. */
  ok: number;
  /** Values left out: no official register is loaded for their country. */
  skipped: number;
  /** Registers the check drew on, e.g. `["SI-GURS", "HR-DGU"]`. */
  registers: string[];
}

const EMPTY: RegisterCheckReport = { findings: [], checked: 0, ok: 0, skipped: 0, registers: [] };

/** The directory an entry came from, under the name the rest of the app shows:
 *  the official register's code (SI-GURS, HR-DGU), the download key (AT-OSM),
 *  or the bare country code, which by convention means a GeoNames file. */
export function directoryOf(entry: GazEntry): string {
  return entry.register ?? entry.source ?? entry.country;
}

/** Two administrative names for the same body: equal once folded, or one
 *  contained in the other ("Zagrebačka" for the file's "Zagrebačka županija").
 *  The containment arm needs a substantial stem so short names don't collide. */
function sameAdmin(a: string, b: string): boolean {
  const x = foldToken(a);
  const y = foldToken(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return (x.length >= 4 && y.includes(x)) || (y.length >= 4 && x.includes(y));
}

/**
 * The place value with one comma segment swapped — the register's municipality
 * in place of the one the file names ("Mavčiče, Medvode, Slovenia" → "Mavčiče,
 * Kranj, Slovenia").
 *
 * A swap rather than a freshly composed chain: every other level, the file's own
 * separator and any annotation it carries (a parish suffix, a house name) stay
 * exactly as they are, so the corrected value still looks like its neighbours.
 * Returns undefined when the segment is not there to swap.
 */
function replaceSegment(place: string, from: string, to: string): string | undefined {
  const segments = place.split(",");
  const at = segments.findIndex((s) => s.trim() === from);
  if (at < 0 || from === to) return undefined;
  segments[at] = segments[at].replace(from, to);
  return segments.join(",");
}

/** The place value without its most specific level, and that level on its own:
 *  "Saint Mary Nativity Cemetery, Crest Hill, Will, Illinois, United States"
 *  splits into the cemetery and the place it stands in. Empty segments left
 *  behind by the split go with it — files write "Adkin District, , McDowell,
 *  …" — but nothing else is touched, so the rest reads exactly as the file
 *  wrote it. Undefined when there is no level left underneath. */
function splitLeadingLevel(place: string): { lead: string; rest: string } | undefined {
  const segments = place.split(",");
  const lead = segments[0]?.trim();
  if (!lead) return undefined;
  let i = 1;
  while (i < segments.length && !segments[i].trim()) i++;
  const rest = segments.slice(i).join(",").trim();
  return rest ? { lead, rest } : undefined;
}

/** The place's own name for this entry, when the file writes it under one of
 *  the register's official spellings (primary or a bilingual alternate). The
 *  ASCII form is deliberately not accepted: "Sentjur" is a stripped spelling,
 *  not one the register uses. */
function writtenAsRegistered(written: string, entry: GazEntry): boolean {
  return entry.name === written || entry.alt.some((a) => a === written);
}

/** The looser test behind it: the same name once diacritics and case are set
 *  aside — "Sentjur" for "Šentjur", "capodistria" for "Capodistria". This is
 *  what makes a candidate *this* place; whether the file spells it the way the
 *  register does is then {@link writtenAsRegistered}'s question. */
function sameName(written: string, entry: GazEntry): boolean {
  const folded = foldToken(written);
  return [entry.name, entry.ascii, ...entry.alt].some((n) => n && foldToken(n) === folded);
}

/**
 * Hold every place value in the file against the place directories loaded —
 * every one of them, not the official registers alone: a file researched in
 * Austria and the United States is held to the OpenStreetMap and GeoNames
 * directories the researcher loaded for those countries, the same way a
 * Slovenian one is held to GURS. Where two directories describe one country,
 * both answer, and each answer says which directory it came from; an official
 * register outranks the rest, so where GURS or DGU knows the place it is the
 * one that decides.
 *
 * Scope is decided per value, and deliberately narrow — a report full of places
 * we cannot judge is worse than a short one:
 * - names a country a directory covers → checked, and reported as `notFound`
 *   when nothing in that directory holds the name;
 * - names a country no directory covers → left out entirely;
 * - names no country → checked only if a directory does match it, so a place
 *   that might be anywhere is never accused of not existing.
 *
 * House numbers written into the place value are left to the Addresses tab, and
 * placeholder values ("----") to the health check.
 */
export function checkPlacesAgainstRegister(
  dataset: Dataset,
  index: GazetteerIndex | undefined,
  decisions: ReadonlyMap<string, GeocodeDecision>,
  fmt?: PlaceTargetFormat,
): RegisterCheckReport {
  if (!index) return EMPTY;

  // The directories on hand and the countries they cover, each under the name
  // the rest of the app calls it by: the register code (SI-GURS), the download
  // key (AT-OSM), or the bare country code, which by convention means a
  // GeoNames file.
  const registers: string[] = [];
  const covered = new Set<string>();
  const adminNames: string[] = [];
  const seenAdmin = new Set<string>();
  for (const e of index.entries) {
    const directory = directoryOf(e);
    if (!registers.includes(directory)) registers.push(directory);
    covered.add(e.country);
    if (e.admin && !seenAdmin.has(e.admin)) {
      seenAdmin.add(e.admin);
      adminNames.push(e.admin);
    }
  }
  if (!covered.size) return EMPTY;

  // Distinct values with the people writing them, their occurrence count and the
  // settlement coordinate the file records for them — the most frequent one
  // carried by an event with no address (an address-bound coordinate is that
  // house's, not the place's, the same rule scanGeocode's `fileCoord` follows).
  const groups = new Map<
    string,
    { count: number; coords: Map<string, { coord: GeoCoord; n: number }>; people: Set<string> }
  >();
  const visit = (raw: Parameters<typeof walkPlaceAddr>[0], personIds: string[]) =>
    walkPlaceAddr(raw, (plac, addr) => {
      const key = plac.value!.trim();
      let g = groups.get(key);
      if (!g) {
        g = { count: 0, coords: new Map(), people: new Set() };
        groups.set(key, g);
      }
      g.count++;
      for (const id of personIds) g.people.add(id);
      if (addr) return;
      const coord = coordOf(plac);
      if (!coord) return;
      const ck = `${coord.lat}:${coord.lon}`;
      const hit = g.coords.get(ck);
      if (hit) hit.n++;
      else g.coords.set(ck, { coord, n: 1 });
    });
  for (const indi of dataset.individuals.values()) visit(indi.raw, [indi.id]);
  // A family event belongs to both spouses, the way scanGeocode attributes them.
  for (const fam of dataset.families.values())
    visit(fam.raw, [fam.husband, fam.wife].filter((id): id is string => !!id));

  const findings: RegisterFinding[] = [];
  let checked = 0;
  let ok = 0;
  let skipped = 0;

  for (const [key, g] of groups) {
    if (!key || isUnknownPlaceValue(key)) continue;
    const components = decomposePlace(key);
    const written = (components.locality ?? key.split(",")[0]).trim();
    if (!written) continue;

    // A house address written into the place value. Where the file keeps
    // addresses on their own ADDR line, this one is out of step with the rest
    // of it — and it is also why the value can never be held to a register of
    // settlements, since "Črni vrh 35" is a building. The split is proposed in
    // the file's own layout, which is what decides where each part belongs.
    const address = placeAddressDetail(components);
    if (address) {
      const split = fmt?.layout === "structured-addr" ? reformatPlace(key, undefined, fmt) : undefined;
      if (split?.addr && split.plac && split.plac !== key) {
        checked++;
        findings.push({
          key,
          count: g.count,
          people: [...g.people],
          verdict: "address",
          written,
          official: split.plac,
          officialAddr: split.addr,
          dismissed: isDismissed(decisions, key, "address"),
        });
      } else {
        // The file writes its addresses this way, or the split would change
        // nothing: either way the houses are the Addresses tab's business.
        skipped++;
      }
      continue;
    }
    if (isRegisterAddress(key)) continue;
    const wantCountry = components.country ? countryCode(components.country)?.toUpperCase() : undefined;
    // A country we can name but hold no register for: out of scope, and said so
    // in the summary rather than silently dropped.
    if (wantCountry && !covered.has(wantCountry)) {
      skipped++;
      continue;
    }
    // A value whose most specific level is a country names no settlement at all
    // ("Slovenia", or the doubled "Slovenia, Slovenia" a file writes for an
    // event known only by its country). A register of settlements has nothing
    // to say about it, and matching the country's name against settlement names
    // is how "Slovenia" ends up proposed as "Šlovrenc".
    if (countryCode(written)) {
      skipped++;
      continue;
    }

    // Only a name the register holds letter-for-letter (bar diacritics and case)
    // — or its own longer form of it, corroborated by the place's own parents —
    // can be said to be *this* place. A merely similar name is a guess: good
    // enough to offer as a coordinate in the geocode list, where the researcher
    // judges it against a map, but not to assert here that the register spells
    // the place differently or files it elsewhere. Left in, "Slovenia" is
    // reported as misspelling "Šlovrenc".
    const answersFor = (value: string) => {
      const name = (decomposePlace(value).locality ?? value.split(",")[0]).trim();
      return lookupPlace(index, value).filter(
        (c) => covered.has(c.entry.country) && (sameName(name, c.entry) || c.score >= PARENT_QUALIFIED),
      );
    };
    const candidates = answersFor(key);
    if (!candidates.length) {
      // Nothing matched. Only a value that says which country it is in can be
      // held to a register — otherwise we would report every foreign place in a
      // file whose gazetteer we never loaded.
      if (!wantCountry) {
        skipped++;
        continue;
      }
      checked++;
      // Before calling it unknown: the directory may know the place perfectly
      // well from its second level on, the first naming a cemetery, a township
      // or an election precinct — something standing *in* the place rather than
      // the place itself. That is a level to move, not a place to research, and
      // where the file keeps addresses apart it has somewhere to move to.
      const split = splitLeadingLevel(key);
      const under = split ? answersFor(split.rest) : [];
      if (split && under.length) {
        findings.push({
          key,
          count: g.count,
          people: [...g.people],
          verdict: "site",
          written: split.lead,
          entry: under[0].entry,
          official: split.rest,
          ...(fmt?.layout === "structured-addr" ? { officialAddr: split.lead } : {}),
          dismissed: isDismissed(decisions, key, "site"),
        });
        continue;
      }
      findings.push({
        key,
        count: g.count,
        people: [...g.people],
        verdict: "notFound",
        written,
        dismissed: isDismissed(decisions, key, "notFound"),
      });
      continue;
    }
    checked++;
    const fileCoord = [...g.coords.values()].sort((a, b) => b.n - a.n)[0]?.coord;

    // Same name, several register entries. A coordinate in the file settles it
    // — the nearest entry is the place meant — and only without one does the
    // tie stand as a finding of its own.
    const tied = candidates.filter((c) => c.score > candidates[0].score - AMBIGUITY_GAP);
    let best = candidates[0].entry;
    if (tied.length > 1) {
      if (fileCoord) {
        best = tied
          .map((c) => ({ entry: c.entry, km: distanceKm(fileCoord, c.entry) }))
          .sort((a, b) => a.km - b.km)[0].entry;
      } else {
        findings.push({
          key,
          count: g.count,
          people: [...g.people],
          verdict: "ambiguous",
          written,
          entry: best,
          alternatives: tied.map((c) => c.entry),
          dismissed: isDismissed(decisions, key, "ambiguous"),
        });
        continue;
      }
    }

    // The municipality the file names, when the register knows it as one. A
    // parent it does not recognize (a region, a parish, the country) says
    // nothing about where the register files the place, so it is passed over.
    const namedAdmin = components.jurisdiction
      .slice(1)
      .map((p) => p.trim())
      .find((p) => p && adminNames.some((a) => sameAdmin(a, p)));
    if (namedAdmin && best.admin && !sameAdmin(best.admin, namedAdmin)) {
      const official = replaceSegment(key, namedAdmin, best.admin);
      findings.push({
        key,
        count: g.count,
        people: [...g.people],
        verdict: "admin",
        written,
        entry: best,
        writtenAdmin: namedAdmin,
        ...(official ? { official } : {}),
        ...(fileCoord ? { fileCoord } : {}),
        dismissed: isDismissed(decisions, key, "admin"),
      });
      continue;
    }

    if (!writtenAsRegistered(written, best)) {
      const official = replaceLocality(key, best.name);
      findings.push({
        key,
        count: g.count,
        people: [...g.people],
        verdict: "spelling",
        written,
        entry: best,
        ...(official ? { official } : {}),
        ...(fileCoord ? { fileCoord } : {}),
        dismissed: isDismissed(decisions, key, "spelling"),
      });
      continue;
    }

    if (fileCoord) {
      const km = distanceKm(fileCoord, best);
      if (km > FAR_KM) {
        findings.push({
          key,
          count: g.count,
          people: [...g.people],
          verdict: "far",
          written,
          entry: best,
          fileCoord,
          distanceKm: km,
          dismissed: isDismissed(decisions, key, "far"),
        });
        continue;
      }
    }
    ok++;
  }

  const rank = (v: RegisterVerdict) => REGISTER_VERDICTS.indexOf(v);
  findings.sort(
    (a, b) =>
      Number(a.dismissed) - Number(b.dismissed) ||
      rank(a.verdict) - rank(b.verdict) ||
      b.count - a.count ||
      placeCollator.compare(a.key, b.key),
  );
  return { findings, checked, ok, skipped, registers };
}

/** Whether this finding was dismissed earlier. A "no match" mark from the
 *  geocode tool counts for `notFound` — it is the same judgement made in the
 *  other tab ("looked it up, the register has nothing") — but for nothing
 *  else. */
function isDismissed(
  decisions: ReadonlyMap<string, GeocodeDecision>,
  key: string,
  verdict: RegisterVerdict,
): boolean {
  if (decisions.get(registerDecisionKey(key))?.status === REGISTER_DISMISSED) return true;
  return verdict === "notFound" && decisions.get(key)?.status === "nomatch";
}
