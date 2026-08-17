import { createThrottledQueue, geoFetch } from "./net";
import type { GeoCoord } from "../gedcom/types";
import type { Translate } from "../locales/i18n";
import { foldSearch } from "../ui/globalSearch";

// Nominatim (nominatim.openstreetmap.org) free-text place/address search —
// the online fallback for strings the offline gazetteer can't resolve,
// especially street addresses. Opt-in (the query text leaves the device) and
// throttled to the service's published policy of one request per second;
// data © OpenStreetMap contributors (ODbL).

const ENDPOINT = "https://nominatim.openstreetmap.org/search";

/** Minimum spacing between request starts (the policy is 1 req/s). */
const INTERVAL_MS = 1100;

export interface NominatimResult {
  coord: GeoCoord;
  /** Short pick label (the feature's own name, or the display name's head). */
  name: string;
  /** Full display line ("Cesta 1, Kranj, Slovenija…"). */
  label: string;
  /** The place this one sits in — the display line's next level up. Shown
   *  beside the name the way the register's občina and GOV's parent are, so a
   *  row says which of several same-named places it is without spelling out the
   *  whole chain (the full line stays in the row's tooltip). */
  admin?: string;
  /** Feature type ("house", "village", "residential", …). */
  kind?: string;
  /** The feature's class ("place", "highway", "building", …). Kept with
   *  {@link kind}, which only means something beside it: `residential` is a
   *  street under `highway` and a whole quarter under `landuse`. */
  category?: string;
  /**
   * The row's structured address, when the service returned one. The display
   * line alone cannot be read as a place: it mixes postcodes, roads and
   * administrative units of every rank in one comma chain, and which segment is
   * which differs per country. These named parts are what lets a hit become a
   * place (and, for a house, an address) rather than a coordinate with a label.
   */
  parts?: {
    /** House number ("21", "38a"). */
    house?: string;
    /** Street name, absent where a village numbers its houses directly. */
    road?: string;
    /** The settlement itself (village/town/city/suburb). */
    locality?: string;
    /** The nearest administrative parent — municipality, else county/state. */
    admin?: string;
    /**
     * Every administrative parent the row names, smallest first (municipality,
     * county, state) — {@link admin} is the first of these. Present only when
     * there is more than one, i.e. when {@link admin} alone would lose a level:
     * a US row names both its county and its state, and a file that writes
     * "place, county, state, country" needs them both.
     */
    admins?: string[];
    /** Country name, in the language the search asked for. */
    country?: string;
  };
}

/** One raw jsonv2 row, reduced to what we read. */
interface RawResult {
  lat?: string;
  lon?: string;
  name?: string;
  display_name?: string;
  type?: string;
  category?: string;
  address?: Record<string, string | undefined>;
}

/** `{key: value}` when the value is set, nothing when it isn't — so absent
 *  parts stay absent instead of becoming explicit undefined. */
function opt(key: string, value: string | undefined): Record<string, string> {
  return value ? { [key]: value } : {};
}

/** First of these keys the row's address carries. */
function pick(address: Record<string, string | undefined>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = address[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** Every one of these keys the row's address carries, in order, with fold-equal
 *  repeats collapsed (a municipality spelt like its county is one level). */
function pickAll(address: Record<string, string | undefined>, keys: string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const value = address[key]?.trim();
    if (!value) continue;
    const folded = foldSearch(value);
    if (!out.some((v) => foldSearch(v) === folded)) out.push(value);
  }
  return out;
}

/** Pure mapping of a jsonv2 response body to results (exported for tests). */
export function parseNominatimResponse(data: unknown): NominatimResult[] {
  if (!Array.isArray(data)) return [];
  const out: NominatimResult[] = [];
  for (const row of data as RawResult[]) {
    const lat = Number(row.lat);
    const lon = Number(row.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const label = row.display_name?.trim() ?? "";
    const name = row.name?.trim() || label.split(",")[0].trim();
    if (!name) continue;
    const result: NominatimResult = { coord: { lat, lon }, name, label: label || name };
    if (row.type) result.kind = row.type;
    if (row.category) result.category = row.category;
    if (row.address) {
      const admins = pickAll(row.address, ["municipality", "county", "state"]);
      const parts = {
        ...opt("house", pick(row.address, ["house_number"])),
        ...opt("road", pick(row.address, ["road", "pedestrian", "footway"])),
        // Outward from the smallest: a hamlet is the place a house belongs to,
        // and the town it is administered from comes next, not instead.
        ...opt("locality", pick(row.address, ["hamlet", "village", "suburb", "town", "city", "municipality"])),
        ...opt("admin", admins[0]),
        ...opt("country", pick(row.address, ["country"])),
        ...(admins.length > 1 ? { admins } : {}),
      };
      if (Object.keys(parts).length) result.parts = parts;
    }
    // The place this one sits in, for the slot the UI shows beside the name the
    // way the registers' občina is shown. The structured parts are the real
    // jurisdiction; the display line's second segment is only a fallback — for
    // a house it is the *street* ("38, Kidričeva cesta, Kranj, …"), which is
    // not an administrative parent.
    const parent = result.parts?.admin ?? label.split(",")[1]?.trim();
    if (parent && parent !== name) result.admin = parent;
    out.push(result);
  }
  return out;
}

/**
 * What a hit actually *is*, in a word or two — "suburb", "residential street",
 * "service road" — for the lists that show several results under one name.
 *
 * OpenStreetMap answers a village name with the place itself, the street named
 * after it, and every service road off that street, and their display lines are
 * word for word identical ("Huje, Kranj, 4000, Slovenija" three times over).
 * The class and type are what tell them apart, so they are printed beside the
 * line rather than kept in the object unread.
 *
 * Translated where the pair is one this file's readers actually meet, and left
 * in OpenStreetMap's own English word otherwise — an untranslated "quarry" says
 * more than nothing at all.
 */
export function osmKindLabel(result: NominatimResult, t: Translate): string {
  const kind = result.kind?.trim();
  if (!kind) return "";
  const words = kind.replace(/_/g, " ");
  const raw = result.category === "highway" ? `${words} road` : words;
  return result.category
    ? t(`osm.kind.${result.category}.${kind}`, { defaultValue: t(`osm.kind.${kind}`, { defaultValue: raw }) })
    : t(`osm.kind.${kind}`, { defaultValue: raw });
}

/**
 * A short readable line for a hit — its name and the parts that place it
 * (street with house number, settlement, municipality, country) — instead of
 * the raw display line, which interleaves city quarters, administrative units
 * and postcodes ("Sv. Jakob, Stanežiče, Gunclje, Četrtna skupnost Šentvid,
 * Stanežiče, Ljubljana, Upravna Enota Ljubljana, 1210, Slovenia"). Repeated
 * segments collapse (fold-blind), so the municipality spelt like its city
 * appears once. Where the service returned no structured parts — or too few to
 * beat the display line — that line stands, since it is all there is.
 */
export function osmShortLabel(result: NominatimResult): string {
  const p = result.parts;
  if (!p) return result.label;
  const segs: string[] = [];
  const push = (value?: string) => {
    if (!value) return;
    const folded = foldSearch(value);
    if (!segs.some((s) => foldSearch(s) === folded)) segs.push(value);
  };
  // A house hit's own name is often just its number, which the road segment
  // below already carries.
  if (result.name !== p.house) push(result.name);
  if (p.road) push([p.road, p.house].filter(Boolean).join(" "));
  push(p.locality);
  push(p.admin);
  push(p.country);
  return segs.length > 1 ? segs.join(", ") : result.label;
}

/**
 * Whether a hit actually names the thing that was asked for.
 *
 * Nominatim answers a free-text address it cannot place with whatever else
 * carries part of it: "Čirče 5, Kranj" comes back as "5, Breg ob Savi,
 * Drulovka, Mavčiče, Kranj" — house number 5 of a different village, with not a
 * word of Čirče in it. The name asked for has to appear somewhere in the answer,
 * or the answer is about somewhere else.
 *
 * Compared fold-blind against the display line and the named parts, so
 * "Stražišče" matches whether it comes back as the road, the suburb or a
 * segment of the chain.
 */
export function osmNamesPlace(result: NominatimResult, name: string): boolean {
  const want = foldSearch(name).trim();
  if (!want) return true;
  const haystack = [result.label, result.name, result.parts?.road, result.parts?.locality, result.parts?.admin]
    .filter(Boolean)
    .map((s) => foldSearch(s!))
    .join(" | ");
  return haystack.includes(want);
}

// One shared queue so concurrent callers still respect the 1 req/s policy.
const enqueue = createThrottledQueue(INTERVAL_MS);

/**
 * Search Nominatim for a free-text place/address string. Requests are
 * serialized and spaced ≥1 s apart; the caller gates this behind the online
 * opt-in. Rejects on network/HTTP errors.
 */
export function searchNominatim(query: string, language: string, signal?: AbortSignal): Promise<NominatimResult[]> {
  return enqueue(async () => {
    // addressdetails: the named parts a hit needs to become a place or an
    // address, rather than only the coordinate its display line carries.
    const url = `${ENDPOINT}?format=jsonv2&addressdetails=1&limit=5&q=${encodeURIComponent(query)}&accept-language=${encodeURIComponent(language)}`;
    const res = await geoFetch(url, { headers: { Accept: "application/json" } }, signal);
    return parseNominatimResponse(await res.json());
  }, signal);
}
