import type L from "leaflet";
import type { MapCluster } from "../../geo/cluster";
import worldOutline from "../../geo/world110m.json";
import { clusterColorVar, markerSize } from "./markerStyle";

// PNG snapshot of the current map view. The existing SVG export pipeline
// can't serialize raster tiles, so the map composes its own canvas: the
// loaded tile images (drawable because the tile layer requests them with
// crossOrigin) — or the offline outline polygons — then the cluster circles
// re-drawn from data (the live markers are DOM DivIcons), then the
// attribution line the provider terms require.

type Ring = [number, number][];

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
  clusters: MapCluster[],
  slug: string,
  attribution: string,
): void {
  const rect = container.getBoundingClientRect();
  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(rect.width * scale);
  canvas.height = Math.round(rect.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(scale, scale);

  const styles = getComputedStyle(document.documentElement);
  const token = (name: string) => styles.getPropertyValue(name).trim();
  ctx.fillStyle = token("--bg");
  ctx.fillRect(0, 0, rect.width, rect.height);

  const tiles = container.querySelectorAll<HTMLImageElement>("img.leaflet-tile-loaded");
  if (tiles.length) {
    for (const img of tiles) {
      const r = img.getBoundingClientRect();
      try {
        ctx.drawImage(img, r.left - rect.left, r.top - rect.top, r.width, r.height);
      } catch {
        // A tainted tile (provider without CORS) can't be exported — skip it
        // rather than abort; the marker layer still carries the information.
      }
    }
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
