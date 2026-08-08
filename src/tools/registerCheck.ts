import type { Dataset, GeoCoord } from "../gedcom/types";
import { decomposePlace, isUnknownPlaceValue, placeAddressDetail } from "../gedcom/place";
import { countryCodeOfName } from "../geo/placeCountry";
import { foldToken } from "../match/text";
import { lookupPlace, PARENT_QUALIFIED, qualifierKey, type GazEntry, type GazetteerIndex } from "../geo/gazetteer";
import { inferPlaceParentLevels, sameUnitName, type PlaceParentLevels } from "../geo/placeLevels";
import { distanceKm } from "../geo/points";
import { reformatPlace } from "../normalize/placeReformat";
import { placeFormFor } from "../normalize/profile";
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
 * - `region` the name is one the directory knows as a county or region rather
 *   than as a settlement, so no settlement will ever match it — an event known
 *   only by the wider area it happened in
 * - `ambiguous` the name fits several register entries and nothing tells them
 *   apart — no single entry can be said to be the one meant
 * - `admin` the file files the place under a parent the register doesn't — the
 *   municipality or, for a file that writes the level above it, the county
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
export type RegisterVerdict =
  | "notFound"
  | "region"
  | "ambiguous"
  | "admin"
  | "spelling"
  | "site"
  | "address"
  | "far";

export const REGISTER_VERDICTS: RegisterVerdict[] = [
  "notFound",
  "region",
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
  /** The whole place value as the finding would have it written — the
   *  register's spelling of the locality, its parent swapped, or a level that
   *  says nothing dropped. What "Use official name" writes. Absent when there
   *  is nothing to propose: a packed value whose leading segment is not its
   *  settlement, or a place the register simply does not hold. */
  official?: string;
  /** The house address to move onto the event's own `ADDR` line, with `official`
   *  holding the place left behind (`address`). */
  officialAddr?: string;
  /** What each comma part of `official` stands for, in this file's own wording —
   *  written as the renamed value's `FORM`. */
  officialForm?: string;
  /** The parent the file names — a municipality, or a county for a file that
   *  writes that level — when the register knows it but does not file this
   *  place under it (`admin`). */
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
  /**
   * What the file's own `PLAC`.`FORM` calls the levels of the places checked,
   * one line per country and in the file's own wording ("Mjesto, Županija,
   * Država").
   *
   * Reported because it is the file's own answer to the question every parent
   * finding turns on — whether the middle of a place is a county or a
   * municipality — and it is written nowhere the reader can see. Empty for a
   * file that labels no places, which is a house style too.
   */
  forms: { country: string; form: string }[];
}

const EMPTY: RegisterCheckReport = { findings: [], checked: 0, ok: 0, skipped: 0, registers: [], forms: [] };

/** The directory an entry came from, under the name the rest of the app shows:
 *  the official register's code (SI-GURS, HR-DGU), the download key (AT-OSM),
 *  or the bare country code, which by convention means a GeoNames file. */
export function directoryOf(entry: GazEntry): string {
  return entry.register ?? entry.source ?? entry.country;
}

/** Two administrative names for the same body — {@link sameUnitName}, which the
 *  division lookup uses for the same question one level up. */
const sameAdmin = sameUnitName;

/**
 * The place value with its second level dropped, when that level says nothing:
 * it is blank ("Slavonia, , Croatia" — a comma left behind by an export) or it
 * merely repeats the first ("Međimurje, Međimurje, Croatia", the same county
 * written twice). Both are how a value that names a region rather than a
 * settlement tends to reach a three-level file, and one comma less is the whole
 * correction. Every other level, the file's separator and its spacing stay
 * exactly as they are. Undefined when there is no such level to drop.
 */
function redundantLevelDropped(
  place: string,
  country: string,
  levels: PlaceParentLevels,
): string | undefined {
  const segments = place.split(",");
  // Dropping one must leave a place still naming something and its country.
  if (segments.length < 3) return undefined;
  const lead = segments[0].trim();
  const next = segments[1].trim();
  if (!lead) return undefined;
  const leadDivision = levels.divisionKeyIn(country, lead);
  const repeats =
    !next ||
    foldToken(next) === foldToken(lead) ||
    (!!leadDivision && levels.divisionKeyIn(country, next) === leadDivision);
  if (!repeats) return undefined;
  const out = [segments[0], ...segments.slice(2)].join(",");
  return out.trim() && out !== place ? out : undefined;
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
  const saint = qualifierKey(written);
  return [entry.name, entry.ascii, ...entry.alt].some(
    (n) => n && (foldToken(n) === folded || (!!saint && qualifierKey(n) === saint)),
  );
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
  // Municipality names per country, not pooled: a Slovenian občina must not
  // make a Croatian place's parent look like a municipality the register knows.
  const adminNames = new Map<string, string[]>();
  const seenAdmin = new Set<string>();
  for (const e of index.entries) {
    const directory = directoryOf(e);
    if (!registers.includes(directory)) registers.push(directory);
    covered.add(e.country);
    if (e.admin && !seenAdmin.has(`${e.country}:${e.admin}`)) {
      seenAdmin.add(`${e.country}:${e.admin}`);
      const names = adminNames.get(e.country) ?? [];
      names.push(e.admin);
      adminNames.set(e.country, names);
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

  // How this file names the level above a settlement, read off the places it
  // already has — the difference between a county and a municipality standing
  // in the same slot.
  const levels = inferPlaceParentLevels([...groups.keys()], index, fmt);

  const findings: RegisterFinding[] = [];
  /** Country display name → its FORM lines, by how many places carry each. */
  const formTally = new Map<string, Map<string, number>>();
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
    const wantCountry = components.country ? countryCodeOfName(components.country)?.toUpperCase() : undefined;
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
    if (countryCodeOfName(written)) {
      skipped++;
      continue;
    }

    // What this file itself says the levels of a place like this one are.
    // Counted by occurrences, so a country written at two depths reports the
    // labels of the shape it mostly uses rather than the first one seen.
    const country = components.country;
    const form = fmt && country ? placeFormFor(fmt, key, country) : undefined;
    if (form && country) {
      const byForm = formTally.get(country) ?? new Map<string, number>();
      byForm.set(form, (byForm.get(form) ?? 0) + g.count);
      formTally.set(country, byForm);
    }

    // Only a name the register holds letter-for-letter (bar diacritics and case)
    // — or its own longer form of it, corroborated by the place's own parents —
    // can be said to be *this* place. A merely similar name is a guess: good
    // enough to offer as a coordinate in the geocode list, where the researcher
    // judges it against a map, but not to assert here that the register spells
    // the place differently or files it elsewhere. Left in, "Slovenia" is
    // reported as misspelling "Šlovrenc".
    const fileCoord = [...g.coords.values()].sort((a, b) => b.n - a.n)[0]?.coord;
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
          ...(fileCoord ? { fileCoord } : {}),
          ...(fmt?.layout === "structured-addr" ? { officialAddr: split.lead } : {}),
          dismissed: isDismissed(decisions, key, "site"),
        });
        continue;
      }
      // Nor is a name the directory holds as a *county* a place to research: no
      // register of settlements will ever match "Međimurje", because it is the
      // county the event is known by rather than the village in it. Said as
      // much, with the level that merely repeats it — or the blank one an
      // export left behind — offered for dropping, one comma less.
      const verdict = levels.divisionKeyIn(wantCountry, written) ? "region" : "notFound";
      const shorter = redundantLevelDropped(key, wantCountry, levels);
      findings.push({
        key,
        count: g.count,
        people: [...g.people],
        verdict,
        written,
        ...(shorter ? { official: shorter } : {}),
        ...(fileCoord ? { fileCoord } : {}),
        dismissed: isDismissed(decisions, key, verdict),
      });
      continue;
    }
    checked++;

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
          ...(fileCoord ? { fileCoord } : {}),
          dismissed: isDismissed(decisions, key, "ambiguous"),
        });
        continue;
      }
    }

    // The parent the file names above the settlement, held against the register
    // at *its own* level. The register describes two: the municipality every
    // entry names, and the division above it (a županija, a county) whose code
    // the entries of some countries carry. A file writes one or the other as a
    // house style, and a county held against a municipality could only ever be
    // reported as disagreeing — which is what a file written at county level
    // used to get, one finding per place.
    //
    // A parent the register recognizes at neither level (a region it does not
    // list, a parish, the country) says nothing about where the place is filed,
    // so it is passed over as before.
    const parents = components.jurisdiction
      .slice(1)
      .map((p) => p.trim())
      .filter(Boolean);
    const divisionsHere = levels.divisionNamesIn(best.country);
    const namedDivision = parents.find((p) => divisionsHere.some((d) => sameAdmin(d, p)));
    let disagrees: { writtenAdmin: string; to: string | undefined } | undefined;
    if (namedDivision) {
      // An entry the register could file under no division cannot contradict
      // one — the county join is by name, and a few names it cannot resolve.
      const own = levels.divisionNamesOf(best);
      if (own.length && !own.some((d) => sameAdmin(d, namedDivision))) {
        disagrees = { writtenAdmin: namedDivision, to: levels.divisionNameOf(best) };
      }
    } else {
      const namedAdmin = parents.find((p) =>
        (adminNames.get(best.country) ?? []).some((a) => sameAdmin(a, p)),
      );
      if (namedAdmin && best.admin && !sameAdmin(best.admin, namedAdmin)) {
        disagrees = { writtenAdmin: namedAdmin, to: best.admin };
      }
    }
    if (disagrees) {
      const official = disagrees.to ? replaceSegment(key, disagrees.writtenAdmin, disagrees.to) : undefined;
      findings.push({
        key,
        count: g.count,
        people: [...g.people],
        verdict: "admin",
        written,
        entry: best,
        writtenAdmin: disagrees.writtenAdmin,
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

  // The label line each proposal deserves. A value taken from a register
  // arrives with its levels known, and the file's own attested FORM for a place
  // of that shape is what says so in the file's own wording — so "Kranj,
  // Slovenija" taken over "Kranj, , , Slovenija" gets the two-level labels
  // rather than keeping the four-level ones, which would then name parts the
  // value no longer has. Absent where the file attests no FORM for that shape:
  // the write then drops a stale one rather than inventing a line.
  for (const f of findings) {
    if (!f.official || !fmt) continue;
    const country = decomposePlace(f.official).country;
    // A `region` row is the one case the file's own labels for that *shape*
    // would get wrong. Its correction drops the level that repeats or says
    // nothing and keeps the lead — and the lead is the region, which is why the
    // row is here at all. Labelled by shape, "Međimurje, Croatia" would take
    // the two-level line every Croatian place uses and call a county a Place.
    // Its own FORM already answers this: "Place, Regija, Country" minus the
    // Place slot the file never had a settlement for is "Regija, Country".
    const own = f.verdict === "region" ? placeFormFor(fmt, f.key, country) : undefined;
    const ownLabels = own?.split(",") ?? [];
    const form =
      ownLabels.length === f.key.split(",").length && ownLabels.length === f.official.split(",").length + 1
        ? ownLabels.slice(1).join(",")
        : placeFormFor(fmt, f.official, country);
    if (form) f.officialForm = form;
  }

  const rank = (v: RegisterVerdict) => REGISTER_VERDICTS.indexOf(v);
  findings.sort(
    (a, b) =>
      Number(a.dismissed) - Number(b.dismissed) ||
      rank(a.verdict) - rank(b.verdict) ||
      b.count - a.count ||
      placeCollator.compare(a.key, b.key),
  );
  const forms = [...formTally]
    .map(([country, byForm]) => ({
      country,
      form: [...byForm].sort((a, b) => b[1] - a[1])[0][0],
    }))
    .sort((a, b) => placeCollator.compare(a.country, b.country));
  return { findings, checked, ok, skipped, registers, forms };
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
  return (verdict === "notFound" || verdict === "region") && decisions.get(key)?.status === "nomatch";
}
