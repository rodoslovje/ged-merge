import type { GeoCoord } from "../gedcom/types";

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
  /** Feature type ("house", "village", …), informational. */
  kind?: string;
}

/** One raw jsonv2 row, reduced to what we read. */
interface RawResult {
  lat?: string;
  lon?: string;
  name?: string;
  display_name?: string;
  type?: string;
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
    out.push(result);
  }
  return out;
}

// One shared queue so concurrent callers still respect the 1 req/s policy.
let queueTail: Promise<unknown> = Promise.resolve();
let lastStart = 0;

/**
 * Search Nominatim for a free-text place/address string. Requests are
 * serialized and spaced ≥1 s apart; the caller gates this behind the online
 * opt-in. Rejects on network/HTTP errors.
 */
export function searchNominatim(query: string, language: string): Promise<NominatimResult[]> {
  const run = async (): Promise<NominatimResult[]> => {
    const wait = lastStart + INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastStart = Date.now();
    const url = `${ENDPOINT}?format=jsonv2&limit=5&q=${encodeURIComponent(query)}&accept-language=${encodeURIComponent(language)}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseNominatimResponse(await res.json());
  };
  const p = queueTail.then(run, run);
  queueTail = p.catch(() => undefined);
  return p;
}
