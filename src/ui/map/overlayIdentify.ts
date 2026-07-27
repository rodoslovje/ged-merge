import type L from "leaflet";
import type { MapOverlay } from "../SettingsContext";
import { parseWmsParams } from "./overlayConfig";

// Click-to-identify for WMS overlays: a map click becomes a WMS GetFeatureInfo
// for that pixel, and the returned attributes become popup HTML (the GURS
// address layer's street/number, a parcel's number and cadastral municipality).
// Shared by the Map chart and the small place maps. Leaflet is imported for
// types only, so the formatting can be tested without a DOM.

/** How many features one layer may answer with. */
const FEATURE_COUNT = 5;

/** Pixel tolerance so a click near a point symbol still hits it. */
const CLICK_BUFFER_PX = 12;

/** Escape a string for safe interpolation into a Leaflet popup's innerHTML. */
function escHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"));
}

const NULLISH = (v: unknown): v is null | undefined | "" => v == null || v === "" || v === "null";

/** The overlays a click can be answered by: WMS, with an info layer named, and
 *  drawn in Web Mercator (a client-side reprojected layer cannot answer a query
 *  phrased in the map's own CRS). */
export function queryableOverlays(overlays: readonly MapOverlay[]): MapOverlay[] {
  return overlays.filter((o) => o.wms && o.queryLayers && !o.nativeCrs);
}

/** Turn one GetFeatureInfo feature's properties into a popup HTML block. GURS
 *  address, parcel and cadastral-municipality features get a formatted line;
 *  anything else falls back to its readable fields (raw *_SIFRA / EID_ /
 *  geometry dropped). */
export function formatFeatureInfo(
  props: Record<string, unknown> | undefined,
  layerName: string,
  translate: (key: string) => string,
): string {
  if (!props) return "";
  // Address / house-number feature (SI.GURS.KN:NASLOVI_HS et al.).
  if (!NULLISH(props.HS_STEVILKA) && (!NULLISH(props.ULICA_NAZIV) || !NULLISH(props.NASELJE_NAZIV))) {
    const num = `${props.HS_STEVILKA}${NULLISH(props.HS_DODATEK) ? "" : String(props.HS_DODATEK)}`;
    const street = NULLISH(props.ULICA_NAZIV) ? String(props.NASELJE_NAZIV) : String(props.ULICA_NAZIV);
    const town = NULLISH(props.POSTNI_OKOLIS_NAZIV) ? props.NASELJE_NAZIV : props.POSTNI_OKOLIS_NAZIV;
    const post = [props.POSTNI_OKOLIS_SIFRA, town].filter((v) => !NULLISH(v)).map(String).join(" ");
    return `<div class="map-info-block"><strong>${escHtml(`${street} ${num}`.trim())}</strong>${
      post ? `<br>${escHtml(post)}` : ""
    }</div>`;
  }
  // Cadastral parcel (SI.GURS.KN:PARCELE): the id a land record is filed under
  // is the parcel number plus its cadastral municipality — NAZIV already reads
  // "1791 ŽALNA", so it needs no assembling.
  if (!NULLISH(props.ST_PARCELE)) {
    const lines = [
      NULLISH(props.NAZIV) ? "" : `${translate("map.info.cadastralMunicipality")}: ${props.NAZIV}`,
      NULLISH(props.POVRSINA) ? "" : `${translate("map.info.area")}: ${props.POVRSINA} m²`,
    ].filter(Boolean);
    return `<div class="map-info-block"><strong>${escHtml(
      `${translate("map.info.parcel")} ${props.ST_PARCELE}`,
    )}</strong>${lines.map((l) => `<br>${escHtml(l)}`).join("")}</div>`;
  }
  // Cadastral municipality (SI.GURS.KN:KATASTRSKE_OBCINE) — number + name.
  if (!NULLISH(props.SIFKO) && !NULLISH(props.NAZIV)) {
    return `<div class="map-info-block"><strong>${escHtml(
      `${props.SIFKO} ${props.NAZIV}`,
    )}</strong><br>${escHtml(translate("map.info.cadastralMunicipality"))}</div>`;
  }
  // Generic fallback: a few readable attributes.
  const skip = (k: string) => /^EID_/.test(k) || /_SIFRA$/.test(k) || /_DJ$/.test(k) || k === "GEOM" || /^DATUM/.test(k);
  const rows = Object.entries(props)
    .filter(([k, v]) => !NULLISH(v) && !skip(k))
    .slice(0, 6)
    .map(([k, v]) => `<div>${escHtml(k)}: ${escHtml(String(v))}</div>`)
    .join("");
  return rows ? `<div class="map-info-block"><em>${escHtml(layerName)}</em>${rows}</div>` : "";
}

/** The GetFeatureInfo URL for one overlay, describing the current view in Web
 *  Mercator and the clicked pixel within it. */
export function featureInfoUrl(
  o: MapOverlay,
  view: { bbox: string; width: number; height: number; i: number; j: number },
): string {
  const params = new URLSearchParams({
    SERVICE: "WMS",
    VERSION: "1.3.0",
    REQUEST: "GetFeatureInfo",
    // GeoServer requires QUERY_LAYERS ⊆ LAYERS, so query against the info
    // layer itself (which may differ from the drawn `layers`).
    LAYERS: o.queryLayers!,
    QUERY_LAYERS: o.queryLayers!,
    CRS: "EPSG:3857",
    BBOX: view.bbox,
    WIDTH: String(view.width),
    HEIGHT: String(view.height),
    I: String(view.i),
    J: String(view.j),
    INFO_FORMAT: "application/json",
    FEATURE_COUNT: String(FEATURE_COUNT),
    BUFFER: String(CLICK_BUFFER_PX),
    ...parseWmsParams(o.params),
  });
  return `${o.url}?${params.toString()}`;
}

/** Query every target layer for the clicked point and return the popup blocks
 *  (empty when nothing was hit — a click on bare ground stays silent). A layer
 *  whose request fails is skipped; the others may still answer. */
export async function identifyAt(
  map: L.Map,
  targets: readonly MapOverlay[],
  latlng: L.LatLng,
  nameOf: (o: MapOverlay) => string,
  translate: (key: string) => string,
): Promise<string[]> {
  const size = map.getSize();
  const b = map.getBounds();
  const sw = map.options.crs!.project(b.getSouthWest());
  const ne = map.options.crs!.project(b.getNorthEast());
  const pt = map.latLngToContainerPoint(latlng);
  const view = {
    bbox: `${sw.x},${sw.y},${ne.x},${ne.y}`,
    width: size.x,
    height: size.y,
    i: Math.max(0, Math.min(size.x - 1, Math.round(pt.x))),
    j: Math.max(0, Math.min(size.y - 1, Math.round(pt.y))),
  };
  const blocks: string[] = [];
  for (const o of targets) {
    try {
      const res = await fetch(featureInfoUrl(o, view));
      const data = (await res.json()) as { features?: { properties?: Record<string, unknown> }[] };
      for (const f of data.features ?? []) {
        const html = formatFeatureInfo(f.properties, nameOf(o), translate);
        if (html) blocks.push(html);
      }
    } catch {
      // Network/parse failure — skip this layer; others may still answer.
    }
  }
  return blocks;
}

/** The popup body for a set of blocks. */
export function identifyPopupHtml(blocks: readonly string[]): string {
  return `<div class="map-info">${blocks.join("")}</div>`;
}
