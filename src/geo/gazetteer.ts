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
  population: number;
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
  return {
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
}

/** Overpass (OpenStreetMap) JSON response, reduced to what we read. */
export interface OverpassJson {
  elements?: { lat?: number; lon?: number; tags?: Record<string, string> }[];
}

/** OSM name tags worth keeping as alternate names (exonyms, historical). */
const OSM_ALT_TAGS = ["alt_name", "old_name", "loc_name", "name:de", "name:it", "name:hu", "name:en", "name:sl", "name:hr"];

/**
 * Convert an Overpass place query result (nodes tagged `place=*` in one
 * country) into gazetteer entries — the direct-download alternative to a
 * GeoNames file. Data © OpenStreetMap contributors (ODbL).
 */
export function overpassToEntries(data: OverpassJson, country: string): GazEntry[] {
  const entries: GazEntry[] = [];
  for (const el of data.elements ?? []) {
    const name = el.tags?.name?.trim();
    if (!name || el.lat === undefined || el.lon === undefined) continue;
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
      admin1: "",
      population: Number(el.tags?.population) || 0,
    });
  }
  return entries;
}

/** GeoJSON from the GURS RPE "NASELJA" (settlements) collection, reduced to
 *  what we read. Geometry arrives already in WGS84 (CRS84), so no projection
 *  step is needed — unlike the RN address register, whose features carry no
 *  geometry at all and expose D96/TM easting/northing as properties. */
export interface RpeNaseljaJson {
  features?: {
    properties?: { NAZIV?: unknown; NAZIV_DJ?: unknown } | null;
    geometry?: { type?: unknown; coordinates?: unknown } | null;
  }[];
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
export function rpeNaseljaToEntries(data: RpeNaseljaJson): GazEntry[] {
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
    });
  }
  return entries;
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
  /** Folded primary-name 2-char prefix → entry indices (fuzzy lookups). */
  buckets: Map<string, number[]>;
}

export function buildGazetteerIndex(entries: GazEntry[]): GazetteerIndex {
  const byName = new Map<string, number[]>();
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
  }
  return { entries, byName, buckets };
}

/** One proposed match for a place string. */
export interface GazCandidate {
  entry: GazEntry;
  /** 0–1; ≥ {@link HIGH_CONFIDENCE} qualifies for bulk-accept. */
  score: number;
}

/** Bulk-accept threshold: exact unique name match in the right country. */
export const HIGH_CONFIDENCE = 0.95;

/** Below this a fuzzy candidate isn't worth showing. */
const MIN_FUZZY = 0.87;

const MAX_CANDIDATES = 6;

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
  candidates.sort((a, b) => b.score - a.score || b.entry.population - a.entry.population);
  return candidates.slice(0, MAX_CANDIDATES);
}
