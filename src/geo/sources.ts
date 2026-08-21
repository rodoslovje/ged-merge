// Where a place directory or an address register is fetched from: one file
// naming every source the app can download, and the queries the queried ones
// take.
//
// They live apart from the code that fetches them because the fetching is one
// piece of code for all of them (geo.worker.ts) and the manager that offers
// them is another (GazetteerManager.tsx) — a source is a URL, a query and a
// credit, and nothing about how the bytes are read.

import type { Subdivision } from "./gazetteer";

/** Overpass (OpenStreetMap) endpoints — CORS-enabled, so the browser can
 *  fetch a country's places directly. geonames.org was tried first but sends
 *  no CORS headers and blocks the public relays' addresses, so the one-click
 *  path uses OSM; GeoNames stays available via the manual file import. */
export const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

/** Every place node in the area `.a`: settlements down to isolated dwellings. */
const PLACE_NODES =
  `node(area.a)[place~"^(city|town|village|hamlet|suburb|locality|isolated_dwelling)$"];out qt;`;

/** Every place in the country. */
export function countryQuery(code: string): string {
  return `[out:json][timeout:180];area["ISO3166-1"="${code}"][admin_level=2]->.a;${PLACE_NODES}`;
}

/** One subdivision's boundary relation (tags only — the marker the importer
 *  reads the division's names off) followed by its places. Overpass emits
 *  output statements in query order, so every place lands after the marker of
 *  the division it sits in. */
function subdivisionBlock(code: string): string {
  return `rel["ISO3166-2"="${code}"][boundary=administrative];out tags;area["ISO3166-2"="${code}"]->.a;${PLACE_NODES}`;
}

/** Every place in the country, grouped under its subdivisions' markers so each
 *  entry can say which county/state it sits in. Costs the server one area
 *  expansion per subdivision, so it is only used for a moderate list — a
 *  country with hundreds of ISO-coded municipalities gets the plain query. */
export function annotatedCountryQuery(subdivisions: Subdivision[]): string {
  return `[out:json][timeout:180];${subdivisions.map((s) => subdivisionBlock(s.code)).join("")}`;
}

/** Above this many subdivisions the annotated whole-country query is riskier
 *  than it is worth (Slovenia's ISO codes are its 212 municipalities) — the
 *  plain query keeps the download working, just without division labels. */
export const MAX_ANNOTATED_SUBDIVISIONS = 60;

/** Every place in one ISO 3166-2 subdivision ("US-CA"), for a country whose
 *  own area is more than the service will chew through in one query. The
 *  leading marker labels the entries the same way the annotated country
 *  query does. */
export function regionQuery(region: string): string {
  return `[out:json][timeout:180];${subdivisionBlock(region)}`;
}

/** The country's subdivisions — boundary relations, tags only, no geometry, so
 *  it answers in seconds even where the places themselves time out. */
export function subdivisionsQuery(code: string): string {
  return `[out:json][timeout:120];relation["ISO3166-2"~"^${code}-"][boundary=administrative];out tags;`;
}

/** GURS RPE settlements ("naselja") — the authoritative Slovenian register,
 *  served as GeoJSON in WGS84 with CORS open, so the browser fetches it
 *  directly. All 6035 settlements come in one response (the service ignores
 *  `properties=`, so the ~45 MB of polygons is unavoidable); the worker keeps
 *  only each polygon's centroid. Data © Geodetska uprava RS, CC BY 4.0. */
export const GURS_NASELJA_URL =
  "https://ipi.eprostor.gov.si/wfs-si-gurs-rpe/ogc/features/collections/SI.GURS.RPE:NASELJA/items?f=application%2Fgeo%2Bjson&limit=10000";

/** RPE municipalities — the id→name table the settlements join to, so a
 *  candidate can name its občina. Small next to the settlements (212 rows). */
export const GURS_OBCINE_URL =
  "https://ipi.eprostor.gov.si/wfs-si-gurs-rpe/ogc/features/collections/SI.GURS.RPE:OBCINE/items?f=application%2Fgeo%2Bjson&limit=1000";

/**
 * The populated-place feature kinds of the DGU register of geographical names,
 * by the register's own `vrstaobiljezjaid`: naselje (234), zaselak (242), selo
 * (237), dio naselja (236), gradska četvrt (233), napušteno naselje (191), the
 * farmstead group — salaš, majur, stancija (124) — and the two city kinds, grad
 * (321) and glavni grad (231).
 *
 * The register holds 128 000 names of everything a map shows, hills and springs
 * and bus stops included, and asking for the lot would download 25 MB of
 * features no place string will ever match. These nine kinds are the ones a
 * birth entry names: with the hamlets and the abandoned settlements in, and the
 * terrain out, it comes to some 24 000 places in 8 MB.
 *
 * The city kinds are here because three cities — Pula, Buje and Poreč — are
 * filed under no other one: the register has no settlement row for them at all,
 * so leaving the kind out loses them outright. The other 123 do repeat a
 * settlement of their own name, and `rgiPlacesToEntries` drops those.
 */
const DGU_PLACE_KINDS = [124, 191, 231, 233, 234, 236, 237, 242, 321];

/** The register of geographical names — Croatia's authoritative place
 *  directory, served as GeoJSON with CORS open, so the browser fetches it
 *  directly. Points, not polygons, so there is no centroid to compute.
 *  Data © Državna geodetska uprava. */
export const DGU_PLACES_URL =
  "https://rgi.dgu.hr/geoserver/wfs?service=WFS&version=2.0.0&request=GetFeature" +
  "&typeNames=rgi:v_imjesto_geoime_gs&outputFormat=application/json&srsName=EPSG:4326&count=50000" +
  "&propertyName=im_id,pisanje_imena,jeziknaziv,status_imena,og_ime,vrstaobiljezjaid,geom" +
  `&CQL_FILTER=${encodeURIComponent(`vrstaobiljezjaid IN (${DGU_PLACE_KINDS.join(",")})`)}`;

/** One RPJ administrative-unit table, asked for without its geometry — the
 *  counties are 3 KB that way and the municipalities 75 KB, against megabytes
 *  of boundary polygons nothing here would draw. */
function dguUnitsUrl(layer: string, properties: string): string {
  return (
    "https://rgi.dgu.hr/geoserver/wfs?service=WFS&version=2.0.0&request=GetFeature" +
    `&typeNames=rgi:${layer}&outputFormat=application/json&count=1000&propertyName=${properties}`
  );
}

/** The municipalities each place's `og_ime` names, with the county each belongs
 *  to, and the counties themselves — together, which county a place sits in. */
export const DGU_OPCINE_URL = dguUnitsUrl("rpj_opcina", "og_ime,zupanija_id");
export const DGU_ZUPANIJE_URL = dguUnitsUrl("rpj_zupanija", "id,naziv,rb");

/**
 * The Croatian address register, as the DGU's INSPIRE download service serves
 * it: every one of the country's 1.68 million house numbers with its
 * coordinate, refreshed weekly, CORS open so the worker can fetch it directly.
 *
 * A download and not a query because there is nothing to query: Croatia's
 * address WFS is open to Croatian public bodies only, which is what the DGU
 * answers when asked. Data © Državna geodetska uprava.
 */
export const DGU_ADDRESSES_URL = "https://geoportal.dgu.hr/services/atom/INSPIRE_Addresses_(AD).zip";
