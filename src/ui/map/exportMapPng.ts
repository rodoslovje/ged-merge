import type L from "leaflet";
import type { MapCluster } from "../../geo/cluster";
import type { PersonPath } from "../../geo/paths";
import worldOutline from "../../geo/world110m.json";
import {
  BADGE_BG,
  BADGE_FG,
  BADGE_SIZE,
  FOOTER_GAP,
  FOOTER_H,
  HEADER_H,
  MARGIN_X,
  SANS,
  SITE,
} from "../exportSvg";
import {
  ARROW_MAX_TOTAL,
  ARROW_MIN_SEG_PX,
  ARROW_MIN_SEG_SELECTED_PX,
  clusterColorVar,
  markerSize,
  PATH_STYLE,
  pathArrows,
} from "./markerStyle";

// PNG snapshot of the current map view. The existing SVG export pipeline
// can't serialize raster tiles, so the map composes its own canvas: the
// loaded tile images (drawable because the tile layers request them with
// crossOrigin) — base first (or the offline outline polygons), then the
// active historical overlays at their picker opacity — then the cluster
// circles re-drawn from data (the live markers are DOM DivIcons), then the
// attribution line the provider terms require. The synchronized split view
// exports two such panes side by side under one header/footer; every other
// export is the one-pane case.

/** The tile layers to compose, in paint order. `base` null = the offline
 *  outline; each overlay is one layer's container with its live opacity. */
export interface ExportTiles {
  base: HTMLElement | null;
  overlays: { el: HTMLElement; opacity: number }[];
}

/** One map pane of the snapshot, with everything read from its own live map
 *  (tile positions only mean anything relative to the pane that drew them). */
export interface ExportPane {
  map: L.Map;
  container: HTMLElement;
  tiles: ExportTiles;
  /** This pane's credit line: the base provider plus its own overlays. */
  attribution: string;
  /** Life paths live on the left/single map on screen — a right-half
   *  snapshot leaves them out, like the screen does. */
  withPaths: boolean;
}

/** Gap between side-by-side panes, mirroring the on-screen divider. */
const PANE_GAP = 6;

type Ring = [number, number][];

/** The GED Merge badge (canvas port of exportSvg's svgLogoBadge). */
function drawLogoBadge(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 100, size / 100);
  ctx.beginPath();
  ctx.roundRect(0, 0, 100, 100, 23);
  ctx.fillStyle = BADGE_BG;
  ctx.fill();
  ctx.translate(50, 50);
  ctx.scale(2.3, 2.3);
  ctx.translate(-20, -21);
  ctx.strokeStyle = BADGE_FG;
  ctx.lineWidth = 2.1;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(9, 31);
  ctx.lineTo(9, 11);
  ctx.lineTo(20, 23.5);
  ctx.moveTo(31, 31);
  ctx.lineTo(31, 11);
  ctx.lineTo(20, 23.5);
  ctx.stroke();
  for (const [cx, cy] of [
    [9, 11],
    [31, 11],
  ]) {
    ctx.beginPath();
    ctx.arc(cx, cy, 3.3, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(20, 23.5, 3.3, 0, Math.PI * 2);
  ctx.fillStyle = BADGE_FG;
  ctx.fill();
  ctx.restore();
}

/** The scale bar, drawn into the map view the way Leaflet draws it on screen:
 *  the widest "nice" round distance that fits a target width. Leaflet's own
 *  rounding (1, 2, 3, 5 or 10 times a power of ten) is mirrored so the export
 *  and the live control never disagree about what the bar says. */
function drawScaleBar(
  ctx: CanvasRenderingContext2D,
  map: L.Map,
  rect: { width: number; height: number },
  ink: string,
  panel: string,
): void {
  const target = 130;
  const y = rect.height / 2;
  const metres = map.containerPointToLatLng([0, y]).distanceTo(map.containerPointToLatLng([target, y]));
  if (!(metres > 0)) return;
  const pow = Math.pow(10, Math.floor(Math.log10(metres)));
  const d = metres / pow;
  const round = (d >= 10 ? 10 : d >= 5 ? 5 : d >= 3 ? 3 : d >= 2 ? 2 : 1) * pow;
  const width = target * (round / metres);
  const label = round < 1000 ? `${round} m` : `${round / 1000} km`;

  const x = 6;
  const baseY = rect.height - 8;
  ctx.save();
  ctx.font = `10.5px ${SANS}`;
  const boxW = Math.max(width, ctx.measureText(label).width + 10);
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = panel;
  ctx.fillRect(x, baseY - 17, boxW, 17);
  ctx.globalAlpha = 1;
  // A bracket open at the top, exactly as the on-screen bar draws it.
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + 0.5, baseY - 12.5);
  ctx.lineTo(x + 0.5, baseY - 0.5);
  ctx.lineTo(x + width - 0.5, baseY - 0.5);
  ctx.lineTo(x + width - 0.5, baseY - 12.5);
  ctx.stroke();
  ctx.fillStyle = ink;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(label, x + 4, baseY - 4);
  ctx.restore();
}

function outlineRings(): Ring[] {
  const rings: Ring[] = [];
  for (const feature of (worldOutline as GeoJSON.FeatureCollection).features) {
    const geom = feature.geometry;
    if (geom.type === "Polygon") rings.push(...(geom.coordinates as Ring[]));
    else if (geom.type === "MultiPolygon") for (const poly of geom.coordinates as Ring[][]) rings.push(...poly);
  }
  return rings;
}

/** One pane's map view, drawn at `offsetX` below the header band and clipped
 *  to its own box so tiles don't bleed into the bands or the neighbour pane. */
function drawPane(
  ctx: CanvasRenderingContext2D,
  pane: ExportPane,
  rect: DOMRect,
  offsetX: number,
  clusters: MapCluster[],
  paths: PersonPath[],
  selectedPathId: string | null,
  token: (name: string) => string,
  font: string,
): void {
  const { map, tiles } = pane;
  ctx.save();
  ctx.translate(offsetX, HEADER_H);
  ctx.beginPath();
  ctx.rect(0, 0, rect.width, rect.height);
  ctx.clip();

  const drawTileImages = (root: HTMLElement, opacity: number) => {
    ctx.globalAlpha = opacity;
    // Most tiles are <img>; a layer reprojected in the browser paints its tiles
    // onto <canvas> instead (see reprojectedWmsLayer) — both draw the same way.
    for (const img of root.querySelectorAll<HTMLImageElement | HTMLCanvasElement>(
      "img.leaflet-tile-loaded, canvas.leaflet-tile-loaded",
    )) {
      const r = img.getBoundingClientRect();
      try {
        ctx.drawImage(img, r.left - rect.left, r.top - rect.top, r.width, r.height);
      } catch {
        // A tainted tile (provider without CORS) can't be exported — skip it
        // rather than abort; the marker layer still carries the information.
      }
    }
    ctx.globalAlpha = 1;
  };
  if (tiles.base) {
    drawTileImages(tiles.base, 1);
  } else {
    // Offline outline fallback: draw the land polygons through the live map
    // projection so the export matches the screen exactly.
    ctx.fillStyle = token("--map-land");
    ctx.strokeStyle = token("--border-2");
    ctx.lineWidth = 0.6;
    for (const ring of outlineRings()) {
      ctx.beginPath();
      for (let i = 0; i < ring.length; i++) {
        const pt = map.latLngToContainerPoint([ring[i][1], ring[i][0]]);
        if (i === 0) ctx.moveTo(pt.x, pt.y);
        else ctx.lineTo(pt.x, pt.y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }
  // Historical overlays above the base, at their live picker opacity.
  for (const overlay of tiles.overlays) drawTileImages(overlay.el, overlay.opacity);

  // Life paths under the markers, drawn with the same style rules as the
  // live canvas layer (weights, dimming, direction-chevron budget).
  if (pane.withPaths && paths.length) {
    const pathColor = token("--map-path");
    const anySelected = selectedPathId !== null && paths.some((p) => p.personId === selectedPathId);
    let arrowBudget = ARROW_MAX_TOTAL;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const path of paths) {
      const isSel = path.personId === selectedPathId;
      const pts = path.stops.map((s) => map.latLngToContainerPoint([s.coord.lat, s.coord.lon]));
      if (!isSel && !pts.some((p) => p.x > -50 && p.y > -50 && p.x < rect.width + 50 && p.y < rect.height + 50)) continue;
      ctx.strokeStyle = pathColor;
      ctx.lineWidth = isSel ? PATH_STYLE.weightSelected : PATH_STYLE.weight;
      ctx.globalAlpha = anySelected
        ? isSel
          ? PATH_STYLE.opacitySelected
          : PATH_STYLE.opacityDimmed
        : PATH_STYLE.opacity;
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        if (i === 0) ctx.moveTo(pts[i].x, pts[i].y);
        else ctx.lineTo(pts[i].x, pts[i].y);
      }
      ctx.stroke();
      if ((isSel || !anySelected) && arrowBudget > 0) {
        ctx.fillStyle = pathColor;
        for (const a of pathArrows(pts, isSel ? ARROW_MIN_SEG_SELECTED_PX : ARROW_MIN_SEG_PX)) {
          if (arrowBudget-- <= 0) break;
          ctx.save();
          ctx.translate(a.x, a.y);
          ctx.rotate((a.angleDeg * Math.PI) / 180);
          ctx.beginPath();
          ctx.moveTo(-4, -3);
          ctx.lineTo(4, 0);
          ctx.lineTo(-4, 3);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  const ink = token("--accent-ink") || "#fff";
  for (const cluster of clusters) {
    const pt = map.latLngToContainerPoint([cluster.lat, cluster.lon]);
    if (pt.x < -50 || pt.y < -50 || pt.x > rect.width + 50 || pt.y > rect.height + 50) continue;
    const count = cluster.points.length;
    const radius = markerSize(count) / 2;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = token(clusterColorVar(cluster));
    ctx.fill();
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    if (count > 1) {
      ctx.fillStyle = ink;
      ctx.font = `600 ${Math.max(10, Math.min(13, radius))}px ${font}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(count), pt.x, pt.y);
    }
  }

  if (pane.attribution) {
    ctx.font = `11px ${font}`;
    const w = ctx.measureText(pane.attribution).width + 12;
    ctx.fillStyle = token("--panel");
    ctx.globalAlpha = 0.85;
    ctx.fillRect(rect.width - w, rect.height - 18, w, 18);
    ctx.globalAlpha = 1;
    ctx.fillStyle = token("--muted");
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(pane.attribution, rect.width - 6, rect.height - 9);
  }
  // Bottom left, opposite the attribution — a cadastral extract read months
  // later needs to say how wide its parcels are.
  drawScaleBar(ctx, map, rect, token("--muted"), token("--panel"));
  ctx.restore();
}

export function exportMapPng(
  panes: ExportPane[],
  clusters: MapCluster[],
  paths: PersonPath[],
  selectedPathId: string | null,
  title: string,
  slug: string,
): void {
  if (!panes.length) return;
  const rects = panes.map((p) => p.container.getBoundingClientRect());
  const scale = 2;
  const styles = getComputedStyle(document.documentElement);
  const token = (name: string) => styles.getPropertyValue(name).trim();

  // Header/footer bands around the map view, sized by the same rules as the
  // SVG chart export (title and footer must never be squeezed).
  const measure = document.createElement("canvas").getContext("2d");
  const textW = (text: string, f: string) => {
    if (!measure) return text.length * 8;
    measure.font = f;
    return measure.measureText(text).width;
  };
  const timestamp = new Date().toLocaleString();
  const titleNeeds = textW(title, `600 18px ${SANS}`) + 2 * MARGIN_X;
  const footerNeeds =
    2 * MARGIN_X + BADGE_SIZE + 8 + textW(SITE, `600 12px ${SANS}`) + FOOTER_GAP + textW(timestamp, `12px ${SANS}`);
  const mapsW = rects.reduce((sum, r) => sum + r.width, 0) + PANE_GAP * (panes.length - 1);
  const mapsH = Math.max(...rects.map((r) => r.height));
  const totalW = Math.ceil(Math.max(mapsW, titleNeeds, footerNeeds));
  const totalH = HEADER_H + mapsH + FOOTER_H;

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(totalW * scale);
  canvas.height = Math.round(totalH * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(scale, scale);

  ctx.fillStyle = token("--bg");
  ctx.fillRect(0, 0, totalW, totalH);

  // The panes in order, left to right (centred when the bands force a wider
  // canvas), each clipped to its own box.
  const font = getComputedStyle(document.body).fontFamily;
  let paneX = (totalW - mapsW) / 2;
  for (let i = 0; i < panes.length; i++) {
    drawPane(ctx, panes[i], rects[i], paneX, clusters, paths, selectedPathId, token, font);
    paneX += rects[i].width + PANE_GAP;
  }

  // Header: hairline divider + centred title; footer: divider, brand badge +
  // site on the left, timestamp on the right — the SVG export's layout, in
  // the live theme's ink.
  const bandInk = token("--text") || "#000";
  const footY = HEADER_H + mapsH;
  ctx.strokeStyle = bandInk;
  ctx.globalAlpha = 0.15;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, HEADER_H);
  ctx.lineTo(totalW, HEADER_H);
  ctx.moveTo(0, footY);
  ctx.lineTo(totalW, footY);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = bandInk;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "center";
  ctx.font = `600 18px ${SANS}`;
  ctx.fillText(title, totalW / 2, HEADER_H / 2 + 6);
  drawLogoBadge(ctx, MARGIN_X, footY + (FOOTER_H - BADGE_SIZE) / 2, BADGE_SIZE);
  const footTextY = footY + FOOTER_H / 2 + 4;
  ctx.fillStyle = bandInk;
  ctx.textAlign = "left";
  ctx.font = `600 12px ${SANS}`;
  const siteX = MARGIN_X + BADGE_SIZE + 8;
  ctx.fillText(SITE, siteX, footTextY);
  ctx.fillRect(siteX, footTextY + 2, ctx.measureText(SITE).width, 0.75);
  ctx.textAlign = "right";
  ctx.font = `12px ${SANS}`;
  ctx.globalAlpha = 0.7;
  ctx.fillText(timestamp, totalW - MARGIN_X, footTextY);
  ctx.globalAlpha = 1;

  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slug}.gedmerge.png`;
    a.click();
    URL.revokeObjectURL(url);
  }, "image/png");
}
