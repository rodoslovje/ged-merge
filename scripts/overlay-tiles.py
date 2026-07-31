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
  --webp           write WebP tiles instead of PNG (≈ 1/3 smaller than --png8
                   at the same detail; alpha stays lossless, so sheet edges
                   and nodata cut cleanly)

Measuring a whole series at once:

  python3 scripts/overlay-tiles.py --manifest sheets.json --write-frames measured.json

detects every sheet's neatline once, checks each against the shape its bbox
implies (a 0.5°×0.25° sheet is 2.013·cos φ times as wide as it is tall, and the
press ran ~0.8% tighter than that), and writes a manifest with the corners
pinned as numbers.  Sheets whose detection failed or whose frame is the wrong
shape are listed and left out, so a bad scan cannot silently smear itself
across the mosaic — build from the written manifest.

Ferro reminder: Austro-Hungarian sheets label longitudes east of Ferro;
Greenwich = Ferro value − 17°39'46" (≈ 17.662783°).
"""

import argparse
import json
import multiprocessing
import math
import os
import sys

from PIL import Image, ImageChops, ImageDraw

Image.MAX_IMAGE_PIXELS = None

TILE = 256
VERBOSE = False


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

EDGES = (("top", True, True), ("bottom", True, False),
         ("left", False, True), ("right", False, False))


def _paper_tone(im: Image.Image):
    """The scan's paper value — the 85th percentile of its histogram."""
    hist = im.histogram()
    limit = sum(hist) * 0.85
    acc = 0
    for value, count in enumerate(hist):
        acc += count
        if acc >= limit:
            return value
    return 255


def printed_size(bbox, dpi, scale_denominator=75000):
    """(width, height) in scan pixels of a sheet's neatline.

    A survey sheet is printed to scale, so its box on the ground fixes its size
    on the paper, and the scan's resolution fixes that in pixels. Nothing about
    the scan itself is consulted — which is the point: it is a prediction the
    detected frame can be held against."""
    west, south, east, north = bbox
    lat = math.radians((south + north) / 2)
    m_lon = 111319.49 * math.cos(lat)
    m_lat = 111132.95 - 559.85 * math.cos(2 * lat) + 1.175 * math.cos(4 * lat)
    px_per_m = dpi / 25.4 * 1000 / scale_denominator
    return ((east - west) * m_lon * px_per_m, (north - south) * m_lat * px_per_m)


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


def _edge_picks(px, w, h, horizontal, near_start, hint=None):
    """(along, across) picks of the innermost border rule, one per chunk.

    `hint` is an optional (position, slope) coarse fix on the rule from
    _rule_candidates: each chunk then only looks within ±HINT_WINDOW px of
    where that line passes, which is what lets the innermost-rule rule resolve
    the *bundle* (neatline, graduation band, outer border) instead of latching
    onto whatever dark thing lies deeper in the margin."""
    length = w if horizontal else h
    depth = h if horizontal else w
    band = max(60, depth // 9)
    chunk = max(120, length // 40)
    picks = []
    for i in range(8):
        s0 = int(length * (0.12 + 0.76 * i / 7)) - chunk // 2
        s0 = max(0, min(length - chunk, s0))
        if hint is None:
            rng = range(0, band) if near_start else range(depth - band, depth)
        else:
            at = hint[0] + hint[1] * (s0 + chunk / 2 - length / 2)
            rng = range(max(0, int(at - HINT_WINDOW)), min(depth, int(at + HINT_WINDOW)))
        # Paper tone within this chunk's band.
        vals = sorted(
            (px[s, p] if horizontal else px[p, s])
            for p in rng[:: max(1, len(rng) // 40)]
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


HINT_WINDOW = 45          # full-res px searched around a coarse rule fix
COARSE_SIDE = 2600        # the scan is reduced to about this before scanning
SKEW_LIMIT = 3            # degrees of scan rotation looked through
SPAN_TOLERANCE = 0.05     # how far a rule pair may sit from the printed size
MARGIN_GAP = (2.0, 8.0)   # mm outside a border rule where the sheet goes blank
BUNDLE_RULES = 10         # rules kept per edge, counted in from the paper edge
PROMINENCE_SPAN = 14      # px either side of a rule where the ink must fall away
ANCHOR_INK = 0.75         # ink fraction that marks a rule as running the whole edge
BUNDLE_DEPTH = 9          # mm from the outer frame within which the neatline lies
FAINT = 0.010             # span error a rule that runs half its edge is worth
INKED = 0.006             # …and one with map rather than margin outside it


def _ink(band: Image.Image, horizontal, scale):
    """Threshold a margin band, then average *along* the rules.

    Thresholding has to happen at full resolution — a hairline survives being
    averaged along its own length, but averaged across it, it turns to paper.
    What comes back is a narrow image whose values are the fraction of ink in
    each run, cheap enough to rotate through a range of angles."""
    paper = _paper_tone(band)
    mask = band.point(lambda v: 255 if v < paper - 38 else 0)
    w, h = mask.size
    size = (max(64, w // scale), h) if horizontal else (w, max(64, h // scale))
    return mask.resize(size, Image.Resampling.BOX)


def _profile(ink: Image.Image, angle, horizontal):
    """Ink fraction per row (or column) of `ink`, read along `angle`.

    A neatline is the only mark that runs the whole width of the sheet, so it
    towers over this profile — but only if the profile is read along the scan's
    own tilt, otherwise a 1° skew smears it over a hundred pixels."""
    if angle:
        ink = ink.rotate(angle, resample=Image.Resampling.NEAREST, fillcolor=0)
    w, h = ink.size
    line = ink.resize((1, h) if horizontal else (w, 1), Image.Resampling.BOX)
    return [v / 255 for v in line.getdata()]


def _peaks(profile, floor=0.45):
    """Rule positions in a darkness profile: local maxima, strongest first.

    A rule is a line, so the profile has to come back down on both sides of it
    within a few pixels. Insisting on that ignores the wide dark plateaus a
    scanner surround leaves around the paper."""
    top = max(profile) if profile else 0
    if top < floor:
        return []
    out = []
    for p, v in enumerate(profile):
        if v < max(floor, top * 0.4):
            continue
        if any(abs(p - q) < 5 for q, _ in out):
            continue
        if v < max(profile[max(0, p - 5):p + 6]):
            continue
        flanks = [profile[max(0, p - PROMINENCE_SPAN):max(1, p - PROMINENCE_SPAN + 6)],
                  profile[p + PROMINENCE_SPAN:p + PROMINENCE_SPAN + 6]]
        if all(f and min(f) > v - 0.2 for f in flanks):
            continue
        out.append((p, v))
    return sorted(out, key=lambda pv: -pv[1])


def _paper_box(gray, scale):
    """The paper's bounding box in a scan photographed against a dark surround.

    Several libraries scan the sheet on a black platen, and that surround is
    darker than any rule — every profile would peak on it. Everything else here
    measures from the paper, so the paper is what the scan gets cropped to."""
    small = gray.reduce(scale) if scale > 1 else gray
    w, h = small.size
    paper = _paper_tone(small)
    lit = small.point(lambda v: 255 if v >= paper - 55 else 0)
    rows = [v / 255 for v in lit.resize((1, h), Image.Resampling.BOX).getdata()]
    cols = [v / 255 for v in lit.resize((w, 1), Image.Resampling.BOX).getdata()]

    def span(profile):
        lit_at = [i for i, v in enumerate(profile) if v >= 0.5]
        return (lit_at[0], lit_at[-1] + 1) if lit_at else (0, len(profile))

    x0, x1 = span(cols)
    y0, y1 = span(rows)
    box = (x0 * scale, y0 * scale, min(gray.size[0], x1 * scale), min(gray.size[1], y1 * scale))
    covered = (box[2] - box[0]) * (box[3] - box[1]) / (gray.size[0] * gray.size[1])
    narrow = (box[2] - box[0]) < gray.size[0] * 0.6 or (box[3] - box[1]) < gray.size[1] * 0.6
    return None if covered > 0.995 or narrow else box


def _margin_outside(profile, p, outward, mm):
    """Is there blank paper a few millimetres outside the rule at `p`?

    Only a border rule has that: past the neatline and its minute ladder the
    sheet goes white until the outer frame, while a road or a contour running
    parallel to the frame has map on both sides. This is what keeps the
    printed-size check from being satisfied by a lucky pair of interior
    lines."""
    near, far = sorted((int(p + outward * MARGIN_GAP[0] * mm),
                        int(p + outward * MARGIN_GAP[1] * mm)))
    window = max(4, int(mm))
    quiet = [sum(profile[i:i + window]) / window
             for i in range(max(0, near), min(len(profile) - window, far))]
    return bool(quiet) and min(quiet) <= 0.15


def _rule_candidates(gray, scale, mm, expect):
    """Coarse fix on the border rules of all four edges.

    Returns {edge: ([(position, strength, graduated)], slope)} — where each
    rule crosses the middle of its edge, how much of that edge it runs, whether
    the minute ladder sits outside it, and the scan's tilt as a slope."""
    w, h = gray.size
    found = {}
    for name, horizontal, near_start in EDGES:
        depth = h if horizontal else w
        # How deep to look: the sheet is a known size, so everything outside it
        # is margin, and the margin is what the border rule can hide in. Sheets
        # with a wide legend panel below the map have margins twice what a
        # fixed fraction would allow for.
        margin = depth - (expect[1] if horizontal else expect[0])
        thick = max(8, int(min(depth * 0.38, max(depth * 0.12, margin + depth * 0.02))))
        if horizontal:
            box = (int(w * 0.12), 0, int(w * 0.88), thick) if near_start else \
                  (int(w * 0.12), h - thick, int(w * 0.88), h)
        else:
            box = (0, int(h * 0.12), thick, int(h * 0.88)) if near_start else \
                  (w - thick, int(h * 0.12), w, int(h * 0.88))
        ink = _ink(gray.crop(box), horizontal, scale)
        offset = 0 if near_start else depth - thick

        def scan(angles):
            # `ink` is squeezed along the rule, so the scan's own tilt appears
            # in it steepened by that factor — the search is over real angles
            # and converts, or a tilt of half a degree would fall outside it.
            best = (0.0, 0.0, [], [])
            for real in angles:
                skewed = math.degrees(math.atan(math.tan(math.radians(real)) * scale))
                profile = _profile(ink, skewed, horizontal)
                peaks = _peaks(profile)
                # Score the angle on the three darkest rules, not the darkest
                # one: the border bundle should come into focus together, and
                # the outer frame alone can be sharpest at a slightly different
                # angle than the neatline that matters.
                sharp = sum(v for _p, v in peaks[:3])
                if sharp > best[1]:
                    best = (real, sharp, peaks, profile)
            return best

        coarse = scan([i / 2 for i in range(-2 * SKEW_LIMIT, 2 * SKEW_LIMIT + 1)])
        angle, _strength, peaks, profile = max(scan([coarse[0] + i / 10 for i in range(-4, 5)]),
                                               coarse, key=lambda b: b[1])
        # The band was rotated about its own centre, so a peak sits where the
        # rule crosses the middle of the edge; only |slope| is known from this,
        # and both senses are tried when the rule is fitted at full size.
        # Keep the outermost rules rather than the darkest: the neatline is
        # always among the first few lines in from the paper edge, while the
        # long straight things that rival it for ink — roads, contours, railway
        # lines — lie deeper in, and would otherwise crowd it out. The first
        # couple of millimetres are not rules at all but the cut edge of the
        # scan, so they do not get to fill the quota.
        outward = -1 if near_start else 1
        edge = 2 * mm if near_start else len(profile) - 1 - 2 * mm
        peaks = [(p, v) for p, v in peaks if (p > edge if near_start else p < edge)]
        peaks = sorted(peaks, key=lambda pv: pv[0] * outward, reverse=True)[:BUNDLE_RULES]
        found[name] = ([(p + offset, v, _margin_outside(profile, p, outward, mm))
                        for p, v in peaks], math.tan(math.radians(angle)))
    return found


def _pick_pair(near, far, span):
    """The (near-edge, far-edge) rule pair whose spacing is the printed one.

    Spacing decides it outright and ink only breaks ties: the border bundle's
    rules all run the full length of the sheet, so the darkest of them is as
    often the outer one as the neatline, but only the neatline pair is the
    printed distance apart."""
    best = None
    for pn, sn, gn in near:
        for pf, sf, gf in far:
            if pf - pn <= 0:
                continue
            err = abs((pf - pn) / span - 1)
            if err > SPAN_TOLERANCE:
                continue
            score = (err + FAINT * ((1 - sn) + (1 - sf))
                     + INKED * ((not gn) + (not gf)))
            if best is None or score < best[0]:
                best = (score, pn, pf)
    return best[1:] if best else None


def _bundle_pick(cands, mm, outward):
    """The neatline when the printed size cannot say which rule it is.

    A catalogue's "600 dpi" is sometimes 450, and then no pair of rules sits
    the predicted distance apart. What still holds is the sheet's layout: the
    outermost full-length rule is the outer frame, and the neatline is the
    innermost rule of the bundle that follows it within a centimetre."""
    if not cands:
        return None
    anchor = next((p for p, v, _m in cands if v >= ANCHOR_INK), cands[0][0])
    inward = -outward
    within = [p for p, v, _m in cands
              if 0 <= (p - anchor) * inward <= BUNDLE_DEPTH * mm and v >= 0.5]
    return max(within, key=lambda p: (p - anchor) * inward) if within else anchor


def detect_frame(im: Image.Image, expect=None):
    """Neatline corners of a scanned sheet, as (nw, ne, se, sw) pixel pairs.

    `expect` is the sheet's printed size in scan pixels — known whenever the
    sheet's geographic box and the scan's resolution are (see printed_size).
    With it, the border rules are located by looking for the pair that sits the
    printed distance apart, which no interior line can fake; without it, the
    innermost long rule per edge is taken on its own, which is only reliable on
    a clean single sheet."""
    g = im.convert("L")
    origin = (0, 0)
    if expect:
        paper = _paper_box(g, max(1, round(max(g.size) / COARSE_SIDE)))
        if paper:
            g = g.crop(paper)
            origin = (paper[0], paper[1])
    w, h = g.size
    hints = {}
    if expect:
        # 0.25° of latitude is 368.7 mm of paper at 1:75 000 — the scale that
        # turns the sheet layout's millimetres into this scan's pixels.
        found = _rule_candidates(g, max(1, round(max(w, h) / COARSE_SIDE)),
                                 expect[1] / 368.7, expect)
        mm = expect[1] / 368.7
        for (a, b), span in (("left", "right"), expect[0]), (("top", "bottom"), expect[1]):
            pair = _pick_pair(found[a][0], found[b][0], span)
            if pair is None:
                pair = (_bundle_pick(found[a][0], mm, -1), _bundle_pick(found[b][0], mm, 1))
                if None in pair:
                    raise SystemExit(f"no {a} or {b} border rule found — the scan may be cropped "
                                     f"inside its neatline, or is not this sheet")
            hints[a] = (pair[0], found[a][1])
            hints[b] = (pair[1], found[b][1])

    px = g.load()
    edges = {}
    for name, horizontal, near_start in EDGES:
        picks = _edge_picks(px, w, h, horizontal, near_start, hints.get(name))
        if len(picks) < 3:
            raise SystemExit(f"neatline detection failed on the {name} edge — pass --frame")
        edges[name] = _fit_with_rejection(picks)[:2]

    def cross(hline, vline):
        ha, hb = hline  # y = ha·x + hb
        va, vb = vline  # x = va·y + vb
        y = (ha * vb + hb) / (1 - ha * va)
        return va * y + vb, y

    ox, oy = origin
    return tuple((x + ox, y + oy) for x, y in (
        cross(edges["top"], edges["left"]), cross(edges["top"], edges["right"]),
        cross(edges["bottom"], edges["right"]), cross(edges["bottom"], edges["left"])))


# ── Sheets ───────────────────────────────────────────────────────────────────

class Sheet:
    """One sheet: geometry up front, pixels loaded lazily — a large mosaic
    holds only the sheet currently being rendered in memory."""

    def __init__(self, image_path, bbox, frame, rotate=0, conic=None, origin=(0, 0), dpi=0):
        self.path = image_path
        self.bbox = bbox  # (west, south, east, north)
        self.rotate = rotate
        self._im = None
        # A conic sheet is one pane of a single large scan: it carries the
        # whole map's projection plus its own pixel origin within that scan,
        # so panes need no per-sheet geometry of their own.
        self.conic = conic
        self.origin = origin
        self.dpi = dpi
        self.frame_arg = frame
        if conic is not None:
            self.corners = None
            with Image.open(image_path) as probe:
                self.frame_px_w = probe.size[0]
            print(f"{os.path.basename(image_path)}: conic pane at {tuple(origin)}, "
                  f"bbox {tuple(round(v, 3) for v in bbox)}", flush=True)
            return
        if frame == "auto":
            nw, ne, se, sw = detect_frame(self.load(), printed_size(bbox, dpi) if dpi else None)
            self.unload()  # a mosaic holds one scan at a time — see render_into
        else:
            v = [float(t) for t in frame]
            nw, ne, se, sw = (v[0], v[1]), (v[2], v[3]), (v[4], v[5]), (v[6], v[7])
        self.corners = (nw, ne, se, sw)
        # Keep the corners as plain numbers too: a worker process rebuilds the
        # sheet from these rather than detecting the neatline all over again.
        self.frame_arg = [v for corner in self.corners for v in corner]
        self.dpi = dpi
        west, south, east, north = bbox
        self.h = solve_homography(
            [(west, north), (east, north), (east, south), (west, south)],
            [nw, ne, se, sw],
        )
        self.frame_px_w = ((ne[0] - nw[0]) + (se[0] - sw[0])) / 2
        if frame == "auto" and VERBOSE:
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

def tile_path(out, ext, z, x, y):
    return os.path.join(out, str(z), str(x), f"{y}.{ext}")


def save_tile(img, path, png8=False, webp=0):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if webp:
        # Lossy RGB, lossless alpha (libwebp's default): the sheet edge stays a
        # hard cut while the engraving compresses like the photograph of paper
        # that it is.
        img.save(path, format="WEBP", quality=webp, method=4)
    elif png8:
        # Quantized palette PNG ≈ 2-3× smaller; these near-monochrome scans
        # lose nothing visible at 255 colours + 1 transparent.
        img.quantize(colors=255, method=Image.Quantize.FASTOCTREE).save(path, optimize=True)
    else:
        img.save(path, optimize=True)


def _render_base(job):
    """One sheet's base-zoom tiles. Module level and taking plain data, so a
    process pool can run several sheets at once — see `build`."""
    spec, out, ext, base_z, png8, webp = job
    sheet = Sheet(spec["image"], tuple(spec["bbox"]), spec.get("frame", "auto"),
                  rotate=spec.get("rotate", 0), dpi=spec.get("dpi", 0))
    sx0 = math.floor(lon_to_x(sheet.bbox[0], base_z))
    sx1 = math.ceil(lon_to_x(sheet.bbox[2], base_z))
    sy0 = math.floor(lat_to_y(sheet.bbox[3], base_z))
    sy1 = math.ceil(lat_to_y(sheet.bbox[1], base_z))
    made = 0
    for tx in range(sx0, sx1):
        for ty in range(sy0, sy1):
            path = tile_path(out, ext, base_z, tx, ty)
            tile = (Image.open(path).convert("RGBA") if os.path.exists(path)
                    else Image.new("RGBA", (TILE, TILE), (0, 0, 0, 0)))
            sheet.render_into(tile, tx, ty, base_z)
            if tile.getbbox() is None:
                continue
            save_tile(tile, path, png8, webp)
            made += 1
    sheet.unload()
    return os.path.basename(sheet.path), made


def _wave(sheet):
    """Which parallel wave a sheet belongs to.

    Two sheets two grid steps apart cannot share a tile, so colouring the
    sheet grid like a chessboard of 2×2 blocks gives four waves whose members
    never write the same file — the seam tiles that neighbours composite into
    are the whole reason the base pass is otherwise serial."""
    west, south = sheet.bbox[0], sheet.bbox[1]
    return (round(west / (sheet.bbox[2] - west)) % 2,
            round(south / (sheet.bbox[3] - south)) % 2)


def build(sheets, out, base_zoom, min_zoom, png8=False, webp=0, jobs=1):
    west = min(s.bbox[0] for s in sheets)
    south = min(s.bbox[1] for s in sheets)
    east = max(s.bbox[2] for s in sheets)
    north = max(s.bbox[3] for s in sheets)

    base_z = base_zoom or max(s.natural_zoom() for s in sheets)
    print(f"{len(sheets)} sheet(s), base zoom {base_z}, min zoom {min_zoom}", flush=True)

    ext = "webp" if webp else "png"

    # Base tiles, one sheet at a time (only one scan in memory): a tile that
    # already exists on disk (a neighbour's edge) is composited into.
    count = 0
    done = 0
    for wave in sorted({_wave(s) for s in sheets}):
        jobs_ = [({"image": s.path, "bbox": s.bbox, "frame": s.frame_arg,
                   "rotate": s.rotate, "dpi": s.dpi}, out, ext, base_z, png8, webp)
                 for s in sheets if _wave(s) == wave]
        if jobs > 1 and len(jobs_) > 1:
            with multiprocessing.Pool(min(jobs, len(jobs_))) as pool:
                results = pool.imap_unordered(_render_base, jobs_)
                results = list(results)
        else:
            results = [_render_base(j) for j in jobs_]
        for name, made in results:
            count += made
            done += 1
            print(f"  [{done}/{len(sheets)}] {name}: {made} tiles", flush=True)
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
                        p = tile_path(out, ext, z + 1, tx * 2 + dx, ty * 2 + dy)
                        if os.path.exists(p):
                            parent.paste(Image.open(p).convert("RGBA"), (dx * TILE, dy * TILE))
                            any_child = True
                if not any_child:
                    continue
                save_tile(parent.resize((TILE, TILE), Image.Resampling.LANCZOS),
                          tile_path(out, ext, z, tx, ty), png8, webp)
                made += 1
        print(f"z{z}: {made} tiles", flush=True)

    total = 0
    files = 0
    for root, _dirs, names in os.walk(out):
        for name in names:
            files += 1
            total += os.path.getsize(os.path.join(root, name))
    print(f"done: {files} tiles, {total / 1e6:.1f} MB → {out}")
    print(f"overlay URL template: /{os.path.relpath(out, 'public')}/{{z}}/{{x}}/{{y}}.{ext}"
          if out.startswith("public/") else f"overlay URL: serve {out} and use .../{{z}}/{{x}}/{{y}}.{ext}")


# ── Frame measurement (whole series at once) ─────────────────────────────────

# The 165 hand-measured Spezialkarte frames come out 0.3% narrower than
# printed_size predicts (paper and press run a little tight) and scatter within
# ±1.5% of that, so 3% is a gate that passes every honest scan and fails a
# mis-detection.
PRESS_SHRINK = 0.9973
ASPECT_TOLERANCE = 0.03


def expected_aspect(bbox):
    width, height = printed_size(bbox, 600)
    return width / height * PRESS_SHRINK


def _measure(job):
    """One sheet's neatline, checked against the shape its bbox implies."""
    entry, path = job
    label = entry.get("id") or os.path.basename(path)
    if not os.path.exists(path):
        return label, None, "scan missing"
    try:
        sheet = Sheet(path, tuple(entry["bbox"]), "auto", rotate=entry.get("rotate", 0),
                      dpi=entry.get("dpi", 0))
    except (SystemExit, OSError, ValueError) as exc:
        return label, None, str(exc)
    (nw, ne, se, sw) = sheet.corners
    width = ((ne[0] - nw[0]) + (se[0] - sw[0])) / 2
    height = ((sw[1] - nw[1]) + (se[1] - ne[1])) / 2
    if width <= 0 or height <= 0:
        return label, None, "frame corners out of order"
    off = width / height / expected_aspect(entry["bbox"]) - 1
    if abs(off) > ASPECT_TOLERANCE:
        return label, None, (f"frame is {off * 100:+.1f}% off the expected shape "
                             f"({round(width)}×{round(height)} px)")
    out = dict(entry)
    out["frame"] = [round(v, 1) for corner in (nw, ne, se, sw) for v in corner]
    out["frameOff"] = round(off, 4)
    return label, out, f"{round(width)}×{round(height)} px, {off * 100:+.1f}%"


def write_frames(spec, base, out_path, jobs=1):
    """Measure every sheet's neatline once and pin it into a new manifest.

    Detection is per-sheet and fallible — a torn margin or a pencil line can
    fool it — so each result is checked against the shape the sheet's bbox
    implies. Sheets that fail are reported and dropped rather than built."""
    if spec.get("conic"):
        raise SystemExit("--write-frames is for gridded sheets; a conic manifest has no neatlines")

    todo = [(entry, entry["image"] if os.path.isabs(entry["image"])
             else os.path.join(base, entry["image"])) for entry in spec["sheets"]]
    if jobs > 1:
        with multiprocessing.Pool(min(jobs, len(todo))) as pool:
            results = list(pool.imap(_measure, todo))
    else:
        results = [_measure(job) for job in todo]

    kept, rejected = [], []
    for i, (label, out, note) in enumerate(results, 1):
        if out is None:
            rejected.append((label, note))
        else:
            kept.append(out)
            print(f"  [{i}/{len(todo)}] {label}: {note}", flush=True)

    measured = dict(spec, sheets=kept)
    json.dump(measured, open(out_path, "w"), ensure_ascii=False, indent=1)
    print(f"\nmeasured {len(kept)} sheet(s) → {out_path}")
    if rejected:
        print(f"{len(rejected)} sheet(s) left out — measure these by hand and add them back:")
        for label, why in rejected:
            print(f"  {label}: {why}")
    return 1 if rejected else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("image", nargs="?")
    ap.add_argument("--manifest", help="JSON with a sheets list for a multi-sheet mosaic")
    ap.add_argument("--bbox", help="W,S,E,N in decimal degrees (Greenwich) of the neatline corners")
    ap.add_argument("--frame", default="auto",
                    help="'auto' or nwx,nwy,nex,ney,sex,sey,swx,swy scan-pixel corners")
    ap.add_argument("--out", help="tile pyramid directory (not needed with --write-frames)")
    ap.add_argument("--base-zoom", type=int, default=0)
    ap.add_argument("--min-zoom", type=int, default=7)
    ap.add_argument("--png8", action="store_true",
                    help="quantize tiles to 255-colour palette PNGs (≈2-3× smaller)")
    ap.add_argument("--webp", nargs="?", type=int, const=75, default=0, metavar="QUALITY",
                    help="write WebP tiles at this quality (default 75) instead of PNG")
    ap.add_argument("--jobs", type=int, default=1,
                    help="sheets rendered at once (each holds one scan in memory)")
    ap.add_argument("--write-frames", metavar="OUT.json",
                    help="measure each manifest sheet's neatline, check it, and write a "
                         "manifest with the corners pinned — no tiles are built")
    args = ap.parse_args()
    if args.write_frames and not args.manifest:
        raise SystemExit("--write-frames measures the sheets of a --manifest")
    if not args.write_frames and not args.out:
        raise SystemExit("--out is required")

    sheets = []
    if args.manifest:
        spec = json.load(open(args.manifest))
        base = os.path.dirname(os.path.abspath(args.manifest))
        if args.write_frames:
            return write_frames(spec, base, args.write_frames, args.jobs)
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

    build(sheets, args.out, args.base_zoom, args.min_zoom, png8=args.png8, webp=args.webp,
          jobs=args.jobs)


if __name__ == "__main__":
    sys.exit(main())
