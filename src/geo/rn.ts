import type { GeoCoord } from "../gedcom/types";
import { countryCode } from "../gedcom/countryCode";
import { addressStreetName, decomposePlace, looksLikeStreet } from "../gedcom/place";
import { d96ToWgs84 } from "./d96";

// RN — the GURS register of addresses (Register naslovov) — is the official
// Slovenian address gazetteer: every house number in the country with its exact
// coordinate. It serves CORS `*`, so the browser queries it directly (no relay),
// and it is opt-in behind the same online-lookups setting as the Nominatim and
// GOV searches.
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

/** A CQL string literal — single quotes double up. */
function cqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const sameName = (a: string | undefined, b: string | undefined): boolean =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

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
 * Returns one query per house number the value names — several when the numbering
 * changed over time ("21a / 53"), so every candidate house can be offered. Empty
 * when there is no house number to look up, when no settlement can be identified
 * (a bare "Slovenska cesta 9" names no town), or when either value names a country
 * other than Slovenia — the register covers only Slovenia, so querying it would be
 * pointless traffic.
 */
export function rnQueriesFrom(place: string | undefined, address: string | undefined): RnQuery[] {
  const p = place?.trim() ? decomposePlace(place) : undefined;
  const a = address?.trim() ? decomposePlace(address) : undefined;

  // A country either side names must be Slovenia; an unnamed country is fine
  // (most files leave it implicit) and still worth trying.
  for (const country of [p?.country, a?.country]) {
    if (country && countryCode(country)?.toUpperCase() !== "SI") return [];
  }

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
  const candidates = [...(p?.jurisdiction ?? []), a?.locality]
    .map((s) => s?.trim())
    .filter((s): s is string => !!s)
    .filter((s) => !sameName(s, p?.country) && !sameName(s, a?.country) && !looksLikeStreet(s));
  if (!candidates.length) return [];

  // A host that isn't the most specific place named is the street; when it *is*
  // that place this is village numbering and the register wants no street at all.
  const street = host && !sameName(host, candidates[0]) ? host : undefined;

  // Drop the street from the settlement candidates. Identity, not vocabulary:
  // "Hafnarjeva pot" is a street but carries none of the words looksLikeStreet
  // knows, and left in it would become a bogus NASELJE_NAZIV='Hafnarjeva pot'.
  const [settlement, ...altSettlements] = street ? candidates.filter((s) => !sameName(s, street)) : candidates;
  if (!settlement) return [];
  return numbers.map((n) => ({
    settlement,
    ...(street ? { street } : {}),
    ...n,
    ...(altSettlements.length ? { altSettlements } : {}),
  }));
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
export function rnFeaturesToResults(data: RnFeatureCollection): RnResult[] {
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
    const result: RnResult = { coord, address, label: parts.join(", "), settlement };
    if (post) result.post = post;
    byCoord.set(key, result);
  }
  return [...byCoord.values()].slice(0, MAX_RESULTS);
}

// One shared queue so concurrent rows still space their requests out.
let queueTail: Promise<unknown> = Promise.resolve();
let lastStart = 0;

/** Run one throttled register request and return the parsed response. */
function rnFetch(filter: string, signal?: AbortSignal): Promise<RnFeatureCollection> {
  const run = async (): Promise<RnFeatureCollection> => {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    const wait = lastStart + INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastStart = Date.now();
    const url =
      `${ENDPOINT}?f=${encodeURIComponent("application/geo+json")}` +
      `&filter-lang=cql-text&limit=${FETCH_LIMIT}&filter=${encodeURIComponent(filter)}`;
    const res = await fetch(url, signal ? { signal } : {});
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as RnFeatureCollection;
  };
  const p = queueTail.then(run, run);
  queueTail = p.catch(() => undefined);
  return p;
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
 * Resolves to [] when nothing matches at all — including a settlement spelled
 * differently from the register (it matches case- and diacritic-sensitively),
 * which the review UI shows as "no match" so the row can fall back to a
 * manual pick.
 */
export async function searchAddress(query: RnQuery, signal?: AbortSignal): Promise<RnResult[]> {
  for (const settlement of [query.settlement, ...(query.altSettlements ?? [])]) {
    const hits = await searchInSettlement({ ...query, settlement }, signal);
    if (hits.length) return hits;
  }
  return [];
}

/** The widening ladder within one settlement. */
async function searchInSettlement(query: RnQuery, signal?: AbortSignal): Promise<RnResult[]> {
  const exact = rnFeaturesToResults(await rnFetch(buildRnFilter(query), signal));
  if (exact.length) return exact;

  if (query.suffix) {
    const { suffix: _suffix, ...bare } = query;
    const noSuffix = rnFeaturesToResults(await rnFetch(buildRnFilter(bare), signal));
    if (noSuffix.length) return noSuffix;
  }

  if (!query.street) {
    return rnFeaturesToResults(await rnFetch(buildRnFilter(query, { anyStreet: true }), signal));
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
  for (const query of queries) {
    for (const hit of await searchAddress(query, signal)) {
      if (merged.some((m) => m.coord.lat === hit.coord.lat && m.coord.lon === hit.coord.lon)) continue;
      merged.push(hit);
    }
  }
  return merged;
}
