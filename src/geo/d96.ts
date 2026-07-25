// D96/TM (EPSG:3794) → WGS84.
//
// Slovenia's national grid, and the only form in which the GURS address
// register serves coordinates: its GeoJSON features carry `geometry: null` and
// expose easting/northing as the `E`/`N` properties instead, so a client has to
// project them itself. (The settlements register is the opposite — it serves
// WGS84 polygons directly, see rpeNaseljaToEntries.)
//
// This is the standard inverse Transverse Mercator series (Snyder / EPSG 9807),
// which is well inside a metre over Slovenia — far finer than a house
// coordinate needs. Implemented here rather than pulling in proj4 for one
// projection: the whole transform is ~40 lines of arithmetic with no state.

/** EPSG:3794 definition: GRS80 ellipsoid, central meridian 15°E, scale 0.9999,
 *  false easting 500 000 m, false northing −5 000 000 m, origin at the equator. */
const A = 6378137.0;
const INV_FLATTENING = 298.257222101;
const K0 = 0.9999;
const FALSE_EASTING = 500000.0;
const FALSE_NORTHING = -5000000.0;
const LON0 = (15.0 * Math.PI) / 180;

const F = 1 / INV_FLATTENING;
/** First eccentricity squared. */
const E2 = F * (2 - F);
/** e′² — the second eccentricity squared, as it appears in the series. */
const EP2 = E2 / (1 - E2);

/** Rough extent of Slovenia in D96/TM metres, used only to reject values that
 *  cannot be a Slovenian address (a mis-parsed property, a swapped E/N pair). */
const E_RANGE: readonly [number, number] = [370000, 630000];
const N_RANGE: readonly [number, number] = [30000, 200000];

/** True when an easting/northing pair plausibly lies in Slovenia. */
export function isPlausibleD96(easting: number, northing: number): boolean {
  return (
    Number.isFinite(easting) &&
    Number.isFinite(northing) &&
    easting >= E_RANGE[0] &&
    easting <= E_RANGE[1] &&
    northing >= N_RANGE[0] &&
    northing <= N_RANGE[1]
  );
}

/**
 * Project a D96/TM easting/northing to WGS84 degrees. Returns undefined when
 * the pair is not a plausible Slovenian coordinate, so a malformed register row
 * is skipped rather than plotted in the sea.
 */
export function d96ToWgs84(easting: number, northing: number): { lat: number; lon: number } | undefined {
  if (!isPlausibleD96(easting, northing)) return undefined;

  const x = (easting - FALSE_EASTING) / K0;
  // Meridional arc to the footpoint latitude.
  const m = (northing - FALSE_NORTHING) / K0;
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const mu = m / (A * (1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256));
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);

  const sinPhi1 = Math.sin(phi1);
  const cosPhi1 = Math.cos(phi1);
  const tanPhi1 = Math.tan(phi1);
  const c1 = EP2 * cosPhi1 ** 2;
  const t1 = tanPhi1 ** 2;
  // Radii of curvature at the footpoint: prime vertical and meridional.
  const n1 = A / Math.sqrt(1 - E2 * sinPhi1 ** 2);
  const r1 = (A * (1 - E2)) / (1 - E2 * sinPhi1 ** 2) ** 1.5;
  const d = x / n1;

  const lat =
    phi1 -
    ((n1 * tanPhi1) / r1) *
      (d ** 2 / 2 -
        ((5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * EP2) * d ** 4) / 24 +
        ((61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * EP2 - 3 * c1 ** 2) * d ** 6) / 720);
  const lon =
    LON0 +
    (d -
      ((1 + 2 * t1 + c1) * d ** 3) / 6 +
      ((5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * EP2 + 24 * t1 ** 2) * d ** 5) / 120) /
      cosPhi1;

  return { lat: (lat * 180) / Math.PI, lon: (lon * 180) / Math.PI };
}
