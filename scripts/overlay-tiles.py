#!/usr/bin/env python3
"""Static XYZ tile-pyramid builder for scanned historical map sheets.

Turns public-domain map scans (e.g. Austro-Hungarian Spezialkarte sheets from
Wikimedia Commons / dLib.si / the NYPL CC0 collection) into a folder of
web-mercator tiles that the Map chart's overlay layers can consume — the
self-hosted alternative to subscription tile services. Pure Pillow; no GDAL.

Each sheet is assumed to be drawn on a lon/lat graticule (true for the
Spezialkarte's polyhedric sheets at this scale): the four neatline corners are
mapped to the sheet's geographic bounding box with a projective (homography)
transform, so scan rotation/shear is handled. Base-zoom tiles are cut with
per-tile quad sampling (mercator-correct at the tile corners) and masked to
the sheet's bbox (the scan margins never cover a neighbouring sheet), several
sheets composite into one seamless pyramid, and every lower zoom is a
downsample of its four children.

Usage — single sheet:
  python3 scripts/overlay-tiles.py sheet.jpg \
      --bbox 14.33722,46.0,14.83722,46.25 \
      --out public/tiles-local/ljubljana-1880 [--min-zoom 7]

Usage — mosaic:
  python3 scripts/overlay-tiles.py --manifest sheets.json --out DIR
  # sheets.json: {"sheets": [{"image": "a.jpg", "bbox": [W,S,E,N],
  #                           "frame": "auto" | [8 corner pixels]}, …]}

A wall map engraved as one continuous projection has no per-sheet graticule,
so its manifest carries a top-level "conic" block instead of per-sheet bboxes
and lists panes of the one scan by pixel origin (see scripts/manifests/
README.md). Each pane is then warped through that shared projection.

  --bbox W,S,E,N   geographic coordinates of the neatline (map frame) corners
  --frame          'auto' (default) finds each neatline corner locally: the
                   innermost long rule line with paper on its outer side, per
                   corner quadrant; or eight explicit scan pixels
                   nwx,nwy,nex,ney,sex,sey,swx,swy
  --base-zoom      override the auto-chosen deepest zoom (auto: the finest
                   sheet's scan resolution, capped at 15)
  --min-zoom       shallowest zoom to generate (default 7)

Ferro reminder: Austro-Hungarian sheets label longitudes east of Ferro;
Greenwich = Ferro value − 17°39'46" (≈ 17.662783°).
"""

import argparse
import json
import math
import os
import sys

from PIL import Image, ImageChops, ImageDraw

Image.MAX_IMAGE_PIXELS = None

TILE = 256


# ── Web-mercator helpers ─────────────────────────────────────────────────────

def lon_to_x(lon: float, z: int) -> float:
    return (lon + 180.0) / 360.0 * (1 << z)


def lat_to_y(lat: float, z: int) -> float:
    r = math.radians(lat)
    return (1.0 - math.log(math.tan(r) + 1.0 / math.cos(r)) / math.pi) / 2.0 * (1 << z)


def y_to_lat(y: float, z: int) -> float:
    n = math.pi - 2.0 * math.pi * y / (1 << z)
    return math.degrees(math.atan(0.5 * (math.exp(n) - math.exp(-n))))


def x_to_lon(x: float, z: int) -> float:
    return x / (1 << z) * 360.0 - 180.0


# ── Projective transform (lon/lat → scan pixel) ──────────────────────────────

def solve_homography(src, dst):
    """8-dof homography mapping src[i] → dst[i] (4 point pairs), via plain
    Gaussian elimination — no numpy dependency for a build script."""
    a = []
    b = []
    for (x, y), (u, v) in zip(src, dst):
        a.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        b.append(u)
        a.append([0, 0, 0, x, y, 1, -v * x, -v * y])
        b.append(v)
    n = 8
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for col in range(n):
        pivot = max(range(col, n), key=lambda r: abs(m[r][col]))
        if abs(m[pivot][col]) < 1e-12:
            raise ValueError("degenerate corner geometry")
        m[col], m[pivot] = m[pivot], m[col]
        for r in range(n):
            if r != col and m[r][col]:
                f = m[r][col] / m[col][col]
                for c in range(col, n + 1):
                    m[r][c] -= f * m[col][c]
    h = [m[i][n] / m[i][i] for i in range(n)]
    return h  # [h0..h7], h8 = 1


def apply_h(h, x, y):
    w = h[6] * x + h[7] * y + 1.0
    return (h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w


# ── Conic projection (lon/lat → scan pixel) ──────────────────────────────────

class Conic:
    """Equidistant-conic geo→pixel model, for a map drawn on one continuous
    projection rather than on a per-sheet graticule.

    Meridians are straight lines through an apex, parallels are concentric
    circles about it and are evenly spaced — the standard 18th-century
    "Delisle" construction. The parameters are recovered from the map's own
    printed border graduation (see the manifest's `source` notes), so the
    overlay reproduces the map's own coordinate system; whatever the engraver
    got wrong stays wrong, which is the honest result.

        theta = n * (lon - prime_meridian - lam0)      degrees east of the apex axis
        rho   = rho0 - k * lat                         pixels from the apex
        x, y  = apex + rho * (sin theta, cos theta)    plus a constant fit shift
    """

    def __init__(self, n, lam0, rho0, k, cx, cy, prime_meridian=0.0, shift=(0.0, 0.0)):
        self.n, self.lam0, self.rho0, self.k = n, lam0, rho0, k
        self.cx, self.cy = cx, cy
        self.pm = prime_meridian
        self.dx, self.dy = shift

    def geo_to_px(self, lon, lat):
        th = math.radians(self.n * ((lon - self.pm) - self.lam0))
        rho = self.rho0 - self.k * lat
        return (self.cx + rho * math.sin(th) + self.dx,
                self.cy + rho * math.cos(th) + self.dy)

    def px_to_geo(self, x, y):
        dx, dy = x - self.dx - self.cx, y - self.dy - self.cy
        rho = math.hypot(dx, dy)
        return (self.pm + self.lam0 + math.degrees(math.atan2(dx, dy)) / self.n,
                (self.rho0 - rho) / self.k)

    def geo_bounds(self, x0, y0, x1, y1, steps=64):
        """lon/lat bounding box of a pixel rectangle. The rectangle's edges are
        straight in projected space but curved in lon/lat, so the border is
        sampled rather than taking the four corners."""
        lons, lats = [], []
        for i in range(steps + 1):
            fx = x0 + (x1 - x0) * i / steps
            fy = y0 + (y1 - y0) * i / steps
            for px, py in ((fx, y0), (fx, y1), (x0, fy), (x1, fy)):
                lon, lat = self.px_to_geo(px, py)
                lons.append(lon)
                lats.append(lat)
        return min(lons), min(lats), max(lons), max(lats)


# ── Neatline detection ───────────────────────────────────────────────────────
# Each edge of the map frame is probed in short chunks along its length. In a
# chunk, a rule line is a row (column) whose dark fraction across the chunk is
# high — a chunk is short enough that scan lean can't smear the line across
# rows — and whose immediate exterior side is paper (map content fails that
# test, and it separates the innermost border rule from hachures that start
# right at the frame). The innermost qualifying row per chunk, line-fitted
# across chunks with outlier rejection, gives each edge; corner = the fitted
# edges' intersection.

def _line_fit(points):
    n = len(points)
    sx = sum(p[0] for p in points)
    sy = sum(p[1] for p in points)
    sxx = sum(p[0] * p[0] for p in points)
    sxy = sum(p[0] * p[1] for p in points)
    d = n * sxx - sx * sx
    a = (n * sxy - sx * sy) / d if d else 0.0
    b = (sy - a * sx) / n
    return a, b


def _fit_with_rejection(points, tolerance=6):
    a, b = _line_fit(points)
    kept = [(s, p) for s, p in points if abs(a * s + b - p) <= tolerance]
    if len(kept) >= 3:
        a, b = _line_fit(kept)
    return a, b, len(kept)


def _edge_picks(px, w, h, horizontal, near_start):
    """(along, across) picks of the innermost border rule, one per chunk."""
    length = w if horizontal else h
    depth = h if horizontal else w
    band = max(60, depth // 9)
    chunk = max(120, length // 40)
    picks = []
    for i in range(8):
        s0 = int(length * (0.12 + 0.76 * i / 7)) - chunk // 2
        s0 = max(0, min(length - chunk, s0))
        rng = range(0, band) if near_start else range(depth - band, depth)
        # Paper tone within this chunk's band.
        vals = sorted(
            (px[s, p] if horizontal else px[p, s])
            for p in rng[:: max(1, band // 40)]
            for s in range(s0, s0 + chunk, 16)
        )
        if not vals:
            continue
        paper = vals[int(len(vals) * 0.85)]

        def dark_frac(p):
            n = dark = 0
            for s in range(s0, s0 + chunk, 2):
                n += 1
                if (px[s, p] if horizontal else px[p, s]) < paper - 38:
                    dark += 1
            return dark / max(1, n)

        def paper_outside(p):
            # Mean of the 4–9 px band on the exterior side — between the
            # bundle's rules there is paper; interior content is not.
            step = 1 if near_start else -1
            qs = [p - step * d for d in range(4, 10)]
            vals = [
                (px[s, q] if horizontal else px[q, s])
                for q in qs
                if 0 <= q < depth
                for s in range(s0, s0 + chunk, 24)
            ]
            return bool(vals) and sum(vals) / len(vals) >= paper - 30

        candidates = [p for p in rng if dark_frac(p) >= 0.5 and paper_outside(p)]
        if candidates:
            innermost = max(candidates) if near_start else min(candidates)
            picks.append((s0 + chunk / 2, innermost))
    return picks


def detect_frame(im: Image.Image):
    g = im.convert("L")
    w, h = g.size
    px = g.load()
    edges = {}
    for name, horizontal, near_start in (
        ("top", True, True), ("bottom", True, False), ("left", False, True), ("right", False, False),
    ):
        picks = _edge_picks(px, w, h, horizontal, near_start)
        if len(picks) < 3:
            raise SystemExit(f"neatline detection failed on the {name} edge — pass --frame")
        edges[name] = _fit_with_rejection(picks)[:2]

    def cross(hline, vline):
        ha, hb = hline  # y = ha·x + hb
        va, vb = vline  # x = va·y + vb
        y = (ha * vb + hb) / (1 - ha * va)
        return va * y + vb, y

    nw = cross(edges["top"], edges["left"])
    ne = cross(edges["top"], edges["right"])
    se = cross(edges["bottom"], edges["right"])
    sw = cross(edges["bottom"], edges["left"])
    return nw, ne, se, sw


# ── Sheets ───────────────────────────────────────────────────────────────────

class Sheet:
    """One sheet: geometry up front, pixels loaded lazily — a large mosaic
    holds only the sheet currently being rendered in memory."""

    def __init__(self, image_path, bbox, frame, rotate=0, conic=None, origin=(0, 0)):
        self.path = image_path
        self.bbox = bbox  # (west, south, east, north)
        self.rotate = rotate
        self._im = None
        # A conic sheet is one pane of a single large scan: it carries the
        # whole map's projection plus its own pixel origin within that scan,
        # so panes need no per-sheet geometry of their own.
        self.conic = conic
        self.origin = origin
        if conic is not None:
            self.corners = None
            with Image.open(image_path) as probe:
                self.frame_px_w = probe.size[0]
            print(f"{os.path.basename(image_path)}: conic pane at {tuple(origin)}, "
                  f"bbox {tuple(round(v, 3) for v in bbox)}", flush=True)
            return
        if frame == "auto":
            nw, ne, se, sw = detect_frame(self.load())
        else:
            v = [float(t) for t in frame]
            nw, ne, se, sw = (v[0], v[1]), (v[2], v[3]), (v[4], v[5]), (v[6], v[7])
        self.corners = (nw, ne, se, sw)
        west, south, east, north = bbox
        self.h = solve_homography(
            [(west, north), (east, north), (east, south), (west, south)],
            [nw, ne, se, sw],
        )
        self.frame_px_w = ((ne[0] - nw[0]) + (se[0] - sw[0])) / 2
        print(f"{os.path.basename(image_path)}: frame NW {tuple(round(c) for c in nw)} "
              f"NE {tuple(round(c) for c in ne)} SE {tuple(round(c) for c in se)} "
              f"SW {tuple(round(c) for c in sw)}", flush=True)

    def load(self):
        if self._im is None:
            im = Image.open(self.path)
            if self.rotate:
                im = im.rotate(self.rotate, expand=True)
            self._im = im.convert("RGBA")
        return self._im

    def unload(self):
        self._im = None

    def geo_to_px(self, lon, lat):
        """lon/lat → pixel in this sheet's own image."""
        if self.conic is None:
            return apply_h(self.h, lon, lat)
        x, y = self.conic.geo_to_px(lon, lat)
        return x - self.origin[0], y - self.origin[1]

    def natural_zoom(self):
        west, _s, east, _n = self.bbox
        z = 7
        while z < 15:
            need = (lon_to_x(east, z + 1) - lon_to_x(west, z + 1)) * TILE
            if need > self.frame_px_w * 1.35:
                break
            z += 1
        return z

    def intersects(self, lon_w, lat_s, lon_e, lat_n):
        west, south, east, north = self.bbox
        return west < lon_e and east > lon_w and south < lat_n and north > lat_s

    def render_into(self, tile, tx, ty, z):
        """Composite this sheet's part of tile (tx, ty, z) into `tile`."""
        lon_w, lon_e = x_to_lon(tx, z), x_to_lon(tx + 1, z)
        lat_n, lat_s = y_to_lat(ty, z), y_to_lat(ty + 1, z)
        quad = []
        for lon, lat in ((lon_w, lat_n), (lon_w, lat_s), (lon_e, lat_s), (lon_e, lat_n)):
            quad.extend(self.geo_to_px(lon, lat))
        part = self.load().transform((TILE, TILE), Image.Transform.QUAD, quad,
                                     resample=Image.Resampling.BICUBIC, fillcolor=(0, 0, 0, 0))
        # Mask to the sheet's bbox: in mercator tile space the lon/lat box is
        # an axis-aligned rectangle, so margins beyond the neatline (and any
        # overshoot from warped paper) are clipped exactly at the sheet edge.
        west, south, east, north = self.bbox
        px_w = max(0, round((lon_to_x(west, z) - tx) * TILE))
        px_e = min(TILE, round((lon_to_x(east, z) - tx) * TILE))
        px_n = max(0, round((lat_to_y(north, z) - ty) * TILE))
        px_s = min(TILE, round((lat_to_y(south, z) - ty) * TILE))
        if px_e <= px_w or px_s <= px_n:
            return  # tile touches this sheet's bbox only on the boundary
        if px_w > 0 or px_e < TILE or px_n > 0 or px_s < TILE:
            mask = Image.new("L", (TILE, TILE), 0)
            ImageDraw.Draw(mask).rectangle((px_w, px_n, px_e - 1, px_s - 1), fill=255)
            part.putalpha(ImageChops.multiply(part.getchannel("A"), mask))
        tile.alpha_composite(part)


# ── Pyramid build ────────────────────────────────────────────────────────────

def build(sheets, out, base_zoom, min_zoom, png8=False):
    west = min(s.bbox[0] for s in sheets)
    south = min(s.bbox[1] for s in sheets)
    east = max(s.bbox[2] for s in sheets)
    north = max(s.bbox[3] for s in sheets)

    base_z = base_zoom or max(s.natural_zoom() for s in sheets)
    print(f"{len(sheets)} sheet(s), base zoom {base_z}, min zoom {min_zoom}", flush=True)

    def tile_path(z, x, y):
        return os.path.join(out, str(z), str(x), f"{y}.png")

    def save_tile(img, path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if png8:
            # Quantized palette PNG ≈ 2-3× smaller; these near-monochrome
            # scans lose nothing visible at 255 colours + 1 transparent.
            img.quantize(colors=255, method=Image.Quantize.FASTOCTREE).save(path, optimize=True)
        else:
            img.save(path, optimize=True)

    # Base tiles, one sheet at a time (only one scan in memory): a tile that
    # already exists on disk (a neighbour's edge) is composited into.
    count = 0
    for s in sheets:
        sx0 = math.floor(lon_to_x(s.bbox[0], base_z))
        sx1 = math.ceil(lon_to_x(s.bbox[2], base_z))
        sy0 = math.floor(lat_to_y(s.bbox[3], base_z))
        sy1 = math.ceil(lat_to_y(s.bbox[1], base_z))
        made = 0
        for tx in range(sx0, sx1):
            for ty in range(sy0, sy1):
                path = tile_path(base_z, tx, ty)
                tile = (Image.open(path).convert("RGBA") if os.path.exists(path)
                        else Image.new("RGBA", (TILE, TILE), (0, 0, 0, 0)))
                s.render_into(tile, tx, ty, base_z)
                if tile.getbbox() is None:
                    continue
                save_tile(tile, path)
                made += 1
        s.unload()
        count += made
        print(f"  {os.path.basename(s.path)}: {made} tiles", flush=True)
    print(f"z{base_z}: {count} tiles", flush=True)

    # Parents: stitch and halve the four children.
    for z in range(base_z - 1, min_zoom - 1, -1):
        made = 0
        cx0, cx1 = math.floor(lon_to_x(west, z)), math.ceil(lon_to_x(east, z))
        cy0, cy1 = math.floor(lat_to_y(north, z)), math.ceil(lat_to_y(south, z))
        for tx in range(cx0, cx1):
            for ty in range(cy0, cy1):
                parent = Image.new("RGBA", (TILE * 2, TILE * 2), (0, 0, 0, 0))
                any_child = False
                for dx in (0, 1):
                    for dy in (0, 1):
                        p = tile_path(z + 1, tx * 2 + dx, ty * 2 + dy)
                        if os.path.exists(p):
                            parent.paste(Image.open(p).convert("RGBA"), (dx * TILE, dy * TILE))
                            any_child = True
                if not any_child:
                    continue
                save_tile(parent.resize((TILE, TILE), Image.Resampling.LANCZOS), tile_path(z, tx, ty))
                made += 1
        print(f"z{z}: {made} tiles", flush=True)

    total = 0
    files = 0
    for root, _dirs, names in os.walk(out):
        for name in names:
            files += 1
            total += os.path.getsize(os.path.join(root, name))
    print(f"done: {files} tiles, {total / 1e6:.1f} MB → {out}")
    print(f"overlay URL template: /{os.path.relpath(out, 'public')}/{{z}}/{{x}}/{{y}}.png"
          if out.startswith("public/") else f"overlay URL: serve {out} and use .../{{z}}/{{x}}/{{y}}.png")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("image", nargs="?")
    ap.add_argument("--manifest", help="JSON with a sheets list for a multi-sheet mosaic")
    ap.add_argument("--bbox", help="W,S,E,N in decimal degrees (Greenwich) of the neatline corners")
    ap.add_argument("--frame", default="auto",
                    help="'auto' or nwx,nwy,nex,ney,sex,sey,swx,swy scan-pixel corners")
    ap.add_argument("--out", required=True)
    ap.add_argument("--base-zoom", type=int, default=0)
    ap.add_argument("--min-zoom", type=int, default=7)
    ap.add_argument("--png8", action="store_true",
                    help="quantize tiles to 255-colour palette PNGs (≈2-3× smaller)")
    args = ap.parse_args()

    sheets = []
    if args.manifest:
        spec = json.load(open(args.manifest))
        base = os.path.dirname(os.path.abspath(args.manifest))
        c = spec.get("conic")
        conic = Conic(c["n"], c["lam0"], c["rho0"], c["k"], c["cx"], c["cy"],
                      prime_meridian=c.get("primeMeridian", 0.0),
                      shift=tuple(c.get("shift", (0.0, 0.0)))) if c else None
        for entry in spec["sheets"]:
            path = entry["image"]
            if not os.path.isabs(path):
                path = os.path.join(base, path)
            frame = entry.get("frame", "auto")
            if conic is not None:
                # One pane of a single conic-projected scan: its bbox follows
                # from the projection, so the manifest only pins its origin.
                ox, oy = entry["origin"]
                with Image.open(path) as probe:
                    w, h = probe.size
                bbox = conic.geo_bounds(ox, oy, ox + w, oy + h)
                sheets.append(Sheet(path, bbox, frame, conic=conic, origin=(ox, oy)))
            else:
                sheets.append(Sheet(path, tuple(entry["bbox"]), frame, rotate=entry.get("rotate", 0)))
    else:
        if not args.image or not args.bbox:
            raise SystemExit("either --manifest, or an image plus --bbox, is required")
        bbox = [float(t) for t in args.bbox.split(",")]
        if len(bbox) != 4:
            raise SystemExit("--bbox needs W,S,E,N")
        frame = "auto" if args.frame == "auto" else args.frame.split(",")
        if frame != "auto" and len(frame) != 8:
            raise SystemExit("--frame needs 8 numbers: nwx,nwy,nex,ney,sex,sey,swx,swy")
        sheets.append(Sheet(args.image, tuple(bbox), frame))

    build(sheets, args.out, args.base_zoom, args.min_zoom, png8=args.png8)


if __name__ == "__main__":
    sys.exit(main())
