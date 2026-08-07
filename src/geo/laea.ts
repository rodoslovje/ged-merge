// ETRS89 / LAEA Europe (EPSG:3035) → WGS84.
//
// The projection INSPIRE mandates for pan-European datasets, and the only form
// in which the Croatian DGU serves its address register: every `gml:pos` in
// INSPIRE_Addresses_(AD).zip is an easting/northing on this grid, so a client
// has to project them itself — the same situation as the Slovenian register's
// D96/TM eastings (see d96.ts), a different projection.
//
// Lambert azimuthal equal-area on the GRS80 ellipsoid, inverse direction only:
// the register is read, never written. Snyder / EPSG guidance note 7-2, which is
// exact rather than a series approximation — a house coordinate comes back to
// well within a centimetre. Implemented here rather than pulling in proj4 for
// one projection, exactly as d96.ts is.

/** EPSG:3035 definition: GRS80, origin 52°N 10°E, false easting 4 321 000 m,
 *  false northing 3 210 000 m. */
const A = 6378137.0;
const INV_FLATTENING = 298.257222101;
const FALSE_EASTING = 4321000.0;
const FALSE_NORTHING = 3210000.0;
const LAT0 = (52.0 * Math.PI) / 180;
const LON0 = (10.0 * Math.PI) / 180;

const F = 1 / INV_FLATTENING;
/** First eccentricity squared, and its root. */
const E2 = F * (2 - F);
const E = Math.sqrt(E2);

/** The authalic-sphere `q` of a latitude — twice the area of the zone from the
 *  equator, normalized. Snyder (3-12). */
function authalicQ(sinPhi: number): number {
  return (
    (1 - E2) *
    (sinPhi / (1 - E2 * sinPhi ** 2) - (1 / (2 * E)) * Math.log((1 - E * sinPhi) / (1 + E * sinPhi)))
  );
}

/** Constants of the origin, computed once: the pole's q, the authalic radius,
 *  the authalic latitude of the origin, and Snyder's D. */
const Q_POLE = authalicQ(1);
const R_Q = A * Math.sqrt(Q_POLE / 2);
const BETA0 = Math.asin(authalicQ(Math.sin(LAT0)) / Q_POLE);
const SIN_BETA0 = Math.sin(BETA0);
const COS_BETA0 = Math.cos(BETA0);
const D = (A * (Math.cos(LAT0) / Math.sqrt(1 - E2 * Math.sin(LAT0) ** 2))) / (R_Q * COS_BETA0);

/** Series coefficients turning an authalic latitude back into a geodetic one —
 *  Snyder (3-18), carried to e⁶, which is sub-millimetre at these latitudes. */
const C1 = E2 / 3 + (31 * E2 ** 2) / 180 + (517 * E2 ** 3) / 5040;
const C2 = (23 * E2 ** 2) / 360 + (251 * E2 ** 3) / 3780;
const C3 = (761 * E2 ** 3) / 45360;

/**
 * Project an EPSG:3035 easting/northing to WGS84 degrees.
 *
 * Returns undefined for a non-finite pair or one the projection cannot invert
 * (a point more than a quadrant from the origin, which no European coordinate
 * is) — a malformed register row is skipped rather than plotted in the sea. The
 * *geographic* sanity check belongs to the caller, which knows which country's
 * data it is reading; see {@link isInCroatia}.
 */
export function laea3035ToWgs84(easting: number, northing: number): { lat: number; lon: number } | undefined {
  if (!Number.isFinite(easting) || !Number.isFinite(northing)) return undefined;

  const x = easting - FALSE_EASTING;
  const y = northing - FALSE_NORTHING;
  const rho = Math.hypot(x / D, D * y);
  // The origin itself: ρ = 0 leaves the bearing undefined, and the point is the
  // origin by definition.
  if (rho === 0) return { lat: (LAT0 * 180) / Math.PI, lon: (LON0 * 180) / Math.PI };

  const sinHalfC = rho / (2 * R_Q);
  if (sinHalfC > 1) return undefined;
  const c = 2 * Math.asin(sinHalfC);
  const cosC = Math.cos(c);
  const sinC = Math.sin(c);

  const sinBeta = cosC * SIN_BETA0 + (D * y * sinC * COS_BETA0) / rho;
  if (Math.abs(sinBeta) > 1) return undefined;
  const beta = Math.asin(sinBeta);

  const lat = beta + C1 * Math.sin(2 * beta) + C2 * Math.sin(4 * beta) + C3 * Math.sin(6 * beta);
  const lon =
    LON0 + Math.atan2(x * sinC, D * rho * cosC * COS_BETA0 - D * D * y * sinC * SIN_BETA0);

  return { lat: (lat * 180) / Math.PI, lon: (lon * 180) / Math.PI };
}

/** Croatia's bounding box, as the DGU's own Atom feed declares it, widened by a
 *  tenth of a degree so a border house cannot fall outside its own country. */
const HR_BOUNDS = { minLat: 42.3, maxLat: 46.7, minLon: 13.4, maxLon: 19.6 };

/** True when a projected coordinate plausibly lies in Croatia — the check the
 *  register import applies to every row, so a mis-parsed `gml:pos` is dropped
 *  instead of stored as a house somewhere in the Atlantic. */
export function isInCroatia(coord: { lat: number; lon: number } | undefined): boolean {
  return (
    !!coord &&
    coord.lat >= HR_BOUNDS.minLat &&
    coord.lat <= HR_BOUNDS.maxLat &&
    coord.lon >= HR_BOUNDS.minLon &&
    coord.lon <= HR_BOUNDS.maxLon
  );
}
