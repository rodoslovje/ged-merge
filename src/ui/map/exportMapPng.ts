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
// attribution line the provider terms require.

/** The tile layers to compose, in paint order. `base` null = the offline
 *  outline; each overlay is one layer's container with its live opacity. */
export interface ExportTiles {
  base: HTMLElement | null;
  overlays: { el: HTMLElement; opacity: number }[];
}

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

function outlineRings(): Ring[] {
  const rings: Ring[] = [];
  for (const feature of (worldOutline as GeoJSON.FeatureCollection).features) {
    const geom = feature.geometry;
    if (geom.type === "Polygon") rings.push(...(geom.coordinates as Ring[]));
    else if (geom.type === "MultiPolygon") for (const poly of geom.coordinates as Ring[][]) rings.push(...poly);
  }
  return rings;
}

export function exportMapPng(
  map: L.Map,
  container: HTMLElement,
  tiles: ExportTiles,
  clusters: MapCluster[],
  paths: PersonPath[],
  selectedPathId: string | null,
  title: string,
  slug: string,
  attribution: string,
): void {
  const rect = container.getBoundingClientRect();
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
  const totalW = Math.ceil(Math.max(rect.width, titleNeeds, footerNeeds));
  const totalH = HEADER_H + rect.height + FOOTER_H;

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(totalW * scale);
  canvas.height = Math.round(totalH * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(scale, scale);

  ctx.fillStyle = token("--bg");
  ctx.fillRect(0, 0, totalW, totalH);

  // The map view: shifted below the header (centred when the bands force a
  // wider canvas) and clipped to its box so tiles don't bleed into the bands.
  ctx.save();
  ctx.translate((totalW - rect.width) / 2, HEADER_H);
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
  if (paths.length) {
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
  const font = getComputedStyle(document.body).fontFamily;
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

  if (attribution) {
    ctx.font = `11px ${font}`;
    const w = ctx.measureText(attribution).width + 12;
    ctx.fillStyle = token("--panel");
    ctx.globalAlpha = 0.85;
    ctx.fillRect(rect.width - w, rect.height - 18, w, 18);
    ctx.globalAlpha = 1;
    ctx.fillStyle = token("--muted");
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(attribution, rect.width - 6, rect.height - 9);
  }
  ctx.restore();

  // Header: hairline divider + centred title; footer: divider, brand badge +
  // site on the left, timestamp on the right — the SVG export's layout, in
  // the live theme's ink.
  const bandInk = token("--text") || "#000";
  const footY = HEADER_H + rect.height;
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
