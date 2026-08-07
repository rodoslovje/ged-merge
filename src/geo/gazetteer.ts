import { foldToken, jaroWinkler } from "../match/text";
import { countryCode } from "../gedcom/countryCode";
import { decomposePlace } from "../gedcom/place";

// Offline gazetteer built from user-imported GeoNames country extracts
// (download.geonames.org/export/dump — CC-BY). Pure data + matching; the
// import worker parses files into GazEntry[], src/persist/geoDb.ts stores
// them, and the Geocode tool matches the file's place strings against the
// index built here.

/** One gazetteer place, reduced from a GeoNames row to what matching needs. */
export interface GazEntry {
  /** Primary (local) name, e.g. "Škofja Loka". */
  name: string;
  /** ASCII form, e.g. "Skofja Loka". */
  ascii: string;
  /** Alternate names (exonyms, historical names), possibly empty. */
  alt: string[];
  lat: number;
  lon: number;
  /** GeoNames feature class: P = populated place, A = admin division. */
  fclass: string;
  /** ISO-3166 alpha-2 country code. */
  country: string;
  /** Admin1 code (region), informational only. */
  admin1: string;
  /** GeoNames feature code, kept for admin divisions only ("ADM1", "ADM2", …)
   *  — what lets {@link attachAdmin1Names} find the region rows among the
   *  A-class entries. Absent for settlements and non-GeoNames sources. */
  fcode?: string;
  /** The administrative parent the source register names — for GURS, the
   *  občina. Purely for telling same-named settlements apart: Slovenia has a
   *  Soteska in Kamnik and another in Dolenjske Toplice, and the name alone
   *  matches both perfectly. Absent for sources that carry no such field. */
  admin?: string;
  population: number;
  /** Storage code of the official national register this entry came from, e.g.
   *  {@link GURS_REGISTER}; absent for crowd-sourced or aggregated gazetteers
   *  (OpenStreetMap, GeoNames). Its presence marks the entry as authoritative,
   *  which breaks score ties so the official coordinate wins when two loaded
   *  gazetteers describe the same settlement; the code itself labels the
   *  candidate in the UI, since `country` stays a plain ISO code for matching. */
  register?: string;
  /** Storage code of the directory the entry came from ("HR-OSM") when that
   *  differs from both `register` and the bare country code — display only, so
   *  a candidate's badge can say which directory answered. Unlike `register`
   *  it carries no authority and never affects ranking. Filled at load time by
   *  {@link storedEntries}, not persisted. */
  source?: string;
}

/** Storage key of the GURS settlements import — deliberately not a bare ISO
 *  code, so it coexists with a GeoNames/OpenStreetMap "SI" gazetteer. */
export const GURS_REGISTER = "SI-GURS";

/**
 * Storage key of an OpenStreetMap country download, e.g. "SI-OSM". Named after
 * its source for the same two reasons GURS is: the list says where each
 * directory came from, and a download no longer overwrites the GeoNames import
 * of the same country — the two describe it differently and are worth holding
 * together. A bare ISO code therefore means "GeoNames file", which is the only
 * import that cannot name its own source.
 */
export function osmRegister(country: string): string {
  return `${country.toUpperCase()}-OSM`;
}

/** Feature classes worth importing: settlements and admin divisions. */
const KEEP_CLASSES = new Set(["P", "A"]);

/**
 * Parse one GeoNames dump line (19 tab-separated columns). Returns undefined
 * for rows that aren't useful gazetteer entries (other feature classes,
 * malformed rows).
 */
export function parseGeoNamesLine(line: string): GazEntry | undefined {
  const cols = line.split("\t");
  if (cols.length < 15) return undefined;
  const fclass = cols[6];
  if (!KEEP_CLASSES.has(fclass)) return undefined;
  const lat = Number(cols[4]);
  const lon = Number(cols[5]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
  const name = cols[1].trim();
  if (!name) return undefined;
  const ascii = cols[2].trim();
  const entry: GazEntry = {
    name,
    ascii: ascii && ascii !== name ? ascii : "",
    alt: cols[3] ? cols[3].split(",").map((s) => s.trim()).filter(Boolean) : [],
    lat,
    lon,
    fclass,
    country: cols[8],
    admin1: cols[10] ?? "",
    population: Number(cols[14]) || 0,
  };
  if (fclass === "A" && cols[7]) entry.fcode = cols[7];
  return entry;
}

/**
 * Every name a division goes by, keyed by admin1 code — the primary (local)
 * name first, then ASCII and alternate forms ("Požeško-Slavonska Županija",
 * "Pozesko-Slavonska Zupanija", "Požega-Slavonia", …). Stored per country next
 * to its entries so {@link lookupPlace} can recognize the division under
 * whatever spelling the file's place strings use.
 */
export type DivisionNames = Record<string, string[]>;

/**
 * Fill each entry's `admin` display name from the country's own ADM1 rows: a
 * GeoNames extract carries its first-level divisions (Croatian županije,
 * Austrian Bundesländer, …) as A-class entries whose `admin1` code the
 * populated places reference. Resolving the code to the division's name gives
 * foreign entries the same "(parent)" label — and the same same-named-places
 * disambiguation in {@link lookupPlace} — that GURS entries get from the
 * občina. Runs over one country's entries (admin1 codes collide across
 * countries); mutates in place at import time so the join is stored. Returns
 * the divisions' full name lists for the country record.
 */
export function attachAdmin1Names(entries: GazEntry[]): DivisionNames {
  const divisions: DivisionNames = {};
  for (const e of entries) {
    if (e.fcode !== "ADM1" || !e.admin1) continue;
    divisions[e.admin1] = [e.name, ...(e.ascii ? [e.ascii] : []), ...e.alt];
  }
  for (const e of entries) {
    if (e.admin) continue;
    const name = e.admin1 ? divisions[e.admin1]?.[0] : undefined;
    // A parent repeating the place's own name says nothing (the division named
    // after its seat — and the division row itself), so it is left off.
    if (name && foldToken(name) !== foldToken(e.name)) e.admin = name;
  }
  return divisions;
}

/** Overpass (OpenStreetMap) JSON response, reduced to what we read. */
export interface OverpassJson {
  elements?: { lat?: number; lon?: number; tags?: Record<string, string> }[];
  /** How Overpass reports a *failed* query: HTTP 200, a well-formed body, an
   *  empty `elements`, and the reason in here. See {@link overpassFailure}. */
  remark?: string;
}

/**
 * Whether an Overpass response that arrived with HTTP 200 is in fact a failure,
 * and of which kind. Overpass never answers a query it could not finish with an
 * error status: a timeout comes back as valid JSON with an empty `elements` and
 * a `remark`, and an overloaded dispatcher as a short HTML page. Taken at face
 * value both import as "a country with no places", so both are checked here.
 *
 * `text` may be the tail of the body rather than the whole of it — the remark is
 * emitted after the elements — which is why the HTML case is recognized by the
 * error wording and not by a leading `<`.
 *
 * - `"timeout"` — the query was more than the service's time or memory budget.
 *   The country needs splitting into regions; retrying it whole will not help.
 * - `"busy"` — the service is loaded right now. Another endpoint, or another
 *   minute, will do.
 *
 * The two are told apart by wording, not by the word "timeout": an overloaded
 * dispatcher reports itself as `request_read_and_idx::timeout`, which is a
 * queue that gave up, not a query that was too big. Only Overpass's own
 * "Query timed out" (and its out-of-memory sibling) means the area is too large.
 */
export function overpassFailure(text: string): "timeout" | "busy" | undefined {
  const remark = /"remark"\s*:\s*"([^"]*)"/.exec(text)?.[1];
  const message = remark ?? (/<strong[^>]*>Error<\/strong>:([^<]*)/.exec(text)?.[1] ?? "");
  if (!message) return undefined;
  if (/timed out|out of memory/i.test(message)) return "timeout";
  return "busy";
}

/** One ISO 3166-2 subdivision of a country — a US state, a Canadian province,
 *  a German Bundesland — as offered when the whole country is too large for one
 *  Overpass query. `code` is the full ISO code ("US-CA"), which is what the
 *  area query takes. */
export interface Subdivision {
  code: string;
  name: string;
}

/** Tags of the boundary relations an ISO3166-2 lookup returns. */
interface SubdivisionJson {
  elements?: { tags?: Record<string, string> }[];
}

/**
 * The subdivisions of one country, from a `relation["ISO3166-2"~"^XX-"]` query.
 *
 * Only the coarsest level present is kept: several countries tag ISO codes at
 * two depths (France has regions *and* departments), and the point of the list
 * is the fewest downloads that still fit — so the larger units win. Names come
 * from the relation's own `name`, the local official one, because that is the
 * spelling a place in the file is written with; `int_name` fills in for a
 * country whose script the reader cannot search in.
 */
export function overpassSubdivisions(data: unknown, country: string): Subdivision[] {
  const prefix = `${country.toUpperCase()}-`;
  const rows: { code: string; name: string; level: number }[] = [];
  for (const el of (data as SubdivisionJson).elements ?? []) {
    const code = el.tags?.["ISO3166-2"]?.trim();
    const name = el.tags?.name?.trim() || el.tags?.int_name?.trim();
    if (!code || !name || !code.toUpperCase().startsWith(prefix)) continue;
    const level = Number(el.tags?.admin_level) || 99;
    if (!rows.some((r) => r.code === code)) rows.push({ code: code.toUpperCase(), name, level });
  }
  if (!rows.length) return [];
  const coarsest = Math.min(...rows.map((r) => r.level));
  return rows
    .filter((r) => r.level === coarsest)
    .map(({ code, name }) => ({ code, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The part of an ISO 3166-2 code after the country, e.g. "CA" of "US-CA" —
 *  stored as each entry's `admin1`, the same slot a GeoNames row puts its
 *  admin-1 code in. It is what lets a re-downloaded region replace its own
 *  entries in the country's directory and leave the other regions alone. */
export function subdivisionAdmin1(code: string): string {
  return code.slice(code.indexOf("-") + 1).toUpperCase();
}

/** OSM name tags worth keeping as alternate names (exonyms, historical). */
const OSM_ALT_TAGS = ["alt_name", "old_name", "loc_name", "name:de", "name:it", "name:hu", "name:en", "name:sl", "name:hr"];

/** Name tags a subdivision marker relation contributes to its division's name
 *  list — the local name first, then the international and neighbour-language
 *  forms a file might spell it in. */
const DIVISION_NAME_TAGS = ["name", "int_name", "name:en", ...OSM_ALT_TAGS];

/** All values of `tags` under `keys`, ;-split, deduplicated, order kept. */
function collectNames(tags: Record<string, string>, keys: string[]): string[] {
  const names: string[] = [];
  for (const tag of keys) {
    for (const part of (tags[tag] ?? "").split(";")) {
      const s = part.trim();
      if (s && !names.includes(s)) names.push(s);
    }
  }
  return names;
}

/**
 * Convert an Overpass place query result (nodes tagged `place=*` in one
 * country) into gazetteer entries — the direct-download alternative to a
 * GeoNames file. Data © OpenStreetMap contributors (ODbL).
 *
 * The download queries interleave each ISO 3166-2 subdivision's boundary
 * relation (tags only, no coordinate) before that subdivision's places, and
 * Overpass emits output statements in query order — so an element without a
 * coordinate but with an `ISO3166-2` tag is a marker: the places after it sit
 * in that division, and each takes its name as `admin` and its code as
 * `admin1`. A response without markers (an older query shape) falls back to
 * the `admin1` argument and no labels, nothing more.
 */
export function overpassToEntries(
  data: OverpassJson,
  country: string,
  admin1 = "",
): { entries: GazEntry[]; divisions: DivisionNames } {
  const entries: GazEntry[] = [];
  const divisions: DivisionNames = {};
  let markerAdmin1 = "";
  let markerName = "";
  for (const el of data.elements ?? []) {
    const name = el.tags?.name?.trim();
    if (el.lat === undefined || el.lon === undefined) {
      const iso = el.tags?.["ISO3166-2"]?.trim();
      if (iso && name) {
        markerAdmin1 = subdivisionAdmin1(iso);
        markerName = name;
        divisions[markerAdmin1] = collectNames(el.tags!, DIVISION_NAME_TAGS);
      }
      continue;
    }
    if (!name) continue;
    const alt: string[] = [];
    for (const tag of OSM_ALT_TAGS) {
      const v = el.tags?.[tag];
      if (!v) continue;
      for (const part of v.split(";")) {
        const s = part.trim();
        if (s && s !== name && !alt.includes(s)) alt.push(s);
      }
    }
    entries.push({
      name,
      ascii: "",
      alt,
      lat: el.lat,
      lon: el.lon,
      fclass: "P",
      country,
      admin1: markerAdmin1 || admin1,
      population: Number(el.tags?.population) || 0,
      // Same rule as the other sources: a parent repeating the place's own
      // name says nothing, so it is left off.
      ...(markerName && foldToken(markerName) !== foldToken(name) ? { admin: markerName } : {}),
    });
  }
  return { entries, divisions };
}

/** GeoJSON from the GURS RPE "NASELJA" (settlements) collection, reduced to
 *  what we read. Geometry arrives already in WGS84 (CRS84), so no projection
 *  step is needed — unlike the RN address register, whose features carry no
 *  geometry at all and expose D96/TM easting/northing as properties. */
export interface RpeNaseljaJson {
  features?: {
    properties?: { NAZIV?: unknown; NAZIV_DJ?: unknown; EID_OBCINA?: unknown } | null;
    geometry?: { type?: unknown; coordinates?: unknown } | null;
  }[];
}

/** The RPE municipalities collection — the id→name table `NASELJA` joins to.
 *  Its own geometry is ignored; only the two properties matter. */
export interface RpeObcineJson {
  features?: { properties?: { EID_OBCINA?: unknown; NAZIV?: unknown } | null }[];
}

/** `EID_OBCINA` → municipality name, for {@link rpeNaseljaToEntries} to join on. */
export function rpeObcinaNames(data: RpeObcineJson): Map<string, string> {
  const names = new Map<string, string>();
  for (const feature of data.features ?? []) {
    const id = feature.properties?.EID_OBCINA;
    const name = feature.properties?.NAZIV;
    if (typeof id === "string" && typeof name === "string" && name.trim()) names.set(id, name.trim());
  }
  return names;
}

/** A closed lon/lat ring. */
type Ring = [number, number][];

/** Read one GeoJSON ring, rejecting anything that isn't a list of finite
 *  lon/lat pairs (the payload is untyped JSON off the network). */
function toRing(value: unknown): Ring | undefined {
  if (!Array.isArray(value) || value.length < 3) return undefined;
  const ring: Ring = [];
  for (const point of value) {
    if (!Array.isArray(point) || point.length < 2) return undefined;
    const lon = Number(point[0]);
    const lat = Number(point[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return undefined;
    ring.push([lon, lat]);
  }
  return ring;
}

/**
 * Area-weighted centroid of one ring, plus its unsigned area — the area is
 * what picks the main body of a multi-part settlement. A vertex mean would
 * drift towards whichever edge happens to carry more points, so use the
 * shoelace centroid.
 */
function ringCentroid(ring: Ring): { lat: number; lon: number; area: number } {
  let twiceArea = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x1, y1] = ring[j];
    const [x2, y2] = ring[i];
    const cross = x1 * y2 - x2 * y1;
    twiceArea += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  // A degenerate ring (zero area: collinear or repeated points) would divide
  // by zero — fall back to the vertex mean so the settlement is still placed.
  if (twiceArea === 0) {
    const n = ring.length;
    let sx = 0;
    let sy = 0;
    for (const [x, y] of ring) {
      sx += x;
      sy += y;
    }
    return { lon: sx / n, lat: sy / n, area: 0 };
  }
  return { lon: cx / (3 * twiceArea), lat: cy / (3 * twiceArea), area: Math.abs(twiceArea / 2) };
}

/** Outer ring of the largest part: `coordinates[0]` for a Polygon, and for a
 *  MultiPolygon the part with the biggest outer ring. Holes are ignored — the
 *  outer ring alone is what a settlement's label point follows. */
function outerRings(type: unknown, coordinates: unknown): Ring[] {
  if (!Array.isArray(coordinates)) return [];
  if (type === "Polygon") {
    const ring = toRing(coordinates[0]);
    return ring ? [ring] : [];
  }
  if (type === "MultiPolygon") {
    const rings: Ring[] = [];
    for (const part of coordinates) {
      if (!Array.isArray(part)) continue;
      const ring = toRing(part[0]);
      if (ring) rings.push(ring);
    }
    return rings;
  }
  return [];
}

/**
 * Convert the GURS RPE settlements collection into gazetteer entries — the
 * authoritative Slovenian alternative to a GeoNames extract or an Overpass
 * download. Each settlement polygon is reduced to its centroid; the bilingual
 * (Italian / Hungarian) `NAZIV_DJ` name becomes an alternate name so the
 * Italian and Hungarian forms in older records still match.
 *
 * Data: Geodetska uprava Republike Slovenije, CC BY 4.0.
 */
export function rpeNaseljaToEntries(data: RpeNaseljaJson, obcine?: ReadonlyMap<string, string>): GazEntry[] {
  const entries: GazEntry[] = [];
  for (const feature of data.features ?? []) {
    const name = typeof feature.properties?.NAZIV === "string" ? feature.properties.NAZIV.trim() : "";
    if (!name) continue;
    const rings = outerRings(feature.geometry?.type, feature.geometry?.coordinates);
    if (!rings.length) continue;
    let best = ringCentroid(rings[0]);
    for (let i = 1; i < rings.length; i++) {
      const c = ringCentroid(rings[i]);
      if (c.area > best.area) best = c;
    }
    const bilingual = typeof feature.properties?.NAZIV_DJ === "string" ? feature.properties.NAZIV_DJ.trim() : "";
    const obcinaId = feature.properties?.EID_OBCINA;
    const admin = typeof obcinaId === "string" ? obcine?.get(obcinaId) : undefined;
    entries.push({
      name,
      ascii: "",
      alt: bilingual && bilingual !== name ? [bilingual] : [],
      lat: best.lat,
      lon: best.lon,
      fclass: "P",
      country: "SI",
      admin1: "",
      population: 0,
      register: GURS_REGISTER,
      ...(admin ? { admin } : {}),
    });
  }
  return entries;
}

/** Storage key of the Croatian DGU import — the same shape and the same reason
 *  as {@link GURS_REGISTER}: it sits alongside a GeoNames or OpenStreetMap "HR"
 *  directory instead of replacing it. */
export const DGU_REGISTER = "HR-DGU";

/**
 * GeoJSON from the DGU Register of Geographical Names (`v_imjesto_geoime_gs`),
 * reduced to what we read. Unlike the Slovenian RPE collection this one is
 * points, so there is no centroid to compute — but it is a register of *names*,
 * not of places, so a place that goes by several of them arrives as several
 * features sharing an `im_id`.
 */
export interface RgiPlacesJson {
  features?: {
    properties?: {
      im_id?: unknown;
      pisanje_imena?: unknown;
      jeziknaziv?: unknown;
      status_imena?: unknown;
      og_ime?: unknown;
      vrstaobiljezjaid?: unknown;
    } | null;
    geometry?: { type?: unknown; coordinates?: unknown } | null;
  }[];
}

/** The register's feature kinds for a city — `grad (jls)` and `glavni grad`.
 *  A city is a local-government unit as much as a place, so the register files
 *  one at its administrative label point and, separately, as the settlement of
 *  the same name; see {@link CITY_DUPLICATE_DEG}. */
const RGI_CITY_KINDS = new Set([321, 231]);

/**
 * How far apart a city and the settlement of its own name may sit and still be
 * the one place. The register pins the city at its own label point, which for
 * Samobor is 5 km from the settlement's and for Senj 12 km — while the nearest
 * genuine namesake pair (the city of Otok and the villages called Otok) is 200
 * km apart. Anything inside this is the same place written twice, and the city
 * copy is dropped; anything beyond is two places.
 *
 * Wider than {@link DUPLICATE_DEG}, which collapses twins at *lookup* time
 * across whole directories, and cannot be widened to suit this: 20 km there
 * would swallow genuinely distinct neighbouring villages.
 */
const CITY_DUPLICATE_DEG = 0.2;

/** The RPJ municipalities table (`rpj_opcina`), fetched without geometry: the
 *  name each place's `og_ime` carries, and the county it belongs to. */
export interface RgiOpcineJson {
  features?: { properties?: { og_ime?: unknown; zupanija_id?: unknown } | null }[];
}

/** The RPJ counties table (`rpj_zupanija`), fetched without geometry. `rb` is
 *  the county's official number, which is also the ISO 3166-2 code's digits —
 *  HR-08 is `rb` 8, Primorsko-goranska. */
export interface RgiZupanijeJson {
  features?: { properties?: { id?: unknown; naziv?: unknown; rb?: unknown } | null }[];
}

/**
 * What each Croatian county goes by besides its official Croatian name, which
 * the register supplies itself. English forms are here because a GEDCOM written
 * in English names the county in English — "Ravna Gora, Primorje-Gorski Kotar,
 * Croatia" — and the register has no idea what that is; both the bare form and
 * the "… County" one are listed because files use either. Keyed by the county's
 * ISO 3166-2 digits, which is also what a GeoNames or OpenStreetMap import of
 * Croatia stores, so the two directories' name lists pool.
 *
 * Croatia's counties were drawn in 1992 and have not moved since, so this is a
 * fixed table rather than something to fetch.
 */
const HR_COUNTY_ALIASES: Record<string, string[]> = {
  // Never a bare "Zagreb" for this one: written alone, Zagreb is the city — the
  // separate county 21 — and claiming it here would corroborate both.
  "01": ["Zagreb County"],
  "02": ["Krapina-Zagorje", "Krapina-Zagorje County"],
  "03": ["Sisak-Moslavina", "Sisak-Moslavina County"],
  "04": ["Karlovac", "Karlovac County"],
  "05": ["Varaždin", "Varaždin County"],
  "06": ["Koprivnica-Križevci", "Koprivnica-Križevci County"],
  "07": ["Bjelovar-Bilogora", "Bjelovar-Bilogora County"],
  "08": ["Primorje-Gorski Kotar", "Primorje-Gorski Kotar County"],
  "09": ["Lika-Senj", "Lika-Senj County"],
  "10": ["Virovitica-Podravina", "Virovitica-Podravina County"],
  "11": ["Požega-Slavonia", "Požega-Slavonia County"],
  "12": ["Brod-Posavina", "Brod-Posavina County"],
  "13": ["Zadar", "Zadar County"],
  "14": ["Osijek-Baranja", "Osijek-Baranja County"],
  "15": ["Šibenik-Knin", "Šibenik-Knin County"],
  "16": ["Vukovar-Srijem", "Vukovar-Srijem County"],
  "17": ["Split-Dalmatia", "Split-Dalmatia County"],
  "18": ["Istria", "Istria County", "Istra"],
  "19": ["Dubrovnik-Neretva", "Dubrovnik-Neretva County"],
  "20": ["Međimurje", "Međimurje County"],
  "21": ["City of Zagreb"],
};

/**
 * The county lookup the places join through: a municipality's name (as `og_ime`
 * writes it, in capitals) → the county's ISO 3166-2 digits, plus the county
 * name lists those digits stand for.
 *
 * The register's places name their municipality as a *string*, not by id — the
 * `administrativna_jedinica_id` they do carry belongs to another register's
 * numbering — so the join is by name. Three municipality names are used twice
 * over (Privlaka, Otok, Sveta Nedelja), and those are left out rather than
 * assigned to whichever county came first: a wrong county would demote the
 * right candidate, while a missing one only leaves the place as it was. A
 * county's own name is registered too, since the places of a city-county carry
 * that instead of a municipality.
 */
export function rgiCountyIndex(
  opcine: RgiOpcineJson,
  zupanije: RgiZupanijeJson,
): { byUnit: Map<string, string>; divisions: DivisionNames } {
  const codes = new Map<number, string>();
  const divisions: DivisionNames = {};
  const byUnit = new Map<string, string>();
  for (const feature of zupanije.features ?? []) {
    const id = feature.properties?.id;
    const naziv = feature.properties?.naziv;
    const rb = feature.properties?.rb;
    if (typeof id !== "number" || typeof naziv !== "string" || !naziv.trim()) continue;
    const code = String(typeof rb === "number" ? rb : id).padStart(2, "0");
    codes.set(id, code);
    const official = naziv.trim();
    // Files routinely write the county as the bare adjective the official name
    // opens with — "Pula, Istarska, Croatia" for Istarska županija — so that
    // form counts as one of its names too. Grad Zagreb has no such suffix and
    // contributes nothing extra.
    const short = official.replace(/\s+županija$/i, "");
    divisions[code] = [official, ...(short !== official ? [short] : []), ...(HR_COUNTY_ALIASES[code] ?? [])];
  }
  const ambiguous = new Set<string>();
  for (const feature of opcine.features ?? []) {
    const name = typeof feature.properties?.og_ime === "string" ? feature.properties.og_ime.trim() : "";
    const zupanija = feature.properties?.zupanija_id;
    const code = typeof zupanija === "number" ? codes.get(zupanija) : undefined;
    if (!name || !code) continue;
    const key = name.toLocaleUpperCase("hr");
    const seen = byUnit.get(key);
    if (seen === undefined) byUnit.set(key, code);
    else if (seen !== code) ambiguous.add(key);
  }
  for (const key of ambiguous) byUnit.delete(key);
  for (const [code, names] of Object.entries(divisions)) byUnit.set(names[0].toLocaleUpperCase("hr"), code);
  return { byUnit, divisions };
}

/** The register writes its administrative units in capitals ("NOVIGRAD -
 *  CITTANOVA"), which as a candidate's parent label would shout. Recased word
 *  by word — a word being what follows a space, a hyphen, a slash or an opening
 *  bracket. A value that is *not* all capitals ("Grad Zagreb", "Karlovačka
 *  županija") is left exactly as it stands: the register has written that one
 *  out properly, and recasing it would only capitalize what shouldn't be. */
function titleCase(name: string): string {
  if (name !== name.toLocaleUpperCase("hr")) return name;
  return name
    .toLocaleLowerCase("hr")
    .replace(/(^|[\s\-–/(])(\p{L})/gu, (_, before: string, first: string) => before + first.toLocaleUpperCase("hr"));
}

/**
 * The halves of a bilingual name the register wrote as one string — but only
 * where the place's other names prove that is what it is.
 *
 * Istrian towns are officially named in both languages, and the register files
 * that either as two rows ("Pula", "Pola") or as one ("Buje-Buie"). Where it
 * files only the joined form, the bare Croatian name a file actually writes —
 * "Buje", "Umag" — appears nowhere, and the place is missed.
 *
 * Splitting on the hyphen alone would invent names for the genuinely hyphenated
 * ones (Ivanić-Grad is not Ivanić and Grad), so a half is only taken on one of
 * two pieces of evidence from the register itself:
 *
 * - Its counterpart is already one of the place's names. The register has said
 *   "Buie" belongs here, so "Buje-Buie" minus "Buie" belongs here too.
 * - The municipality is written as a bilingual pair. The register separates the
 *   two languages of a unit name with a *spaced* hyphen and joins a genuinely
 *   compound one with a bare hyphen — "BALE - VALLE" against "IVANIĆ-GRAD" —
 *   so a place of one hyphen inside a spaced-pair municipality is a pair as
 *   well. That is what rescues Bale, Tar and Grožnjan, whose bilingual name the
 *   register files as a single row with no half to match against.
 */
function splitJoinedNames(names: string[], admin: string): string[] {
  const folded = new Set(names.map(foldToken));
  const extra: string[] = [];
  const bilingualUnit = /\S\s+-\s+\S/.test(admin);
  for (const name of names) {
    // One hyphen only: a name of several is a compound whose halves this rule
    // cannot place ("Kaštelir-Labinci-Castelliere-S.Domenica").
    if (!bilingualUnit || name.split("-").length !== 2) continue;
    for (const half of name.split("-").map((s) => s.trim())) {
      if (!half || folded.has(foldToken(half))) continue;
      folded.add(foldToken(half));
      extra.push(half);
    }
  }
  for (const name of names) {
    const parts = name.split("-");
    for (let cut = 1; cut < parts.length; cut++) {
      const left = parts.slice(0, cut).join("-").trim();
      const right = parts.slice(cut).join("-").trim();
      if (!left || !right) continue;
      for (const [half, other] of [
        [left, right],
        [right, left],
      ]) {
        if (!folded.has(foldToken(half)) || folded.has(foldToken(other))) continue;
        folded.add(foldToken(other));
        extra.push(other);
      }
    }
  }
  return extra;
}

/** The one row that gives a place its primary name: the official Croatian form,
 *  failing that any official one, failing that whatever came first. The rest
 *  become alternate names — which is where the Italian, Hungarian and Serbian
 *  forms of a bilingual settlement, and the historical ones, end up. */
function primaryNameRow<T extends { language: string; status: string }>(rows: T[]): T {
  return (
    rows.find((r) => r.language === "Hrvatski" && r.status === "službeno") ??
    rows.find((r) => r.status === "službeno") ??
    rows[0]
  );
}

/**
 * Convert the DGU register of geographical names into gazetteer entries — the
 * authoritative Croatian counterpart to {@link rpeNaseljaToEntries}. The caller
 * asks the service for the populated-place feature kinds only, so what arrives
 * is cities, settlements, villages, hamlets, city quarters, farmsteads and
 * abandoned settlements; the features are grouped by `im_id` so a place named
 * in two languages, or under a historical name, becomes one entry with
 * alternates rather than two entries in the same spot, and a city that repeats
 * a settlement of its own name is dropped in favour of it — see
 * {@link CITY_DUPLICATE_DEG}. The municipality (`og_ime`) becomes
 * the parent label that tells same-named places apart, and — given the county
 * lookup from {@link rgiCountyIndex} — the county it sits in becomes the
 * entry's `admin1`, so a place written with its county in any language the
 * county is known by resolves to the right one.
 *
 * Data: Državna geodetska uprava, Registar geografskih imena.
 */
export function rgiPlacesToEntries(data: RgiPlacesJson, counties?: ReadonlyMap<string, string>): GazEntry[] {
  interface Row {
    name: string;
    language: string;
    status: string;
    admin: string;
    lat: number;
    lon: number;
    city: boolean;
  }
  // Insertion-ordered, so the output follows the register's own order rather
  // than the numeric ids — a place's rows arrive together.
  const byPlace = new Map<string, Row[]>();
  let unkeyed = 0;
  for (const feature of data.features ?? []) {
    const props = feature.properties;
    const name = typeof props?.pisanje_imena === "string" ? props.pisanje_imena.trim() : "";
    if (!name) continue;
    if (feature.geometry?.type !== "Point") continue;
    const coords = feature.geometry.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const admin = typeof props?.og_ime === "string" ? props.og_ime.trim() : "";
    const row: Row = {
      name,
      language: typeof props?.jeziknaziv === "string" ? props.jeziknaziv : "",
      status: typeof props?.status_imena === "string" ? props.status_imena : "",
      admin,
      lat,
      lon,
      city: typeof props?.vrstaobiljezjaid === "number" && RGI_CITY_KINDS.has(props.vrstaobiljezjaid),
    };
    // A row with no place id cannot be grouped, so it stands alone — better a
    // duplicate entry than two unrelated places merged under a missing key.
    const key = props?.im_id === undefined || props.im_id === null ? `#${unkeyed++}` : String(props.im_id);
    const rows = byPlace.get(key);
    if (rows) rows.push(row);
    else byPlace.set(key, [row]);
  }

  const entries: GazEntry[] = [];
  const cityAt: number[] = [];
  for (const rows of byPlace.values()) {
    const primary = primaryNameRow(rows);
    if (primary.city) cityAt.push(entries.length);
    const alt: string[] = [];
    for (const r of rows) {
      if (r.name !== primary.name && !alt.includes(r.name)) alt.push(r.name);
    }
    alt.push(...splitJoinedNames([primary.name, ...alt], primary.admin));
    // Same rule as every other source: a parent repeating the place's own name
    // says nothing (a city and the municipality named after it), so it is left off.
    const admin = primary.admin ? titleCase(primary.admin) : "";
    entries.push({
      name: primary.name,
      ascii: "",
      alt,
      lat: primary.lat,
      lon: primary.lon,
      fclass: "P",
      country: "HR",
      admin1: (primary.admin && counties?.get(primary.admin.toLocaleUpperCase("hr"))) || "",
      population: 0,
      register: DGU_REGISTER,
      ...(admin && foldToken(admin) !== foldToken(primary.name) ? { admin } : {}),
    });
  }

  // A city is a local-government unit as well as a place, and the register files
  // it both ways: Samobor arrives once as the city, pinned at its administrative
  // label point and parented by its county, and once as the settlement, pinned
  // in the town and parented by its municipality. The settlement is the better
  // of the two, so the city copy goes — unless there is no settlement near
  // enough to be it, which is how Pula, Buje and Poreč survive: the register
  // holds no settlement row for those at all.
  if (!cityAt.length) return entries;
  const cities = new Set(cityAt);
  // The settlements indexed by folded name once, rather than folding all 24 000
  // of them again for each of the 126 cities.
  const settlements = new Map<string, number[]>();
  for (let i = 0; i < entries.length; i++) {
    if (cities.has(i)) continue;
    const folded = foldToken(entries[i].name);
    const list = settlements.get(folded);
    if (list) list.push(i);
    else settlements.set(folded, [i]);
  }
  const drop = new Set(
    cityAt.filter((i) => {
      const city = entries[i];
      return (settlements.get(foldToken(city.name)) ?? []).some(
        (j) =>
          Math.abs(entries[j].lat - city.lat) < CITY_DUPLICATE_DEG &&
          Math.abs(entries[j].lon - city.lon) < CITY_DUPLICATE_DEG,
      );
    }),
  );
  return drop.size ? entries.filter((_, i) => !drop.has(i)) : entries;
}

/**
 * The saint words a place name is built on, in every form the registers and the
 * files use: "Sv.", "Sveti/Sveta/Sveto", the German "St."/"Sankt". A register
 * abbreviates where a file spells out — GURS writes "Sv. Duh" for the village
 * near Škofja Loka that a researcher writes as "Sveti Duh" — and neither the
 * exact pass nor the fuzzy one sees through that: "sveti duh" and "sv. duh"
 * share too little.
 */
const SAINT_WORD = /\b(?:sveti|sveta|sveto|svete|svetega|svetem|sankt|sv|st)\b\.?/g;

/** A name with its saint words reduced to one form, so the abbreviation a
 *  register uses and the word a file writes meet: "Sveti Duh" and "Sv. Duh"
 *  both become "sv duh". Empty when the name is nothing but a saint word. */
export function saintKey(name: string): string {
  const folded = foldToken(name);
  if (!SAINT_WORD.test(folded)) return "";
  SAINT_WORD.lastIndex = 0;
  const out = folded.replace(SAINT_WORD, "sv").replace(/\s+/g, " ").trim();
  return out === "sv" ? "" : out;
}

/** Fuzzy-match bucket key: first two folded characters. */
function bucketKey(folded: string): string {
  return folded.slice(0, 2);
}

/** In-memory match index over the imported entries. */
export interface GazetteerIndex {
  entries: GazEntry[];
  /** Folded name/ascii/alt → entry indices (exact lookups). */
  byName: Map<string, number[]>;
  /** {@link saintKey} → entry indices, for the names a register abbreviates
   *  and a file spells out. Absent on an index built before this existed. */
  saints?: Map<string, number[]>;
  /** Folded primary-name 2-char prefix → entry indices (fuzzy lookups). */
  buckets: Map<string, number[]>;
  /** `"HR:12"` (country:admin1) → every name that division goes by. */
  divisions?: Map<string, string[]>;
}

/**
 * The stored directories' entries flattened for the index, each labelled with
 * the directory it came from: an entry whose store key is neither its register
 * nor its bare country code (an OpenStreetMap download stored as "HR-OSM")
 * gets that key as its `source`, so the candidate badge can name the directory
 * in full instead of showing the same "HR" for two different imports.
 */
export function storedEntries(countries: { code: string; entries: GazEntry[] }[]): GazEntry[] {
  return countries.flatMap((c) =>
    c.entries.map((e) => (e.register || e.source || c.code === e.country ? e : { ...e, source: c.code })),
  );
}

/**
 * The stored countries' division-name tables merged into one lookup map, keyed
 * `"HR:12"` (entry country + admin1 code) — the register key ("HR", "HR-OSM")
 * can't serve because two imports of one country describe the same divisions.
 * Name lists of the same division from different sources concatenate.
 */
export function mergeDivisions(countries: { entries: GazEntry[]; divisions?: DivisionNames }[]): Map<string, string[]> {
  const merged = new Map<string, string[]>();
  for (const c of countries) {
    if (!c.divisions) continue;
    const country = c.entries[0]?.country;
    if (!country) continue;
    for (const [admin1, names] of Object.entries(c.divisions)) {
      const key = `${country}:${admin1}`;
      const list = merged.get(key);
      if (!list) merged.set(key, [...names]);
      else for (const n of names) if (!list.includes(n)) list.push(n);
    }
  }
  return merged;
}

export function buildGazetteerIndex(entries: GazEntry[], divisions?: Map<string, string[]>): GazetteerIndex {
  const byName = new Map<string, number[]>();
  const saints = new Map<string, number[]>();
  const buckets = new Map<string, number[]>();
  const add = (map: Map<string, number[]>, key: string, i: number) => {
    if (!key) return;
    const list = map.get(key);
    if (list) {
      if (list[list.length - 1] !== i) list.push(i);
    } else map.set(key, [i]);
  };
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const folded = foldToken(e.name);
    add(byName, folded, i);
    add(buckets, bucketKey(folded), i);
    if (e.ascii) {
      const fa = foldToken(e.ascii);
      add(byName, fa, i);
      add(buckets, bucketKey(fa), i);
    }
    for (const alt of e.alt) add(byName, foldToken(alt), i);
    // A saint's name under its other spelling, so "Sveti Duh" reaches the
    // register's "Sv. Duh" (and the other way round). Kept in the same map, and
    // scored below a literal match where it is read (see lookupPlace).
    for (const name of [e.name, e.ascii, ...e.alt]) {
      const key = name && saintKey(name);
      if (key && key !== foldToken(name)) add(saints, key, i);
    }
  }
  return { entries, byName, saints, buckets, ...(divisions ? { divisions } : {}) };
}

/** One proposed match for a place string. */
export interface GazCandidate {
  entry: GazEntry;
  /** 0–1; ≥ {@link HIGH_CONFIDENCE} qualifies for bulk-accept. */
  score: number;
  /** The entry's division in the spelling the place string itself uses
   *  ("Požega-Slavonia" for an entry whose stored name is "Požeško-Slavonska
   *  Županija") — shown instead of `entry.admin` when the file named the
   *  division under one of its known names. */
  adminDisplay?: string;
}

/** Bulk-accept threshold: exact unique name match in the right country. */
export const HIGH_CONFIDENCE = 0.95;

/** Below this a fuzzy candidate isn't worth showing. */
const MIN_FUZZY = 0.87;

/** Score for a register name that extends the written one with its parent
 *  ("Vinji vrh" under Semič → "Vinji Vrh pri Semiču"): above the bulk-accept
 *  bar — the parent corroborates it — but below a letter-perfect match. It is
 *  also the floor above which a candidate is *this* place rather than one that
 *  merely resembles it, which is what the register check holds names to. */
export const PARENT_QUALIFIED = 0.96;

/** Score for a name matched through its saint spelling ("Sveti Duh" for the
 *  register's "Sv. Duh"): the same place under the other convention, so above
 *  the parent-qualified bar and just below a literal match. */
const SAINT_FORM = 0.98;

const MAX_CANDIDATES = 6;

/** Same-named entries closer than this (degrees, ≈5 km at Slovenian latitudes)
 *  are the same settlement described by two gazetteers, not two places. */
/** How far a same-named settlement in the wrong municipality is pushed down —
 *  comfortably past the bulk-accept ambiguity gap, without pretending the name
 *  matched any less well than it did. */
const ADMIN_MISMATCH = 0.85;
const DUPLICATE_DEG = 0.05;

/**
 * Answers per raw place value, for the index they were found in.
 *
 * The same question is asked of the same string several times over: the geocode
 * review list and the compliance check both look up every place in the file, and
 * both run again after each edit. The answer depends on nothing but the string
 * and the index, and the expensive half — the fuzzy pass over a 2-char bucket,
 * which a value nothing matches exactly always reaches — is by far the costliest
 * work either scan does. Cached like {@link foldToken} and the geocode tool's
 * address test, and dropped wholesale when the index changes (a directory
 * imported or deleted).
 *
 * The arrays handed out are shared: treat them as read-only.
 */
const lookupCache = new Map<string, GazCandidate[]>();
let lookupCacheIndex: GazetteerIndex | undefined;

/**
 * Candidates for one raw place string: the locality part is matched exactly
 * (primary/ascii/alternate names), then fuzzily within its 2-char bucket;
 * a country named in the place string gates the candidates to that country
 * (a Slovenian gazetteer must not fuzzily offer "Bela, SI" for "Belfast, …,
 * Northern Ireland"), and population breaks ties between same-named places.
 * When no country is named, or its name isn't one we recognize, every
 * country's entries stay eligible — we can't rule anything out.
 */
export function lookupPlace(index: GazetteerIndex, rawPlace: string): GazCandidate[] {
  if (lookupCacheIndex !== index) {
    lookupCache.clear();
    lookupCacheIndex = index;
  }
  const hit = lookupCache.get(rawPlace);
  if (hit) return hit;
  const out = lookupPlaceUncached(index, rawPlace);
  lookupCache.set(rawPlace, out);
  return out;
}

function lookupPlaceUncached(index: GazetteerIndex, rawPlace: string): GazCandidate[] {
  const components = decomposePlace(rawPlace);
  const locality = components.locality ?? rawPlace.split(",")[0].trim();
  if (!locality) return [];
  const folded = foldToken(locality);
  if (!folded) return [];
  // countryCode returns lowercase ISO codes; GeoNames rows carry uppercase.
  const wantCountry = components.country ? countryCode(components.country)?.toUpperCase() : undefined;

  const scores = new Map<number, number>();
  const consider = (i: number, base: number) => {
    const prev = scores.get(i);
    if (prev !== undefined && prev >= base) return;
    scores.set(i, base);
  };

  for (const i of index.byName.get(folded) ?? []) {
    const e = index.entries[i];
    const exactPrimary = foldToken(e.name) === folded || (e.ascii !== "" && foldToken(e.ascii) === folded);
    consider(i, exactPrimary ? 1 : 0.93);
  }
  // The same name under the other saint spelling. Just below a literal match,
  // and above the parent-qualified bar, so a "Sv. Duh" in the občina the place
  // names outranks a literal "Sveti Duh" in another one.
  const saintFolded = saintKey(locality);
  if (saintFolded) for (const i of index.saints?.get(saintFolded) ?? []) consider(i, SAINT_FORM);
  // The place's own parents ("Semič" in "Vinji vrh,Semič,Slovenia"), folded →
  // the file's spelling, plus a word-boundary stem test for finding one
  // *inside* a longer settlement name: parent names inflect there — Semič →
  // "pri Semiču", Metlika → "pri Metliki" — so the final vowel is dropped and
  // the stem must start a word. A hit returns the file's own spelling.
  const parentSpelling = new Map<string, string>();
  for (const part of components.jurisdiction.slice(1)) {
    const f = foldToken(part);
    if (f && !parentSpelling.has(f)) parentSpelling.set(f, part.trim());
  }
  const parents = new Set(parentSpelling.keys());
  const parentInName = (foldedName: string): string | undefined => {
    for (const [f, spelling] of parentSpelling) {
      const stem = /[aeiou]$/.test(f) ? f.slice(0, -1) : f;
      if (stem.length >= 3 && foldedName.includes(" " + stem)) return spelling;
    }
    return undefined;
  };

  // Parent-qualified pass: the register often files a settlement under a
  // longer name that appends its parent — "Vinji vrh" written under Semič is
  // the register's "Vinji Vrh pri Semiču". The plain name may exactly match
  // other municipalities' same-named settlements, so this runs even when the
  // exact pass scored; it is gated on the place's own parents corroborating
  // the longer name (the entry's municipality is a named parent, or the name
  // extension itself contains one), so it never fires on the name alone.
  if (parents.size) {
    const prefix = folded + " ";
    for (const i of index.buckets.get(bucketKey(folded)) ?? []) {
      const e = index.entries[i];
      const foldedNames = [e.name, e.ascii, ...e.alt].filter(Boolean).map(foldToken);
      if (!foldedNames.some((n) => n.startsWith(prefix))) continue;
      const corroborated =
        (!!e.admin && parents.has(foldToken(e.admin))) ||
        foldedNames.some((n) => parentInName(n) !== undefined);
      if (corroborated) consider(i, PARENT_QUALIFIED);
    }
  }
  // Fuzzy pass only when nothing matched exactly — typos and historical
  // spellings, constrained to the 2-char bucket to stay fast.
  if (!scores.size) {
    for (const i of index.buckets.get(bucketKey(folded)) ?? []) {
      const e = index.entries[i];
      const jw = Math.max(
        jaroWinkler(folded, foldToken(e.name)),
        e.ascii ? jaroWinkler(folded, foldToken(e.ascii)) : 0,
      );
      if (jw >= MIN_FUZZY) consider(i, jw * 0.92);
    }
  }

  const candidates: GazCandidate[] = [];
  for (const [i, base] of scores) {
    const e = index.entries[i];
    // Hard country gate: when the place names a country we recognize, only
    // that country's entries qualify. Otherwise a diacritic-tolerant fuzzy
    // match to a loaded but unrelated country's gazetteer proposes nonsense
    // (Belfast → Bela). Places with no recognized country match anywhere.
    if (wantCountry && e.country !== wantCountry) continue;
    let score = base;
    if (e.fclass === "A") score *= 0.97;
    score = Math.min(1, score + Math.min(e.population, 500_000) / 500_000 / 50);
    candidates.push({ entry: e, score });
  }
  // Same name, different municipality — Slovenia has a Soteska in Kamnik and
  // another in Dolenjske Toplice, and the name alone matches both perfectly. When
  // the place itself names one of those parents, the others are demoted enough to
  // clear the bulk-accept ambiguity gap; when it names none, the tie stands and
  // the researcher decides. Only ever applied downward, so a match never invents
  // confidence a plain name did not earn. A parent is recognized under any of
  // its division's names — the file may write "Požega-Slavonia" where the entry
  // stores "Požeško-Slavonska Županija" — or inside a parent-qualified
  // settlement name ("Vinji Vrh pri Semiču" for a written "Semič"), and the
  // matched candidate then shows the file's own spelling.
  const matchedParent = (e: GazEntry): string | undefined => {
    const names = e.admin ? [e.admin] : [];
    if (e.admin1) names.push(...(index.divisions?.get(`${e.country}:${e.admin1}`) ?? []));
    for (const name of names) {
      const spelling = parentSpelling.get(foldToken(name));
      if (spelling !== undefined) return spelling;
    }
    return parentInName(foldToken(e.name));
  };
  if (parentSpelling.size && candidates.some((c) => matchedParent(c.entry) !== undefined)) {
    for (const c of candidates) {
      const spelling = matchedParent(c.entry);
      if (spelling === undefined) c.score *= ADMIN_MISMATCH;
      else c.adminDisplay = spelling;
    }
  }

  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      Number(!!b.entry.register) - Number(!!a.entry.register) ||
      b.entry.population - a.entry.population,
  );
  // With two gazetteers loaded for one country (the official register plus an
  // OpenStreetMap or GeoNames import) the same settlement appears twice, at
  // near-identical scores. Left alone those twins crowd out real alternatives
  // and, because the scores tie, make every such place look ambiguous to the
  // bulk-accept gate — so collapse each cluster to its best (authoritative)
  // entry. Same-named places genuinely far apart stay separate.
  const merged: GazCandidate[] = [];
  for (const c of candidates) {
    const folded = foldToken(c.entry.name);
    const twin = merged.some(
      (k) =>
        foldToken(k.entry.name) === folded &&
        Math.abs(k.entry.lat - c.entry.lat) < DUPLICATE_DEG &&
        Math.abs(k.entry.lon - c.entry.lon) < DUPLICATE_DEG,
    );
    if (!twin) merged.push(c);
  }
  return merged.slice(0, MAX_CANDIDATES);
}

/**
 * Name search over the loaded gazetteers: entries whose name (primary, ASCII or
 * alternate) is the typed text, then those that start with it, then those that
 * merely contain it. Unlike {@link lookupPlace} — which resolves a *complete*
 * place string the file already carries — this serves a place being typed that
 * the file does not know yet, so the register can supply its full form.
 *
 * A country named after a comma restricts the results the same way lookupPlace
 * gates its candidates, so "Bela, Austria" is not answered from a Slovenian
 * import.
 *
 * `fuzzy` adds a last tier of names that merely *resemble* the text, which is
 * the only way a misspelling is ever found: no substring test relates
 * "Mrkopolje" to the register's "Mrkopalj". Off by default — those are leads to
 * judge rather than answers, so only a reader who asked to look wider gets
 * them, never the place field completing what is being typed.
 */
export function searchGazetteer(
  index: GazetteerIndex,
  rawQuery: string,
  limit = 6,
  fuzzy = false,
): GazEntry[] {
  const components = decomposePlace(rawQuery);
  const locality = (components.locality ?? rawQuery.split(",")[0]).trim();
  const folded = foldToken(locality);
  if (folded.length < 2) return [];
  const wantCountry = components.country ? countryCode(components.country)?.toUpperCase() : undefined;

  // Every entry is looked at, not just the bucket the query opens: a hamlet is
  // found by the second word of its name ("Spodnje Zabukovje" for "Zabukovje")
  // and a place by its German exonym ("Bischoflack"), and neither shares the
  // typed text's opening two characters. This runs once per lookup, on the
  // user's click — not per keystroke — so the pass is affordable.
  const scored: { entry: GazEntry; rank: number }[] = [];
  for (const e of index.entries) {
    if (wantCountry && e.country !== wantCountry) continue;
    // 0 = the whole name, 1 = a prefix of it, 2 = contained anywhere,
    // 3 = merely resembles it (only when asked for).
    let rank = 4;
    const saintQuery = saintKey(locality);
    for (const raw of [e.name, e.ascii, ...e.alt]) {
      if (!raw) continue;
      const n = foldToken(raw);
      if (n === folded) rank = Math.min(rank, 0);
      else if (n.startsWith(folded)) rank = Math.min(rank, 1);
      else if (n.includes(folded)) rank = Math.min(rank, 2);
      // "Sveti Duh" finds the register's "Sv. Duh" here as well.
      else if (saintQuery && saintKey(raw) === saintQuery) rank = Math.min(rank, 0);
      // A misspelling shares no substring to be found by — "Mrkopolje" for the
      // register's "Mrkopalj" — so the last tier asks how alike the two names
      // are instead. Gated on a length within a few letters, which keeps the
      // comparison off the overwhelming majority of a country's entries.
      else if (
        fuzzy &&
        rank > 3 &&
        Math.abs(n.length - folded.length) <= 3 &&
        jaroWinkler(folded, n) >= MIN_FUZZY
      ) {
        rank = 3;
      }
    }
    if (rank < 4) scored.push({ entry: e, rank });
  }
  scored.sort(
    (a, b) =>
      a.rank - b.rank ||
      Number(!!b.entry.register) - Number(!!a.entry.register) ||
      b.entry.population - a.entry.population ||
      a.entry.name.localeCompare(b.entry.name),
  );

  // The same settlement from two imports (register + OpenStreetMap) — keep the
  // first, which the sort already made the authoritative one.
  const out: GazEntry[] = [];
  for (const { entry } of scored) {
    const name = foldToken(entry.name);
    const twin = out.some(
      (k) =>
        foldToken(k.name) === name &&
        Math.abs(k.lat - entry.lat) < DUPLICATE_DEG &&
        Math.abs(k.lon - entry.lon) < DUPLICATE_DEG,
    );
    if (!twin) out.push(entry);
    if (out.length >= limit) break;
  }
  return out;
}
