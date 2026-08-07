import type { AddressRow } from "./addressRegister";

// Reading the Slovenian address register (GURS) out of its INSPIRE download
// service. What becomes of the rows afterwards is addressRegister.ts, which
// Croatia shares.
//
// Slovenia is the opposite case to Croatia's single zip: there is no bulk file,
// but there *is* a proper INSPIRE download WFS — 575 773 addresses, CORS `*`,
// `startIndex` paging that genuinely pages, and GeoJSON output. Asked for in
// pages of a few thousand it comes to some 45 MB over the wire, because the
// response gzips about 27-fold and a browser asks for that automatically.
//
// (The register this app queries *live* — rn.ts, the RN collection on the OGC
// API endpoint — cannot be used for this: it caps at 20 000 rows and silently
// ignores `offset`, returning the same first row however deep you ask. Its rows
// are also apartment-level, 1.1 M of them for the same 575 773 houses.)
//
// Everything a house needs is on its own feature, so unlike Croatia there are no
// side tables to join — only the post codes, which the components name by post
// office but not by number.
//
// Data: Geodetska uprava Republike Slovenije, CC BY 4.0.

/** The service, its feature type, and the output format that carries every name
 *  inline. */
export const SI_AD_WFS = "https://ipi.eprostor.gov.si/wfs-si-gurs-ins/ad/wfs";

/** One page of addresses. `count` per request is a trade: the service answers a
 *  5000-row page in a couple of seconds and ~390 KB compressed, and 116 of them
 *  cover the country. */
export const SI_AD_PAGE = 5000;

/** URL for one page of the address collection. */
export function siAddressPageUrl(startIndex: number, count = SI_AD_PAGE): string {
  const params = new URLSearchParams({
    service: "WFS",
    version: "2.0.0",
    request: "GetFeature",
    typeNames: "ad:Address",
    outputFormat: "application/json",
    count: String(count),
    startIndex: String(startIndex),
  });
  return `${SI_AD_WFS}?${params}`;
}

/** URL for the post-code table — 466 rows, one request. The addresses name
 *  their post office but not its number, and "8341 Adlešiči" is how a register
 *  answer should read. */
export function siPostalUrl(): string {
  const params = new URLSearchParams({
    service: "WFS",
    version: "2.0.0",
    request: "GetFeature",
    typeNames: "ad:PostalDescriptor",
    outputFormat: "application/json",
    count: "2000",
  });
  return `${SI_AD_WFS}?${params}`;
}

/** The service's GeoJSON, as far as this module reads it. */
export interface SiFeatureCollection {
  features?: SiFeature[];
  numberMatched?: number;
  numberReturned?: number;
}

interface SiFeature {
  properties?: {
    component?: { "@href"?: string; "@title"?: string }[] | { "@href"?: string; "@title"?: string };
    description?: string;
    locator?: {
      designator?: { designator?: unknown } | { designator?: unknown }[];
    };
    position?: { geometry?: { coordinates?: number[] } | null };
    postCode?: string;
    postName?: { spelling?: unknown };
    inspireId?: { localId?: string };
  } | null;
}

/** Slovenia's bounds, widened a tenth of a degree, so a mis-read coordinate is
 *  dropped rather than stored as a house in the Adriatic. */
const SI_BOUNDS = { minLat: 45.3, maxLat: 47.0, minLon: 13.3, maxLon: 16.7 };

/** True when a coordinate plausibly lies in Slovenia. */
export function isInSlovenia(coord: { lat: number; lon: number } | undefined): boolean {
  return (
    !!coord &&
    coord.lat >= SI_BOUNDS.minLat &&
    coord.lat <= SI_BOUNDS.maxLat &&
    coord.lon >= SI_BOUNDS.minLon &&
    coord.lon <= SI_BOUNDS.maxLon
  );
}

/** `…featureid=SI.GURS.RPE.110300000100999436` — the id half, kept as a string
 *  because Slovenia's run past the largest integer a JS number holds exactly. */
const FEATURE_ID = /featureid=[^&"]*?\.(\d+)\b/;
/** Which of the five components a link is. */
const TYPE_NAMES = /typeNames=ad:(\w+)/;

/** Leading number and its optional letter, as the register writes them: "69",
 *  "69 b". One field, unlike Croatia's two designators. */
const DESIGNATOR = /^\s*(\d{1,6})\s*([A-Za-zČĆĐŠŽčćđšž])?\s*$/;

function firstOf<T>(value: T | T[] | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The post lines of the PostalDescriptor collection, by post-office name.
 *
 * Keyed by name rather than by id because that is all an address gives: its
 * `PostalDescriptor` component carries `@title` — the office — and no number.
 * A name two offices shared would be ambiguous, but Slovenia's 466 offices are
 * distinct by name, and a collision would only cost the code on the label.
 */
export function parseSiPostCodes(json: SiFeatureCollection): Map<string, string> {
  const out = new Map<string, string>();
  for (const feature of json.features ?? []) {
    const p = feature.properties;
    if (!p) continue;
    const name = spellingOf(p.postName?.spelling);
    const code = typeof p.postCode === "string" ? p.postCode.trim() : "";
    if (name && code && !out.has(name)) out.set(name, `${code} ${name}`);
  }
  return out;
}

/** The text of a GeographicalName's spelling, as this service's JSON nests it —
 *  `postName.spelling.text`. A name carrying several spellings arrives as an
 *  array; the first is the official one. */
function spellingOf(spelling: unknown): string {
  const one = firstOf(spelling as { text?: unknown } | { text?: unknown }[] | undefined);
  return typeof one?.text === "string" ? one.text.trim() : "";
}

/**
 * One page of address features as rows.
 *
 * Every name is on the feature already, in the `@title` of its five components:
 * the country, the občina, the naselje (`AddressAreaName`), the street
 * (`ThoroughfareName`, whose title is *absent* for the 58 % of houses a village
 * numbers directly) and the post office. The country is told from the občina by
 * the order the service writes them — the country first — which is the only
 * thing here that leans on order; both are `AdminUnitName`, and taking the
 * second is what the service's own `description` does too.
 *
 * `posts` supplies the code the components leave out; without it the label
 * simply names the office alone.
 */
export function parseSiAddressPage(json: SiFeatureCollection, posts?: ReadonlyMap<string, string>): AddressRow[] {
  const out: AddressRow[] = [];
  for (const feature of json.features ?? []) {
    const p = feature.properties;
    if (!p) continue;

    // Position: EPSG:4258 (ETRS89), which is WGS84 to within a metre — and
    // written in the CRS's own axis order, latitude first.
    const coords = p.position?.geometry?.coordinates;
    if (!coords || coords.length < 2) continue;
    const coord = { lat: Number(coords[0]), lon: Number(coords[1]) };
    if (!isInSlovenia(coord)) continue;

    const components = Array.isArray(p.component) ? p.component : p.component ? [p.component] : [];
    let settlementId = "";
    let settlement = "";
    let municipality = "";
    let street = "";
    let post = "";
    let adminUnits = 0;
    for (const c of components) {
      const kind = TYPE_NAMES.exec(c["@href"] ?? "")?.[1];
      const title = c["@title"]?.trim() ?? "";
      if (kind === "AddressAreaName") {
        settlement = title;
        settlementId = FEATURE_ID.exec(c["@href"] ?? "")?.[1] ?? "";
      } else if (kind === "AdminUnitName") {
        // The first is Slovenia itself; the second is the municipality.
        if (adminUnits++) municipality = title;
      } else if (kind === "ThoroughfareName") street = title;
      else if (kind === "PostalDescriptor") post = title;
    }
    if (!settlementId || !settlement) continue;

    const written = firstOf(p.locator?.designator)?.designator;
    const m = DESIGNATOR.exec(typeof written === "string" ? written : String(written ?? ""));
    if (!m) continue;
    const number = Number(m[1]);
    if (!Number.isFinite(number) || number <= 0) continue;
    const letter = m[2]?.toLowerCase() ?? "";

    out.push({
      settlementId,
      settlement,
      ...(municipality ? { municipality } : {}),
      street,
      post: post ? (posts?.get(post) ?? post) : "",
      number,
      ext: (letter.codePointAt(0) ?? 0) <= 0xffff ? letter : "",
      ext2: 0,
      lat: coord.lat,
      lon: coord.lon,
    });
  }
  return out;
}
