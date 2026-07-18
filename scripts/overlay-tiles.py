#!/usr/bin/env python3
"""Static XYZ tile-pyramid builder for scanned historical map sheets.

Turns a public-domain map scan (e.g. an Austro-Hungarian Spezialkarte sheet
from Wikimedia Commons / dLib.si) into a folder of web-mercator tiles that the
Map chart's overlay layers can consume — the self-hosted alternative to
subscription tile services. Pure Pillow; no GDAL required.

The sheet is assumed to be drawn on a lon/lat graticule (true for the
Spezialkarte's polyhedric sheets at this scale): the four neatline corners are
mapped to the given geographic bounding box with a projective (homography)
transform, so scan rotation/shear is handled. Base-zoom tiles are cut with
per-tile quad sampling (mercator-correct at the tile corners), and every
lower zoom is a downsample of its four children.

Usage:
  python3 scripts/overlay-tiles.py sheet.jpg \
      --bbox 14.33722,46.0,14.83722,46.25 \
      --out public/tiles-local/ljubljana-1880 [--frame auto] [--min-zoom 7]

  --bbox W,S,E,N   geographic coordinates of the neatline (map frame) corners
  --frame          'auto' (default) detects the neatline; or eight numbers
                   nwx,nwy,nex,ney,sex,sey,swx,swy in scan pixels
  --base-zoom      override the auto-chosen deepest zoom
  --min-zoom       shallowest zoom to generate (default 7)

Ferro reminder: Austro-Hungarian sheets label longitudes east of Ferro;
Greenwich = Ferro value − 17°39'46" (≈ 17.662783°).
"""

import argparse
import math
import os
import sys

from PIL import Image

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


# ── Neatline auto-detection ──────────────────────────────────────────────────

def detect_frame(im: Image.Image):
    """Find the inner map frame (neatline): in each outer band of the scan,
    the innermost long dark line. Lines are fitted from several windows so a
    slightly rotated scan still yields true corner intersections."""
    g = im.convert("L")
    w, h = g.size
    band_h = max(1, h // 22)
    band_w = max(1, w // 22)
    px = g.load()

    def dark_fraction_row(y, x0, x1):
        dark = 0
        step = max(1, (x1 - x0) // 800)
        total = 0
        for x in range(x0, x1, step):
            total += 1
            if px[x, y] < 120:
                dark += 1
        return dark / max(1, total)

    def dark_fraction_col(x, y0, y1):
        dark = 0
        step = max(1, (y1 - y0) // 800)
        total = 0
        for y in range(y0, y1, step):
            total += 1
            if px[x, y] < 120:
                dark += 1
        return dark / max(1, total)

    def innermost_line_rows(y_range, windows, reverse):
        """Per x-window, the innermost y in y_range whose row is ≥70% dark."""
        pts = []
        for x0, x1 in windows:
            ys = [y for y in y_range if dark_fraction_row(y, x0, x1) >= 0.7]
            if ys:
                pts.append(((x0 + x1) / 2, max(ys) if not reverse else min(ys)))
        return pts

    def innermost_line_cols(x_range, windows, reverse):
        pts = []
        for y0, y1 in windows:
            xs = [x for x in x_range if dark_fraction_col(x, y0, y1) >= 0.7]
            if xs:
                pts.append((max(xs) if not reverse else min(xs), (y0 + y1) / 2))
        return pts

    # Three sampling windows along each edge, away from the corners.
    xw = [(int(w * f0), int(w * f1)) for f0, f1 in [(0.15, 0.35), (0.4, 0.6), (0.65, 0.85)]]
    yw = [(int(h * f0), int(h * f1)) for f0, f1 in [(0.15, 0.35), (0.4, 0.6), (0.65, 0.85)]]
    top = innermost_line_rows(range(0, band_h), xw, reverse=False)
    bottom = innermost_line_rows(range(h - band_h, h), xw, reverse=True)
    left = innermost_line_cols(range(0, band_w), yw, reverse=False)
    right = innermost_line_cols(range(w - band_w, w), yw, reverse=True)
    if min(len(top), len(bottom), len(left), len(right)) < 2:
        raise SystemExit("neatline auto-detection failed — pass --frame with explicit corner pixels")

    def fit(pts, vertical):
        # least-squares line; vertical edges fitted as x = a*y + b
        if vertical:
            pts = [(y, x) for x, y in pts]
        n = len(pts)
        sx = sum(p[0] for p in pts)
        sy = sum(p[1] for p in pts)
        sxx = sum(p[0] * p[0] for p in pts)
        sxy = sum(p[0] * p[1] for p in pts)
        d = n * sxx - sx * sx
        a = (n * sxy - sx * sy) / d
        b = (sy - a * sx) / n
        return a, b

    ta, tb = fit(top, False)
    ba, bb = fit(bottom, False)
    la, lb = fit(left, True)
    ra, rb = fit(right, True)

    def intersect_h_v(ha, hb, va, vb):
        # y = ha*x + hb ; x = va*y + vb
        y = (ha * vb + hb) / (1 - ha * va)
        x = va * y + vb
        return x, y

    nw = intersect_h_v(ta, tb, la, lb)
    ne = intersect_h_v(ta, tb, ra, rb)
    se = intersect_h_v(ba, bb, ra, rb)
    sw = intersect_h_v(ba, bb, la, lb)
    return nw, ne, se, sw


# ── Pyramid build ────────────────────────────────────────────────────────────

def build(args):
    im = Image.open(args.image).convert("RGBA")
    w, h = im.size
    west, south, east, north = args.bbox

    if args.frame == "auto":
        nw, ne, se, sw = detect_frame(im)
    else:
        v = [float(t) for t in args.frame.split(",")]
        if len(v) != 8:
            raise SystemExit("--frame needs 8 numbers: nwx,nwy,nex,ney,sex,sey,swx,swy")
        nw, ne, se, sw = (v[0], v[1]), (v[2], v[3]), (v[4], v[5]), (v[6], v[7])
    print(f"frame px: NW {tuple(round(c) for c in nw)}  NE {tuple(round(c) for c in ne)}  "
          f"SE {tuple(round(c) for c in se)}  SW {tuple(round(c) for c in sw)}")

    # lon/lat → scan pixel, projective over the four corner pairs.
    hgy = solve_homography(
        [(west, north), (east, north), (east, south), (west, south)],
        [nw, ne, se, sw],
    )

    # Deepest zoom: scan resolution ≈ tile resolution (allow mild upscaling).
    frame_px_w = ((ne[0] - nw[0]) + (se[0] - sw[0])) / 2
    if args.base_zoom:
        base_z = args.base_zoom
    else:
        base_z = 7
        while base_z < 18:
            need = (lon_to_x(east, base_z + 1) - lon_to_x(west, base_z + 1)) * TILE
            if need > frame_px_w * 1.35:
                break
            base_z += 1
    print(f"base zoom {base_z}, min zoom {args.min_zoom}")

    def tile_path(z, x, y):
        return os.path.join(args.out, str(z), str(x), f"{y}.png")

    # Base tiles: output rect ← source quad via mercator corner mapping.
    x0 = math.floor(lon_to_x(west, base_z))
    x1 = math.ceil(lon_to_x(east, base_z))
    y0 = math.floor(lat_to_y(north, base_z))
    y1 = math.ceil(lat_to_y(south, base_z))
    count = 0
    for tx in range(x0, x1):
        for ty in range(y0, y1):
            lon_w, lon_e = x_to_lon(tx, base_z), x_to_lon(tx + 1, base_z)
            lat_n, lat_s = y_to_lat(ty, base_z), y_to_lat(ty + 1, base_z)
            quad = []
            for lon, lat in ((lon_w, lat_n), (lon_w, lat_s), (lon_e, lat_s), (lon_e, lat_n)):
                quad.extend(apply_h(hgy, lon, lat))
            tile = im.transform((TILE, TILE), Image.Transform.QUAD, quad,
                                resample=Image.Resampling.BICUBIC, fillcolor=(0, 0, 0, 0))
            if tile.getbbox() is None:
                continue
            os.makedirs(os.path.dirname(tile_path(base_z, tx, ty)), exist_ok=True)
            tile.save(tile_path(base_z, tx, ty), optimize=True)
            count += 1
    print(f"z{base_z}: {count} tiles")

    # Parents: stitch and halve the four children.
    for z in range(base_z - 1, args.min_zoom - 1, -1):
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
                            parent.paste(Image.open(p), (dx * TILE, dy * TILE))
                            any_child = True
                if not any_child:
                    continue
                os.makedirs(os.path.dirname(tile_path(z, tx, ty)), exist_ok=True)
                parent.resize((TILE, TILE), Image.Resampling.LANCZOS).save(tile_path(z, tx, ty), optimize=True)
                made += 1
        print(f"z{z}: {made} tiles")

    total = 0
    files = 0
    for root, _dirs, names in os.walk(args.out):
        for name in names:
            files += 1
            total += os.path.getsize(os.path.join(root, name))
    print(f"done: {files} tiles, {total / 1e6:.1f} MB → {args.out}")
    print(f"overlay URL template: /{os.path.relpath(args.out, 'public')}/{{z}}/{{x}}/{{y}}.png"
          if args.out.startswith("public/") else f"overlay URL: serve {args.out} and use .../{{z}}/{{x}}/{{y}}.png")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("image")
    ap.add_argument("--bbox", required=True,
                    help="W,S,E,N in decimal degrees (Greenwich) of the neatline corners")
    ap.add_argument("--frame", default="auto",
                    help="'auto' or nwx,nwy,nex,ney,sex,sey,swx,swy scan-pixel corners")
    ap.add_argument("--out", required=True)
    ap.add_argument("--base-zoom", type=int, default=0)
    ap.add_argument("--min-zoom", type=int, default=7)
    args = ap.parse_args()
    args.bbox = [float(t) for t in args.bbox.split(",")]
    if len(args.bbox) != 4:
        raise SystemExit("--bbox needs W,S,E,N")
    build(args)


if __name__ == "__main__":
    sys.exit(main())
