import { createThrottledQueue, geoFetch } from "./net";
import type { GeoCoord } from "../gedcom/types";
import { countryCode } from "../gedcom/countryCode";
import { addressStreetName, decomposePlace, looksLikeStreet } from "../gedcom/place";
import { foldToken } from "../match/text";
import { d96ToWgs84 } from "./d96";
import { hasLocalRegister, localRegisters, searchLocalAddress } from "./addressLookup";

// RN — the GURS register of addresses (Register naslovov) — is the official
// Slovenian address gazetteer: every house number in the country with its exact
// coordinate. It serves CORS `*`, so the browser queries it directly (no relay),
// and it is opt-in behind the same online-lookups setting as the Nominatim and
// GOV searches.
//
// This module is also where an address lookup is *dispatched*. A query carries
// the country whose register can answer it, and a country whose register has
// been *downloaded* is answered from this browser instead (addressLookup.ts) —
// always for Croatia, which publishes no service to ask, and for Slovenia
// whenever the download is there, falling back to the ladder below when it is
// not. The query and result shapes are shared, so everything downstream — the
// review rows, the batch pool, the pick UI — is written once and neither side
// knows which register answered.
//
// Where the settlements register (RPE) places a village, this places the *house*
// within it, which is what a genealogical ADDR — or a PLAC carrying a hišna
// številka — actually names. Two register quirks shape this module:
//   - features arrive with `geometry: null`; the coordinate is in the `E`/`N`
//     properties, in D96/TM, hence d96ToWgs84.
//   - the filter language is CQL 1 (`cql-text`), NOT cql2-text, and a bare
//     `&FIELD=value` query parameter is silently *ignored* — it returns the
//     whole 1.1 M-row collection. Every filter must go through `filter=`.
//
// Data: Geodetska uprava Republike Slovenije, CC BY 4.0.

const ENDPOINT = "https://ipi.eprostor.gov.si/wfs-si-gurs-rn/ogc/features/collections/SI.GURS.RN:REGISTER_NASLOVOV/items";

/** Minimum spacing between requests — the register is a public service. */
const INTERVAL_MS = 350;
/** Rows to ask for. One address can repeat per apartment (Slovenska cesta 9 is
 *  80 rows sharing one coordinate), so fetch generously and dedupe locally. */
const FETCH_LIMIT = 60;
/** Distinct addresses returned to the review UI. */
const MAX_RESULTS = 6;

/** What the register is asked for: a house number, and the place around it. */
export interface RnQuery {
  /** Which country's register answers this — "HR" for the offline Croatian
   *  register, absent for Slovenia's, which is the default and the only one
   *  a value naming no country at all can mean. */
  country?: "HR";
  /** Settlement (naselje) the number belongs to. */
  settlement: string;
  /** Street name without its number, when the address names one. */
  street?: string;
  /** House number proper (HS_STEVILKA). */
  number: number;
  /** Single-letter subdivision suffix (HS_DODATEK), e.g. the "a" of "38/a". */
  suffix?: string;
  /** Further settlement names to try if `settlement` finds nothing, outward
   *  through the place's jurisdictions. A file may name the historical village
   *  ("Stražišče, Kranj") while the register files that street under the town it
   *  was absorbed into — Hafnarjeva pot is naselje Kranj, not Stražišče, even
   *  though Stražišče is itself a naselje. */
  altSettlements?: string[];
  /** The administrative levels the place names above its settlement — the občina
   *  of "Stražišče, Kranj, Slovenia", and any wider level. The register files
   *  every address under an OBCINA_NAZIV, so these are what tell a settlement
   *  apart from its namesakes elsewhere in the country. */
  parents?: string[];
}

/** One register address resolved to what the review UI needs. */
export interface RnResult {
  coord: GeoCoord;
  /** Street-address line, e.g. "Kidričeva cesta 38a" or "Šentvid pri Stični 23". */
  address: string;
  /** Post code + post name, e.g. "1000 Ljubljana". */
  post?: string;
  /** Full pick line: address, settlement when it differs, and the post office. */
  label: string;
  settlement: string;
  /** The municipality (občina) the register files that settlement under —
   *  what tells "Klošter in Metlika" apart from a same-named place elsewhere. */
  municipality?: string;
  /** House number this result is, for matching a batch back to its rows. */
  number: number;
  /** Its letter suffix, lowercased; absent when the register records none. */
  suffix?: string;
}

/** Leading house number plus an optional letter suffix: "23", "12a", "38/a". */
const NUMBER_SUFFIX = /^(\d{1,5})\s*\/?\s*([a-zA-Z])?/;

/**
 * Every house number a value names. Genealogical records often carry more than
 * one because the numbering changed over the years — "Hafnarjeva pot 21a / 53"
 * is one house that was 21a and later 53 — and which is which is not recorded,
 * so all of them are looked up and the choice is left to the researcher.
 *
 * A slash before a digit separates two numbers; a slash before a letter is a
 * subdivision suffix belonging to its number ("38/a"), which is the same
 * distinction `normNum` makes when formatting these values.
 */
export function parseHouseNumbers(raw: string): { number: number; suffix?: string }[] {
  const out: { number: number; suffix?: string }[] = [];
  for (const part of raw.split(/\s*\/\s*(?=\d)/)) {
    const m = NUMBER_SUFFIX.exec(part.trim());
    if (!m) continue;
    const number = Number(m[1]);
    if (!Number.isFinite(number) || number <= 0) continue;
    const suffix = m[2]?.toLowerCase();
    if (out.some((n) => n.number === number && n.suffix === suffix)) continue;
    out.push(suffix ? { number, suffix } : { number });
  }
  return out;
}

/** A segment that names a street (or settlement) of its own and then a house
 *  number — "Škofjeloška 4", as opposed to the bare "26" or the suffix "a"
 *  that a slash separates from the number before it. */
const OWN_STREET = /^\D+\s\d/;

/**
 * The whole addresses a value lists, when a slash separates more than numbers.
 *
 * A house whose *street* was renamed is recorded with both names — "Labore 4 /
 * Škofjeloška 4" is one building on a street Kranj renamed — and each half is a
 * complete address the register can answer. Read as one string it is neither:
 * the street becomes "Labore 4 / Škofjeloška", which no register knows.
 *
 * Only a segment naming its own street starts a new variant, so the far more
 * common lists of numbers alone ("16 / 26", the suffix in "38/a") stay one
 * address and go on to {@link parseHouseNumbers}, which is what reads those.
 */
export function splitAddressVariants(value: string): string[] {
  const parts = value.split("/");
  if (parts.length < 2) return [value.trim()];
  const out: string[] = [];
  for (const part of parts) {
    const segment = part.trim();
    if (!segment) continue;
    if (!out.length) out.push(segment);
    else if (OWN_STREET.test(segment)) out.push(segment);
    // A tail that names no street of its own belongs to the address before it.
    else out[out.length - 1] += ` / ${segment}`;
  }
  // One address after all — handed back exactly as the file writes it, so the
  // ordinary path sees the untouched text.
  return out.length > 1 ? out : [value.trim()];
}

/** A CQL string literal — single quotes double up. */
function cqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const sameName = (a: string | undefined, b: string | undefined): boolean =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Whether `host` names the same place as `settlement`, allowing the file to have
 * abbreviated it: a village whose register name carries a qualifier is very
 * often written short in the address — "Sadinja vas 9" for the register's
 * "Sadinja vas pri Dvoru", "Zgornje Bitnje 4" for "Zgornje Bitnje". Read as a
 * street that spelling finds nothing, twice: no such street exists, and the
 * short form is frequently a *different* real settlement elsewhere in the
 * country (there is a Sadinja vas in Ljubljana), so the fallback misses too.
 *
 * A whole-word prefix only, and at least two words in the longer name, so
 * "Kidričeva" cannot swallow a settlement it merely starts like.
 */
function abbreviates(host: string | undefined, settlement: string | undefined): boolean {
  if (!host || !settlement) return false;
  const h = host.trim().toLowerCase();
  const s = settlement.trim().toLowerCase();
  if (h === s) return true;
  const [shorter, longer] = h.length < s.length ? [h, s] : [s, h];
  return longer.startsWith(`${shorter} `) && shorter.includes(" ");
}

/**
 * Derive a register query from an event's PLAC and ADDR values together — the
 * two are complementary, not alternatives: Slovenian files put the house number
 * sometimes in ADDR ("Kidričeva cesta 38/a") and just as often in PLAC itself
 * ("Šentvid pri Stični 23"), while the settlement that number belongs to is
 * usually only in PLAC. Whichever side carries which part, this merges them.
 *
 * The register mirrors that same split: a town address has ULICA_NAZIV set,
 * while village numbering leaves it null and hangs the number off the settlement.
 * `addressStreetName` already yields "the name the number sits on" for either
 * shape, so the only question left is whether that name *is* the settlement.
 *
 * Both registers are read this way: the query shape is the same, and the country
 * the value names decides which of them the query is marked for.
 *
 * Returns one query per house number the value names — several when the numbering
 * changed over time ("21a / 53"), so every candidate house can be offered. Empty
 * when there is no house number to look up, when no settlement can be identified
 * (a bare "Slovenska cesta 9" names no town), or when the value names a country
 * neither register covers — asking either would be pointless traffic.
 */
export function rnQueriesFrom(place: string | undefined, address: string | undefined): RnQuery[] {
  // A house recorded under both its old and its new street name is two whole
  // addresses in one value; each is looked up on its own, since the register
  // knows them as different streets (see {@link splitAddressVariants}).
  const variants = address?.trim() ? splitAddressVariants(address) : [];
  if (variants.length > 1) {
    const seen = new Set<string>();
    return variants
      .flatMap((variant) => rnQueriesFrom(place, variant))
      .filter((q) => {
        const key = JSON.stringify(q);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }
  const p = place?.trim() ? decomposePlace(place) : undefined;
  const a = address?.trim() ? decomposePlace(address) : undefined;

  // Which register can answer at all. Slovenia and Croatia are the two with a
  // house-level register here; an unnamed country is fine (most files leave it
  // implicit) and reads as Slovenia, which is what it has always meant. A value
  // naming both — a place in one country, an ADDR in the other — is a
  // contradiction no register should be asked to resolve.
  const named = [p?.country, a?.country]
    .map((c) => (c ? countryCode(c)?.toUpperCase() : undefined))
    .filter((c): c is string => !!c);
  if (named.some((c) => c !== "SI" && c !== "HR")) return [];
  if (new Set(named).size > 1) return [];
  const country = named[0] === "HR" ? ("HR" as const) : undefined;

  // The house number(s): ADDR is the more specific field, so it wins.
  const rawNumber = a?.houseNumber ?? p?.houseNumber;
  if (!rawNumber) return [];
  const numbers = parseHouseNumbers(rawNumber);
  if (!numbers.length) return [];

  // Whatever the number hangs off — a street in town, or the settlement itself.
  const host = addressStreetName(address) ?? addressStreetName(place);

  // The settlement: the outermost-first jurisdiction levels of PLAC (then ADDR),
  // skipping the country and any level that is really a street name — a packed
  // "Kidričeva cesta 38, Kranj" puts the street in locality and the town next.
  const usable = (levels: readonly (string | undefined)[]): string[] =>
    levels
      .map((s) => s?.trim())
      .filter((s): s is string => !!s)
      .filter((s) => !sameName(s, p?.country) && !sameName(s, a?.country) && !looksLikeStreet(s));
  // PLAC's levels are kept apart because only they are administrative: ADDR's
  // locality is another name for the same settlement, never a parent of it.
  const placeLevels = usable(p?.jurisdiction ?? []);
  const candidates = [...placeLevels, ...usable([a?.locality])];
  if (!candidates.length) return [];

  // A host that isn't the most specific place named is the street; when it *is*
  // that place — or the file's short form of it — this is village numbering and
  // the register wants no street at all.
  const street = host && !abbreviates(host, candidates[0]) ? host : undefined;

  // Drop the street from the settlement candidates. Identity, not vocabulary:
  // "Hafnarjeva pot" is a street but carries none of the words looksLikeStreet
  // knows, and left in it would become a bogus NASELJE_NAZIV='Hafnarjeva pot'.
  const levels = street ? candidates.filter((s) => !sameName(s, street)) : candidates;

  // The file's own short form of the settlement is the same place, not another
  // one to fall back to — and left in it is dangerous, since a short form is
  // often a different real settlement elsewhere ("Sadinja vas" is also a
  // Ljubljana suburb, whose houses the widened search would happily return).
  // Applied with a street too: "Kranj,Kranj" made the settlement its own
  // alternate, and every unmatched address re-ran the whole ladder against an
  // identical filter — a second of dead round-trips per house.
  const [settlement, ...altSettlements] = levels.filter((s, i) => i === 0 || !abbreviates(s, levels[0]));
  if (!settlement) return [];

  // Every PLAC level above the settlement is administrative context, kept whole
  // rather than guessing which one is the občina: a file that names a parish or a
  // region instead simply matches no OBCINA_NAZIV, which the scoping below reads
  // as "no opinion" rather than as a contradiction. "Kranj, Kranj" is not a
  // duplicate to collapse — the town's own občina is the useful case.
  const parents = (street ? placeLevels.filter((s) => !sameName(s, street)) : placeLevels)
    .slice(1)
    .filter((s, i, all) => all.findIndex((o) => sameName(o, s)) === i);
  return numbers.map((n) => ({
    ...(country ? { country } : {}),
    settlement,
    ...(street ? { street } : {}),
    ...n,
    ...(altSettlements.length ? { altSettlements } : {}),
    ...(parents.length ? { parents } : {}),
  }));
}

/**
 * Whether these queries can be answered without the network — every one of them
 * belonging to a country whose register this browser has downloaded.
 *
 * The online-lookups setting exists to control what leaves the device, so it
 * has nothing to say about such a query: the register is already here, and the
 * lookup is an IndexedDB read. The UI asks this before hiding a register button
 * behind that opt-in, which is why the answer has to come without awaiting
 * anything (see addressLookup's `localRegisters`).
 *
 * False for an empty list — there is nothing to answer, and "yes, offline" would
 * read as an offer.
 */
export function isOfflineQuery(queries: readonly RnQuery[]): boolean {
  const stored = localRegisters();
  return queries.length > 0 && queries.every((q) => stored.has(q.country ?? "SI"));
}

/**
 * The hits whose municipality is one the place itself names. Slovenia reuses
 * settlement names freely — there is a Klanec in Komenda, an Orehek in Postojna,
 * a Stražišče in each of Cerknica, Prevalje and Ravne na Koroškem — and the
 * register matches NASELJE_NAZIV across the whole country, so a name alone
 * cheerfully answers with a house 100 km away. `OBCINA_NAZIV` is what tells them
 * apart, and the place value usually names it already.
 *
 * Empty when the place names no parent, or names one the register does not know
 * as a municipality (a parish, a region) — the caller decides whether that
 * silence means "keep everything" or "keep nothing".
 */
function inParentMunicipality(hits: RnResult[], parents?: readonly string[]): RnResult[] {
  if (!parents?.length) return [];
  const wanted = new Set(parents.map(foldToken).filter(Boolean));
  if (!wanted.size) return [];
  // A hit the register filed under no municipality can't contradict anything.
  return hits.filter((h) => !h.municipality || wanted.has(foldToken(h.municipality)));
}

/**
 * Municipality names probed this session: folded name → does the register file
 * any address under it. Slovenia's 212 občine are a closed set that cannot change
 * mid-session, so one row settles a name for good.
 */
const municipalityProbe = new Map<string, Promise<boolean>>();

/** Whether the register knows a municipality by exactly this name. One row is
 *  enough, and a failed request answers "don't know" — which keeps the caller
 *  lenient rather than letting a network hiccup delete good results. The
 *  failure itself is not cached: "don't know" makes the veto fail open, and a
 *  hiccup (or an aborted lookup) remembered for the whole session would keep
 *  offering wrong-občina namesakes long after the network recovered. */
function isMunicipality(name: string, signal?: AbortSignal): Promise<boolean> {
  const key = foldToken(name);
  let probe = municipalityProbe.get(key);
  if (!probe) {
    probe = rnFetch(`OBCINA_NAZIV=${cqlString(name)}`, signal, 1)
      .then((data) => !!data.features?.length)
      .catch(() => {
        if (municipalityProbe.get(key) === probe) municipalityProbe.delete(key);
        return false;
      });
    municipalityProbe.set(key, probe);
  }
  return probe;
}

/**
 * Narrow to the place's own municipality, to nothing if need be. Every rung is
 * held to it: whether the settlement name is the file's own word or our guess
 * ({@link hostAsSettlement}), a namesake in another občina that happens to own
 * the number is not a worse answer but a wrong one — Komenda's Klanec for a
 * Kranj record, Dravograd's Sv. Duh for one in Škofja Loka.
 *
 * When nothing matches, the file's parent level is checked against the register
 * before the hits are discarded, because "no match" has two very different
 * causes. "Kranj" is a real občina, so a Klanec filed under Komenda contradicts
 * it and goes. "Bela krajina" is a region the register has never heard of, so it
 * contradicts nothing and Klošter (Metlika) stands — the file simply named a
 * level the register does not keep.
 */
export async function requireParentMunicipality(
  hits: RnResult[],
  parents?: readonly string[],
  signal?: AbortSignal,
): Promise<RnResult[]> {
  if (!parents?.length || !hits.length) return hits;
  const kept = inParentMunicipality(hits, parents);
  if (kept.length) return kept;
  for (const parent of parents) {
    if (await isMunicipality(parent, signal)) return [];
  }
  return hits;
}

/**
 * CQL 1 filter for one query. The street is matched as a prefix because files
 * abbreviate ("Kidričeva" for the register's "Kidričeva cesta"), while the
 * settlement and number are matched exactly. Note the register is
 * case-sensitive and has no UPPER() function, so the caller's spelling is used
 * as written.
 *
 * With no street, the number is required to hang off the settlement itself
 * (`ULICA_NAZIV IS NULL`) — real village numbering. Without that clause a
 * settlement that *does* have streets matches its number on every one of them
 * ("Bled 4" hits 9 different houses), so the precise reading comes first and
 * `anyStreet` is the caller's deliberate widening when it finds nothing.
 */
export function buildRnFilter(query: RnQuery, opts?: { anyStreet?: boolean }): string {
  const clauses = [`NASELJE_NAZIV=${cqlString(query.settlement)}`, `HS_STEVILKA=${query.number}`];
  if (query.street) clauses.push(`ULICA_NAZIV LIKE ${cqlString(`${query.street}%`)}`);
  else if (!opts?.anyStreet) clauses.push("ULICA_NAZIV IS NULL");
  clauses.push(query.suffix ? `HS_DODATEK=${cqlString(query.suffix)}` : "HS_DODATEK IS NULL");
  return clauses.join(" AND ");
}

/** The register feature properties this module reads. */
export interface RnFeatureCollection {
  features?: { properties?: Record<string, unknown> | null }[];
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

/**
 * Convert a register response into distinct addresses. Apartment rows repeat one
 * building at one coordinate (`ST_STANOVANJA` differing), so rows are collapsed
 * by coordinate; rows whose E/N is missing or implausible are dropped.
 */
export function rnFeaturesToResults(data: RnFeatureCollection, max = MAX_RESULTS): RnResult[] {
  const byCoord = new Map<string, RnResult>();
  for (const feature of data.features ?? []) {
    const props = feature.properties;
    if (!props) continue;
    const coord = d96ToWgs84(Number(props.E), Number(props.N));
    if (!coord) continue;
    const key = `${coord.lat.toFixed(6)}:${coord.lon.toFixed(6)}`;
    if (byCoord.has(key)) continue;

    const settlement = str(props.NASELJE_NAZIV);
    const street = str(props.ULICA_NAZIV);
    const number = str(props.HS_STEVILKA) + str(props.HS_DODATEK);
    if (!number) continue;
    // Village numbering has no street: the settlement name carries the number.
    const address = `${street || settlement} ${number}`.trim();
    const postCode = str(props.POSTNI_OKOLIS_SIFRA);
    const postName = str(props.POSTNI_OKOLIS_NAZIV);
    const post = postCode && postName ? `${postCode} ${postName}` : postCode || postName || "";

    const parts = [address];
    if (street && settlement) parts.push(settlement);
    if (post) parts.push(post);
    const municipality = str(props.OBCINA_NAZIV);
    const result: RnResult = {
      coord,
      address,
      label: parts.join(", "),
      settlement,
      ...(municipality ? { municipality } : {}),
      number: Number(str(props.HS_STEVILKA)),
      ...(str(props.HS_DODATEK) ? { suffix: str(props.HS_DODATEK).toLowerCase() } : {}),
    };
    if (post) result.post = post;
    byCoord.set(key, result);
  }
  return [...byCoord.values()].slice(0, max);
}

// One shared queue so concurrent rows still space their requests out.
const enqueue = createThrottledQueue(INTERVAL_MS);

/** Run one throttled register request and return the parsed response. */
function rnFetch(filter: string, signal?: AbortSignal, limit = FETCH_LIMIT): Promise<RnFeatureCollection> {
  return enqueue(async () => {
    const url =
      `${ENDPOINT}?f=${encodeURIComponent("application/geo+json")}` +
      `&filter-lang=cql-text&limit=${limit}&filter=${encodeURIComponent(filter)}`;
    const res = await geoFetch(url, {}, signal);
    return (await res.json()) as RnFeatureCollection;
  }, signal);
}

/**
 * Look one address up in the register, narrowest reading first and widening only
 * when that finds nothing:
 *   1. exactly as written;
 *   2. without the letter suffix, for a file that records "21a" where the
 *      register has plain 21;
 *   3. for a street-less address, across every street in the settlement — a file
 *      writing "Bled 4" village-style when Bled in fact has streets. These come
 *      back as several candidates for the user to choose between, which is
 *      honest: the file does not say which street, so neither can we.
 * That ladder is then repeated for each of `altSettlements`, since the settlement
 * the file names may not be the one the register files the street under.
 *
 * The last rung reads the "street" as a settlement instead ({@link hostAsSettlement}):
 * a number that hangs off neither the place named nor a street of it is very
 * often a neighbouring hamlet the file files under its bigger neighbour. That
 * both finds the house and — since the result carries the register's own
 * settlement — is what reveals the misfiling.
 *
 * Every rung is held to the place's own municipality ({@link
 * requireParentMunicipality}): settlement names repeat across the country, and a
 * namesake that happens to own the number is a wrong answer, not a fallback —
 * "Sv. Duh 6" under Škofja Loka must not be answered by the Sv. Duh in
 * Dravograd just because the Škofja Loka village no longer numbers a 6.
 *
 * Resolves to [] when nothing matches at all — including a settlement spelled
 * differently from the register (it matches case- and diacritic-sensitively),
 * which the review UI shows as "no match" so the row can fall back to a
 * manual pick.
 */
export async function searchAddress(query: RnQuery, signal?: AbortSignal): Promise<RnResult[]> {
  // A downloaded register answers instead, walking the same ladder offline.
  // Croatia has no alternative — there is no service to ask — so its query goes
  // there whether or not anything is stored, and an empty answer is the honest
  // one. Slovenia falls through to the ladder below when nothing is stored.
  if (query.country === "HR" || (await hasLocalRegister("SI"))) {
    return searchLocalAddress(query.country ?? "SI", query);
  }
  for (const settlement of [query.settlement, ...(query.altSettlements ?? [])]) {
    const hits = await searchInSettlement({ ...query, settlement }, signal);
    if (hits.length) return hits;
  }
  const asSettlement = hostAsSettlement(query);
  if (asSettlement) return searchInSettlement(asSettlement, signal);
  return [];
}

/**
 * The same house number read as village numbering in the "street" itself —
 * `Klošter 12` under Gradac asked as naselje Klošter rather than a Gradac street.
 * Undefined when the address names a real street ("Kidričeva cesta 38"), which
 * is a settlement no register would know.
 */
export function hostAsSettlement(query: RnQuery): RnQuery | undefined {
  if (!query.street || looksLikeStreet(query.street)) return undefined;
  const { street: _street, altSettlements: _alt, ...rest } = query;
  return { ...rest, settlement: query.street };
}

/** The widening ladder within one settlement. Each rung is held to the place's
 *  own municipality before it is counted, so a namesake elsewhere in the country
 *  can neither answer the row nor crowd the right house out of the six shown. */
async function searchInSettlement(query: RnQuery, signal?: AbortSignal): Promise<RnResult[]> {
  const rung = async (filter: string): Promise<RnResult[]> =>
    (
      await requireParentMunicipality(
        rnFeaturesToResults(await rnFetch(filter, signal), Infinity),
        query.parents,
        signal,
      )
    ).slice(0, MAX_RESULTS);

  const exact = await rung(buildRnFilter(query));
  if (exact.length) return exact;

  if (query.suffix) {
    const { suffix: _suffix, ...bare } = query;
    const noSuffix = await rung(buildRnFilter(bare));
    if (noSuffix.length) return noSuffix;
  }

  if (!query.street) {
    return rung(buildRnFilter(query, { anyStreet: true }));
  }
  return [];
}

/**
 * Look up every number a value names ({@link rnQueriesFrom}) and merge the hits,
 * deduplicated by coordinate. Each result's label carries its own house number,
 * so a value recorded as "21a / 53" comes back as both houses for the researcher
 * to choose between. Queries run through the shared throttle, in order.
 */
export async function searchAddresses(queries: readonly RnQuery[], signal?: AbortSignal): Promise<RnResult[]> {
  const merged: RnResult[] = [];
  // One variant's network failure must not discard the houses the others
  // already found ("21a / 53" is two lookups); but when nothing was found and
  // something failed, that failure is the answer — swallowing it would let a
  // hiccup read as "no such house".
  let failure: unknown;
  let failed = false;
  for (const query of queries) {
    let hits: RnResult[];
    try {
      hits = await searchAddress(query, signal);
    } catch (err) {
      failure = err;
      failed = true;
      continue;
    }
    for (const hit of hits) {
      if (merged.some((m) => m.coord.lat === hit.coord.lat && m.coord.lon === hit.coord.lon)) continue;
      merged.push(hit);
    }
  }
  if (!merged.length && failed) throw failure;
  return merged;
}

/** A batch's results, kept per query group so no row can be answered by a house
 *  fetched for another. Keyed by {@link groupKey}. */
export type BatchPool = ReadonlyMap<string, RnResult[]>;

/** The settlement+street a query is fetched under, plus the municipality its hits
 *  are scoped to — what the register must match, and therefore what a result is
 *  only valid for. The country leads it because it decides *which* register was
 *  asked: two same-named villages either side of the border must never pool. */
function groupKey(q: Pick<RnQuery, "country" | "settlement" | "street" | "parents">): string {
  return [q.country ?? "SI", q.settlement, q.street ?? "", ...(q.parents ?? [])].join("\u0000");
}

/** Numbers per batched request — keeps the filter (and the URL) a sane length. */
const BATCH_NUMBERS = 80;
/** Rows a batched request may return: one number can be many apartments. */
const BATCH_LIMIT = 1000;

/**
 * Resolve many house numbers of one place in as few requests as possible.
 *
 * The register accepts `HS_STEVILKA IN (…)`, so a village's whole address list
 * is one request rather than one per address — which matters a great deal: the
 * per-address path costs up to four throttled requests each, so a place with 37
 * addresses took over a minute and looked hung.
 *
 * Queries are grouped by settlement and street (the parts that must match
 * exactly), and each group's hits are kept under that group's key for
 * {@link resultsForQuery} to hand back to its own rows — never pooled together.
 * Pooling them was a real defect: results were distributed by house number
 * alone, so "Sadinja Vas 5" could be answered by a "Vrtača 5" fetched for a
 * different address of the same place, and the wrong house's coordinate written.
 * Suffixes are deliberately *not* constrained here — asking for "4" also returns
 * 4a/4b, which is what lets a row whose file says "4a" find the register's plain
 * 4 without a second request.
 *
 * Each group walks the same widening ladder the single-address path does:
 *   1. as written;
 *   2. street-less, across every street of the settlement — a village-style
 *      number in a settlement that does have streets ("Sadinja vas 9" in the
 *      Ljubljana Sadinja vas, whose houses all hang off one);
 *   3. the "street" read as a settlement of its own ({@link hostAsSettlement}) —
 *      a hamlet filed under its neighbour, the case where a whole group fails
 *      at once.
 * Each rung is held to the municipality the place names — see
 * {@link searchAddress}, whose ladder this mirrors.
 */
export async function searchAddressBatch(
  queries: readonly RnQuery[],
  signal?: AbortSignal,
): Promise<BatchPool> {
  const byPlace = new Map<
    string,
    {
      country?: "HR";
      settlement: string;
      street?: string;
      parents?: string[];
      altSettlements?: string[];
      numbers: Set<number>;
      /** The group's queries as written, kept whole for the registers that
       *  answer a query at a time rather than a number list. */
      queries: RnQuery[];
    }
  >();
  for (const q of queries) {
    const key = groupKey(q);
    const g = byPlace.get(key);
    if (g) {
      g.numbers.add(q.number);
      g.queries.push(q);
    } else
      byPlace.set(key, {
        ...(q.country ? { country: q.country } : {}),
        settlement: q.settlement,
        street: q.street,
        parents: q.parents,
        // Alternates derive from the place value, so every query of the group
        // (same settlement+street+parents) carries the same list.
        altSettlements: q.altSettlements ? [...q.altSettlements] : undefined,
        numbers: new Set([q.number]),
        queries: [q],
      });
  }

  const fetchGroup = async (
    settlement: string,
    street: string | undefined,
    numbers: number[],
    anyStreet = false,
  ) => {
    const hits: RnResult[] = [];
    for (let i = 0; i < numbers.length; i += BATCH_NUMBERS) {
      const chunk = numbers.slice(i, i + BATCH_NUMBERS);
      const clauses = [`NASELJE_NAZIV=${cqlString(settlement)}`, `HS_STEVILKA IN (${chunk.join(",")})`];
      if (street) clauses.push(`ULICA_NAZIV LIKE ${cqlString(`${street}%`)}`);
      else if (!anyStreet) clauses.push("ULICA_NAZIV IS NULL");
      hits.push(...rnFeaturesToResults(await rnFetch(clauses.join(" AND "), signal, BATCH_LIMIT), Infinity));
    }
    return hits;
  };

  const pool = new Map<string, RnResult[]>();
  for (const [key, g] of byPlace) {
    // Croatia's register is in this browser: there is no request to batch, and
    // the bucket the group's first house reads is the one every other house of
    // it reads too, so asking house by house costs a single IndexedDB read.
    if (g.country === "HR") {
      const hits: RnResult[] = [];
      for (const q of g.queries) {
        for (const hit of await searchLocalAddress(g.country ?? "SI", q)) {
          if (hits.some((h) => h.coord.lat === hit.coord.lat && h.coord.lon === hit.coord.lon)) continue;
          hits.push(hit);
        }
      }
      pool.set(key, hits);
      continue;
    }
    // One group's network failure must not throw away the groups already
    // resolved — a 37-address place used to lose all 37 to one timeout. A
    // failed group is simply absent from the pool, which {@link batchAnswered}
    // reads as "ask again", never as the rows having no match.
    try {
      const numbers = [...g.numbers].sort((a, b) => a - b);
      const own = async (...args: Parameters<typeof fetchGroup>) =>
        requireParentMunicipality(await fetchGroup(...args), g.parents, signal);
      let hits = await own(g.settlement, g.street, numbers);
      if (!hits.length && !g.street) hits = await own(g.settlement, undefined, numbers, true);
      // The settlement the file names may not be the one the register files the
      // street under — walk the same alternates the per-address ladder does
      // (searchAddress), each with the same inner rungs, before guessing.
      for (const alt of g.altSettlements ?? []) {
        if (hits.length) break;
        hits = await own(alt, g.street, numbers);
        if (!hits.length && !g.street) hits = await own(alt, undefined, numbers, true);
      }
      if (!hits.length) {
        const alt = hostAsSettlement({ settlement: g.settlement, street: g.street, number: numbers[0] });
        if (alt) {
          // The guessed settlement is held to the place's own municipality, so a
          // "Klanec" that is really Komenda's cannot answer a place in Kranj.
          const guessed = async (anyStreet: boolean) =>
            requireParentMunicipality(
              await fetchGroup(alt.settlement, undefined, numbers, anyStreet),
              g.parents,
              signal,
            );
          hits = await guessed(false);
          if (!hits.length) hits = await guessed(true);
        }
      }
      pool.set(key, hits);
    } catch {
      // Absent from the pool — see above.
    }
  }
  return pool;
}

/**
 * Whether the batch actually answered every group these queries belong to. A
 * group whose fetch failed is absent from its pool, and its rows must read as
 * "try again" — with the per-row button still offering the full ladder — never
 * as "the register has no such house".
 */
export function batchAnswered(queries: readonly RnQuery[], pool: BatchPool): boolean {
  return queries.every((q) => pool.has(groupKey(q)));
}

/**
 * The batch results that answer one row: an exact number+suffix match, or — when
 * the file records a suffix the register does not — the bare number, mirroring
 * the single-address ladder's own retry.
 */
export function resultsForQuery(queries: readonly RnQuery[], pool: BatchPool): RnResult[] {
  const out: RnResult[] = [];
  for (const q of queries) {
    // Only the group this query was fetched for can answer it.
    const own = pool.get(groupKey(q)) ?? [];
    const exact = own.filter((r) => r.number === q.number && r.suffix === q.suffix);
    // A suffix the register doesn't record falls back to the bare number.
    const matches = exact.length || !q.suffix ? exact : own.filter((r) => r.number === q.number && !r.suffix);
    for (const r of matches) {
      if (!out.some((o) => o.coord.lat === r.coord.lat && o.coord.lon === r.coord.lon)) out.push(r);
    }
  }
  return out.slice(0, MAX_RESULTS);
}
