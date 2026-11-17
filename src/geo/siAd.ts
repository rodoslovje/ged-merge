import type { AddressRow } from "./addressRegister";

// Reading the Slovenian address register (GURS) out of the real-estate cadastre
// WFS. What becomes of the rows afterwards is addressRegister.ts, which Croatia
// shares.
//
// Slovenia is the opposite case to Croatia's single zip: there is no bulk file,
// but there *is* a proper WFS — the cadastre's `NASLOVI_HS` layer, one feature
// per house number (some 580 000), CORS `*`, `startIndex` paging that genuinely
// pages, and GeoJSON output in WGS84 on request. Asked for in pages of a few
// thousand, with only the fields read below, it comes to some 20 MB over the
// wire, because the response gzips well and a browser asks for that itself.
//
// (This replaces the INSPIRE address download, `wfs-si-gurs-ins/ad/wfs`, which
// GURS took down in 2026; siAdInspire.ts still reads it, as the fallback for a
// cadastre that does not answer. The register this app queries *live* — rn.ts, the RN
// collection on the OGC API endpoint — cannot be used for this: it caps at
// 20 000 rows and silently ignores `offset`, returning the same first row
// however deep you ask. Its rows are also apartment-level, twice as many as
// there are houses.)
//
// Every name a house needs is a flat field of its own feature — municipality,
// settlement, street, post code and office — so there is nothing to join.
//
// Data: Geodetska uprava Republike Slovenije, CC BY 4.0.

/** The service and its feature type. */
export const SI_AD_WFS = "https://ipi.eprostor.gov.si/wfs-si-gurs-kn/wfs";
const SI_AD_TYPE = "SI.GURS.KN:NASLOVI_HS";

/** The fields read below — the layer carries some forty, most of them electoral
 *  and school districts, which would triple the download for nothing. */
const SI_AD_FIELDS = [
  "EID_NASELJE",
  "NASELJE_NAZIV",
  "OBCINA_NAZIV",
  "ULICA_NAZIV",
  "POSTNI_OKOLIS_SIFRA",
  "POSTNI_OKOLIS_NAZIV",
  "HS_STEVILKA",
  "HS_DODATEK",
  "GEOM",
];

/** One page of addresses. `count` per request is a trade: the service answers a
 *  5000-row page in a few seconds and ~170 KB compressed, and 117 of them cover
 *  the country. */
export const SI_AD_PAGE = 5000;

/** URL for one page of the address layer. Sorted by feature id, so that pages
 *  asked for one after another neither overlap nor skip a house. */
export function siAddressPageUrl(startIndex: number, count = SI_AD_PAGE): string {
  const params = new URLSearchParams({
    service: "WFS",
    version: "2.0.0",
    request: "GetFeature",
    typeNames: SI_AD_TYPE,
    outputFormat: "application/json",
    srsName: "EPSG:4326",
    sortBy: "FEATUREID",
    propertyName: SI_AD_FIELDS.join(","),
    count: String(count),
    startIndex: String(startIndex),
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
  /** GeoJSON order, longitude first. */
  geometry?: { coordinates?: number[] } | null;
  properties?: {
    /** Kept as a string by the service: Slovenia's ids run past the largest
     *  integer a JS number holds exactly. */
    EID_NASELJE?: string | null;
    NASELJE_NAZIV?: string | null;
    OBCINA_NAZIV?: string | null;
    /** Null for the houses a village numbers directly. */
    ULICA_NAZIV?: string | null;
    POSTNI_OKOLIS_SIFRA?: number | string | null;
    POSTNI_OKOLIS_NAZIV?: string | null;
    HS_STEVILKA?: number | string | null;
    /** The letter of "69 b"; null when there is none. */
    HS_DODATEK?: string | null;
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

/** A single letter, as the register writes a house number's extension. */
const LETTER = /^\s*([A-Za-zČĆĐŠŽčćđšž])\s*$/;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** One page of address features as rows. */
export function parseSiAddressPage(json: SiFeatureCollection): AddressRow[] {
  const out: AddressRow[] = [];
  for (const feature of json.features ?? []) {
    const p = feature.properties;
    if (!p) continue;

    const coords = feature.geometry?.coordinates;
    if (!coords || coords.length < 2) continue;
    const coord = { lat: Number(coords[1]), lon: Number(coords[0]) };
    if (!isInSlovenia(coord)) continue;

    const settlementId = text(p.EID_NASELJE);
    const settlement = text(p.NASELJE_NAZIV);
    if (!settlementId || !settlement) continue;

    const number = Number(p.HS_STEVILKA);
    if (!Number.isInteger(number) || number <= 0) continue;
    const letter = LETTER.exec(text(p.HS_DODATEK))?.[1]?.toLowerCase() ?? "";

    const municipality = text(p.OBCINA_NAZIV);
    const office = text(p.POSTNI_OKOLIS_NAZIV);
    const code = p.POSTNI_OKOLIS_SIFRA == null ? "" : String(p.POSTNI_OKOLIS_SIFRA).trim();

    out.push({
      settlementId,
      settlement,
      ...(municipality ? { municipality } : {}),
      street: text(p.ULICA_NAZIV),
      post: office ? (code ? `${code} ${office}` : office) : "",
      number,
      ext: letter,
      ext2: 0,
      lat: coord.lat,
      lon: coord.lon,
    });
  }
  return out;
}
