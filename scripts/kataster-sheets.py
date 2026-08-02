#!/usr/bin/env python3
"""Franciscean cadastre (1823-1869) → an overlay-tiles.py manifest.

The Archives of the Republic of Slovenia publish the whole Franciscean
cadastre in the Virtual Archival Reading Room (VAČ, vac.sjas.gov.si), one
record per sheet, scans open to anyone:

    SI AS 176  Carniola      SI AS 177  Styria
    SI AS 178  Carinthia     SI AS 179  Littoral

This script walks that tree for a cadastral municipality (k.o.), downloads its
sheets, works out where each one belongs, and writes a `cassini` manifest for
scripts/overlay-tiles.py.

Where a sheet belongs is not guessed from control points. Each sheet is one
cell of the survey's own lattice: the land was divided into sections one
Austrian post mile square (4000 klafter), each section into 4 sheet columns of
1000 klafter lettered a-d from its eastern edge westward and 5 sheet rows of
800 klafter lettered e-i from north to south, all on Cassini-Soldner about the
crown land's origin (Krim, for Carniola). Every sheet prints that designation
in its top margin — "W.C.II.14.ag" is West column II, section row 14, sheet a
of row g. So a sheet places itself, and the modern cadastre is used only to
decide *which* section a k.o. sits in, never to warp anything.

Two readings of the printed designation are tried, and they check each other:

  * OCR of the top margin. The trailing letter pair comes out reliably; the
    Roman and Arabic section numbers often do not, which does not matter —
    the letter pair fixes the cell modulo the section (4 x 5 cells, 7.6 km
    square) and a k.o. is smaller than that, so the modern boundary picks the
    section without ambiguity.
  * Failing that, the shape of the ink. A sheet draws its own k.o. and leaves
    the rest of the paper blank, so the drawn area on a sheet is the k.o.
    clipped to one cell; scoring every sheet against every candidate cell and
    taking the best one-to-one assignment places the rest.

Sheets that neither reading can place are listed in --review and left out of
the manifest rather than dropped somewhere plausible.

Usage:

  # one k.o., by its VAČ record id (the id= in the details URL) or by name
  python3 scripts/kataster-sheets.py --ko-id 227431 --scans scans/ \\
      --manifest scripts/manifests/kataster-gradac.json --name GRADAC

  # a whole fond, one manifest per k.o. under --manifest-dir
  python3 scripts/kataster-sheets.py --fond 176 --scans scans/ \\
      --manifest-dir scripts/manifests/kataster/ --review review.txt

Then build as usual:

  python3 scripts/overlay-tiles.py --manifest scripts/manifests/kataster-gradac.json \\
      --out public/tiles-local/kataster-gradac --min-zoom 12 --webp
"""

import argparse
import importlib.util
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile

from PIL import Image, ImageChops, ImageDraw, ImageOps

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("overlay_tiles",
                                               os.path.join(_HERE, "overlay-tiles.py"))
ot = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ot)

Cassini, SHEET_W, SHEET_H = ot.Cassini, ot.SHEET_W, ot.SHEET_H

VAC = "https://vac.sjas.gov.si"
GURS_KO = ("https://ipi.eprostor.gov.si/wfs-si-gurs-kn/ogc/features/collections/"
           "SI.GURS.KN:KATASTRSKE_OBCINE/items?f=application%2Fgeo%2Bjson&limit=2000")

# Cassini-Soldner origins of the cadastral crown-land systems. The Franciscean
# survey of Carniola, Carinthia and the Littoral was computed from the
# first-order point on Krim, 13 km south of Ljubljana; Styria from Schöckelberg
# above Graz. `shift` is the one constant correction applied — see
# scripts/manifests/README.md for how it is measured and why nothing else is.
ORIGINS = {
    "krim": dict(lat0=45.928944, lon0=14.474694, shift=[0.0, 0.0]),
    "schoeckelberg": dict(lat0=47.198639, lon0=15.469167, shift=[0.0, 0.0]),
}
FOND_ORIGIN = {"176": "krim", "178": "krim", "179": "krim", "177": "schoeckelberg"}
FOND_ID = {"176": 23253, "177": 23254, "178": 23255, "179": 23256}

# A cadastral sheet is 800 klafter of ground at 1:2880 — 526.8 mm of paper.
PRINTED_MM = SHEET_H / 2880 * 1000

CELL_PX = 24.0                              # metres per pixel of the placement raster
CW, CH = round(SHEET_W / CELL_PX), round(SHEET_H / CELL_PX)

DESIGNATION = re.compile(r"([a-d])\s*([e-i])\s*[.,]?\s*$")


# ── VAČ ──────────────────────────────────────────────────────────────────────
# Everything goes through curl: it is on every machine this runs on, it retries
# and resumes, and it does not depend on the interpreter having a CA bundle.

def fetch(url, path, force=False):
    if os.path.exists(path) and os.path.getsize(path) > 0 and not force:
        return path
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    tmp = path + ".part"
    r = subprocess.run(["curl", "-sSf", "--retry", "3", "--retry-delay", "2",
                        "--max-time", "300", "-o", tmp, url], capture_output=True, text=True)
    if r.returncode != 0:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise RuntimeError("fetch failed: %s\n%s" % (url, r.stderr.strip()))
    os.replace(tmp, path)
    return path


class Vac:
    """The archive's tree. A details page names only its first child and its
    two siblings, so a level is walked by following `next` from that child."""

    def __init__(self, cache):
        self.cache = cache
        os.makedirs(cache, exist_ok=True)

    def page(self, uid):
        path = os.path.join(self.cache, "d%s.html" % uid)
        fetch("%s/vac/search/details?id=%s" % (VAC, uid), path)
        return open(path, encoding="utf-8", errors="replace").read()

    def record(self, uid):
        h = self.page(uid)
        text = re.sub(r"(?s)<script.*?</script>", "", h)
        lines = [x.strip() for x in re.sub(r"(?s)<[^>]+>", "\n", text).split("\n") if x.strip()]
        fields = {}
        for i, line in enumerate(lines[:-1]):
            if line.endswith(":"):
                fields.setdefault(line[:-1], lines[i + 1])
        def first(div):
            j = h.find('id="%s"' % div)
            if j < 0:
                return None
            m = re.search(r'data-id="(\d+)"', h[j:j + 400000])
            return m.group(1) if m else None
        return dict(
            id=uid,
            sig=fields.get("Signatura PE", ""),
            title=fields.get("Naslov PE", ""),
            level=fields.get("Nivo popisa", ""),
            child=first("archivePlanTreeChildData"),
            next=first("archivePlanTreeNextData"),
            docids=sorted({m[2] for m in re.findall(
                r"fileStream\?type=(\d+)&amp;uodid=(\d+)&amp;docid=(\d+)&amp;seq=(\d+)", h)}),
        )

    def children(self, uid, limit=4000):
        rec = self.record(uid)
        out = []
        cur = rec["child"]
        while cur and len(out) < limit:
            child = self.record(cur)
            out.append(child)
            cur = child["next"]
        return out

    def scan_url(self, uid):
        # docid 10 is the sheet itself; 9 is a thumbnail of it.
        return "%s/vac/util/fileStream?type=2&uodid=%s&docid=10&seq=1" % (VAC, uid)


def ko_sheets(vac, ko_uid):
    """The image records under a k.o.'s `grafični` (graphic) group."""
    graphic = [c for c in vac.children(ko_uid) if "grafi" in c["title"].lower()]
    if not graphic:
        rec = vac.record(ko_uid)
        if "grafi" in rec["title"].lower():
            graphic = [rec]
    if not graphic:
        return []
    return [s for s in vac.children(graphic[0]["id"]) if "10" in s["docids"]]


# ── the modern cadastre, used only to say which section a k.o. is in ─────────

def gurs_all(cache):
    """Every cadastral municipality boundary in force today, paged in."""
    path = os.path.join(cache, "gurs-ko.json")
    if not os.path.exists(path):
        features, start = [], 0
        while True:
            page = os.path.join(cache, "gurs-ko-%d.part.json" % start)
            fetch(GURS_KO + "&startIndex=%d" % start, page)
            data = json.load(open(page, encoding="utf-8"))
            features.extend(data["features"])
            os.remove(page)
            start += len(data["features"])
            if not data["features"] or start >= data.get("numberMatched", 0):
                break
        json.dump({"features": features}, open(path, "w", encoding="utf-8"))
    return json.load(open(path, encoding="utf-8"))["features"]


def gurs_polygon(name, cache, sifko=None, near=None):
    """The named k.o.'s rings today.

    Names repeat across Slovenia — there is a Stražišče by Kranj and another in
    Styria — so a caller that knows the crown land passes `near` and the
    candidate closest to it wins. That choice only picks which section of the
    lattice a k.o. sits in; it never moves a sheet inside it.
    """
    feats = gurs_all(cache)
    want = name.strip().upper()
    if sifko:
        hits = [f for f in feats if str(f["properties"]["SIFKO"]) == str(sifko)]
    else:
        hits = [f for f in feats if f["properties"]["NAZIV"].strip().upper() == want]
        if not hits:
            hits = [f for f in feats
                    if f["properties"]["NAZIV"].strip().upper().startswith(want)]
    if not hits:
        return None, None
    if len(hits) > 1 and near:
        hits.sort(key=lambda f: _distance(_centroid(f), near))
    rings = [ring for ring in _rings(hits[0]["geometry"]["coordinates"])]
    others = [h["properties"]["SIFKO"] for h in hits[1:]]
    return rings, dict(sifko=hits[0]["properties"]["SIFKO"], alternatives=others)


def _centroid(feature):
    pts = [p for ring in _rings(feature["geometry"]["coordinates"]) for p in ring]
    return (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))


def _distance(a, b):
    return math.hypot((a[0] - b[0]) * math.cos(math.radians(a[1])) * 111.3, (a[1] - b[1]) * 111.1)


def _rings(coords):
    if isinstance(coords[0][0], (int, float)):
        yield coords
    else:
        for part in coords:
            yield from _rings(part)


# ── placing the sheets ───────────────────────────────────────────────────────

def frames(paths):
    """Neatline corners per scan, with the scans holding each other honest.

    A sheet is printed to scale, so every scan of a series is at one
    resolution and every frame is the same size in pixels. Detection is run
    once per scan; the sheets whose frame comes out the right shape set that
    size, and a scan whose own detection is off-shape (or failed) is given the
    agreed rectangle, hung on the corner and the top-edge angle it did find.
    """
    raw, sizes = {}, []
    for path in paths:
        with Image.open(path) as im:
            try:
                corners = ot.detect_frame(im.convert("RGBA"), printed_mm=PRINTED_MM)
            except SystemExit:
                raw[path] = None
                continue
        raw[path] = corners
        w, h = _frame_size(corners)
        if abs((w / h) / (SHEET_W / SHEET_H) - 1) < 0.02:
            sizes.append((w, h))
    if not sizes:
        return {p: None for p in paths}
    med_w = sorted(w for w, _h in sizes)[len(sizes) // 2]
    med_h = med_w * SHEET_H / SHEET_W
    # Second pass for the scans that found nothing: now that the series' own
    # frame size is known, detection can be told what to look for, which is
    # what gets a border rule out of a wide blank margin or a faint edge.
    for path, corners in list(raw.items()):
        if corners is not None:
            continue
        with Image.open(path) as im:
            rgba = im.convert("RGBA")
        for pad in (0, 150):
            # Some sheets were trimmed to within a few pixels of their border
            # rule, and a rule with no paper outside it does not read as a
            # rule. Giving the scan a margin of its own paper tone back is
            # enough for the same detector to find it.
            probe, off = rgba, (0, 0)
            if pad:
                tone = probe.resize((1, 1)).getpixel((0, 0))
                probe = Image.new("RGBA", (rgba.width + 2 * pad, rgba.height + 2 * pad), tone)
                probe.paste(rgba, (pad, pad))
                off = (-pad, -pad)
            try:
                found = ot.detect_frame(probe, expect=(med_w, med_h), printed_mm=PRINTED_MM)
                raw[path] = tuple((x + off[0], y + off[1]) for x, y in found)
                break
            except SystemExit:
                raw[path] = None
    out = {}
    for path, corners in raw.items():
        if corners is None:
            out[path] = None
            continue
        w, h = _frame_size(corners)
        if abs((w / h) / (SHEET_W / SHEET_H) - 1) < 0.02:
            out[path] = corners
        else:
            out[path] = _rectangle(corners, med_w, med_h)
    return out


def _frame_size(corners):
    nw, ne, se, sw = corners
    return (((ne[0] - nw[0]) + (se[0] - sw[0])) / 2,
            ((sw[1] - nw[1]) + (se[1] - ne[1])) / 2)


def _rectangle(corners, w, h):
    nw, ne, _se, _sw = corners
    dx, dy = ne[0] - nw[0], ne[1] - nw[1]
    n = math.hypot(dx, dy) or 1.0
    ux, uy = dx / n, dy / n
    vx, vy = -uy, ux
    at = lambda a, b: (nw[0] + ux * a + vx * b, nw[1] + uy * a + vy * b)
    return at(0, 0), at(w, 0), at(w, h), at(0, h)


def read_designation(path, corners):
    """The sheet's own letter pair, off the printed designation in its margin.

    Only the pair is asked for. It is the part of the designation that is set
    in the largest type and survives OCR of a hand-tinted 200-year-old scan;
    the section's Roman and Arabic numbers rarely do, and are not needed.
    """
    if not shutil.which("tesseract"):
        return None
    with Image.open(path) as im:
        # The designation is set at the right-hand end of the top margin —
        # sometimes just above the border rule, sometimes just inside it.
        top = corners[0][1] if corners else im.height * 0.04
        band = im.convert("L").crop((int(im.width * 0.45), 0, im.width, int(top + 0.05 * im.height)))
    if band.height < 20:
        return None
    band = ImageOps.autocontrast(band.resize((band.width * 2, band.height * 2), Image.LANCZOS))
    with tempfile.TemporaryDirectory() as tmp:
        png = os.path.join(tmp, "band.png")
        band.save(png)
        for psm in ("11", "6", "7"):
            out = subprocess.run(["tesseract", png, "stdout", "--psm", psm],
                                 capture_output=True, text=True).stdout
            for token in reversed(re.split(r"[\s|]+", " ".join(out.split()))):
                m = DESIGNATION.search(token.strip().lower())
                if m:
                    return m.group(1), m.group(2)
    return None


def cell_of(letters):
    """Letter pair → the cell's position within its section, as
    (ix mod 4, iy mod 5). Columns run a-d east to west, rows e-i north to
    south, and a section is 4 cells by 5."""
    col, row = letters
    return 3 - "abcd".index(col), 4 - "efghi".index(row)


def drawn_mask(path, corners):
    """Where a scan carries map, per cell-raster pixel.

    Colour, not ink: a surveyed parcel is washed green, tan or grey and bare
    paper is not, while the neighbouring municipalities' names — set across the
    blank margins in large capitals — are black on cream and leave the wash
    alone. Measuring saturation therefore returns the k.o. and not the
    lettering around it.
    """
    with Image.open(path) as im:
        nw, ne, se, sw = corners
        quad = [nw[0], nw[1], sw[0], sw[1], se[0], se[1], ne[0], ne[1]]
        rgb = im.convert("RGB").transform((CW * 4, CH * 4), Image.Transform.QUAD, quad,
                                          resample=Image.Resampling.BILINEAR)
    bands = rgb.split()
    lo = hi = bands[0]
    for b in bands[1:]:
        lo = ImageChops.darker(lo, b)
        hi = ImageChops.lighter(hi, b)
    sat = ImageChops.subtract(hi, lo).resize((CW, CH), Image.BILINEAR)
    px = list(sat.getdata())
    top = max(px) or 1
    return [v / top for v in px]


def cell_masks(cass, rings, pad=SHEET_W):
    """Candidate cells, each with the k.o. rasterised inside it.

    The net is cast a whole sheet wider than today's boundary: municipalities
    have been split and trimmed since 1826, and a sheet drawing ground the k.o.
    has since lost would otherwise have nowhere to go."""
    pts = [cass.fwd(lon, lat) for ring in rings for lon, lat in ring]
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    out = {}
    for ix in range(math.floor((min(xs) - pad) / SHEET_W), math.floor((max(xs) + pad) / SHEET_W) + 1):
        for iy in range(math.floor((min(ys) - pad) / SHEET_H), math.floor((max(ys) + pad) / SHEET_H) + 1):
            w0, n0 = ix * SHEET_W, (iy + 1) * SHEET_H
            img = Image.new("L", (CW, CH), 0)
            d = ImageDraw.Draw(img)
            for ring in rings:
                d.polygon([((x - w0) / CELL_PX, (n0 - y) / CELL_PX)
                           for x, y in (cass.fwd(lon, lat) for lon, lat in ring)], fill=255)
            data = [v / 255 for v in img.getdata()]
            if sum(data) / len(data) > 0.02:
                out[(ix, iy)] = data
    return out


def _correlate(a, b):
    ma, mb = sum(a) / len(a), sum(b) / len(b)
    num = sum((x - ma) * (y - mb) for x, y in zip(a, b))
    da = math.sqrt(sum((x - ma) ** 2 for x in a))
    db = math.sqrt(sum((y - mb) ** 2 for y in b))
    return num / (da * db) if da and db else 0.0


LETTER_BONUS = 0.30
ORDER_BONUS = 0.15


def place(sheets, cass, rings, min_score=0.06):
    """Sheet → lattice cell, decided by three readings at once.

    None of the three is trusted alone. The wash on a sheet says which part of
    the k.o. it draws; the printed letter pair says where in its section the
    sheet sits, which the modern boundary turns into one cell; and the archive
    filed the sheets in raster order, north row first and west to east inside a
    row, which says roughly where in the sequence each sheet belongs. They are
    scored together and settled as one assignment, so a single misread letter
    is outvoted rather than dragging its sheet somewhere else.
    """
    cells = cell_masks(cass, rings)
    usable = [s for s in sheets if s["corners"] is not None]
    if not cells or not usable:
        return ([dict(s, cell=None, how="no frame", score=0.0) for s in sheets],
                None if cells else "the modern k.o. covers no lattice cell")
    order = sorted(cells, key=lambda c: (-c[1], c[0]))   # north row first, then west to east
    rank = {c: i for i, c in enumerate(order)}
    table = {}
    for i, s in enumerate(usable):
        mask = drawn_mask(s["path"], s["corners"])
        for c in cells:
            v = _correlate(mask, cells[c])
            if s.get("letters") and (c[0] % 4, c[1] % 5) == cell_of(s["letters"]):
                v += LETTER_BONUS
            if len(usable) > 1 and len(order) > 1:
                v += ORDER_BONUS * (1 - abs(rank[c] / (len(order) - 1) - i / (len(usable) - 1)))
            table[(s["id"], c)] = v
    chosen = _assign(usable, list(cells), table)

    placed = []
    for s in sheets:
        if s["corners"] is None:
            placed.append(dict(s, cell=None, how="no frame", score=0.0))
            continue
        cell = chosen.get(s["id"])
        raw = _correlate(drawn_mask(s["path"], s["corners"]), cells[cell]) if cell else 0.0
        if cell is None or raw < min_score:
            placed.append(dict(s, cell=None, how="unplaced", score=raw))
            continue
        how = ("printed %s%s" % s["letters"]
               if s.get("letters") and (cell[0] % 4, cell[1] % 5) == cell_of(s["letters"])
               else "wash shape")
        placed.append(dict(s, cell=cell, how=how, score=raw))
    return placed, None


def _assign(sheets, cells, table):
    """Best one-to-one sheet→cell assignment: greedy, then swaps until no pair
    of sheets would rather trade. Exact enough at a dozen sheets, and it keeps
    this script to Pillow."""
    free = list(cells)
    chosen = {}
    for s in sorted(sheets, key=lambda s: -max(table[(s["id"], c)] for c in cells)):
        if not free:
            break
        best = max(free, key=lambda c: table[(s["id"], c)])
        free.remove(best)
        chosen[s["id"]] = best
    ids = list(chosen)
    for _ in range(len(ids) * len(ids)):
        improved = False
        for i, a in enumerate(ids):
            for b in ids[i + 1:]:
                now = table[(a, chosen[a])] + table[(b, chosen[b])]
                swap = table[(a, chosen[b])] + table[(b, chosen[a])]
                if swap > now + 1e-9:
                    chosen[a], chosen[b] = chosen[b], chosen[a]
                    improved = True
            for c in free:
                if table[(a, c)] > table[(a, chosen[a])] + 1e-9:
                    free.append(chosen[a])
                    free.remove(c)
                    chosen[a] = c
                    improved = True
        if not improved:
            break
    return chosen


# ── calibration ──────────────────────────────────────────────────────────────

def calibrate(placed, cass, rings, span=960.0, step=32.0):
    """How far the lattice sits from where the ground says it should.

    The survey was computed on the Bessel ellipsoid from an origin whose
    coordinates are only known to us to about an arcsecond, so the whole grid
    of a crown land can be a couple of hundred metres out — one number, the
    same for every sheet in the system. It is measured by sliding the modern
    boundary over the wash the sheets carry and taking the best fit, and it is
    the only correction applied: no sheet is warped, and none moves relative to
    its neighbours.
    """
    cells = [s["cell"] for s in placed if s["cell"]]
    if not cells:
        return None
    ix0, ix1 = min(c[0] for c in cells), max(c[0] for c in cells)
    iy0, iy1 = min(c[1] for c in cells), max(c[1] for c in cells)
    w = round((ix1 - ix0 + 1) * SHEET_W / CELL_PX)
    h = round((iy1 - iy0 + 1) * SHEET_H / CELL_PX)
    wash = [0.0] * (w * h)
    for s in placed:
        if not s["cell"]:
            continue
        m = drawn_mask(s["path"], s["corners"])
        ox = round((s["cell"][0] - ix0) * SHEET_W / CELL_PX)
        oy = round((iy1 - s["cell"][1]) * SHEET_H / CELL_PX)
        for y in range(CH):
            row = (oy + y) * w + ox
            wash[row:row + CW] = m[y * CW:(y + 1) * CW]
    west, north = ix0 * SHEET_W, (iy1 + 1) * SHEET_H
    grid = [cass.fwd(lon, lat) for ring in rings for lon, lat in ring]
    sizes = [len(ring) for ring in rings]

    best = None
    n = int(span // step)
    for gy in range(-n, n + 1):
        for gx in range(-n, n + 1):
            dx, dy = gx * step, gy * step
            img = Image.new("L", (w, h), 0)
            d = ImageDraw.Draw(img)
            at = 0
            for count in sizes:
                d.polygon([((x - dx - west) / CELL_PX, (north + dy - y) / CELL_PX)
                           for x, y in grid[at:at + count]], fill=255)
                at += count
            v = _correlate(wash, [p / 255 for p in img.getdata()])
            if best is None or v > best[2]:
                best = (dx, dy, v)
    return best


# ── manifest ─────────────────────────────────────────────────────────────────

def build_manifest(vac, ko_rec, args, out_path, review):
    name = args.name or re.sub(r",?\s*k\.?o\.?\s*$", "", ko_rec["title"], flags=re.I).strip()
    fond = re.search(r"SI AS (\d+)", ko_rec["sig"])
    origin_key = FOND_ORIGIN.get(fond.group(1) if fond else "176", "krim")
    origin = ORIGINS[origin_key]
    cass = Cassini(origin["lat0"], origin["lon0"], shift=tuple(origin["shift"]))

    rings, matched = gurs_polygon(name, args.cache, sifko=args.sifko,
                                  near=(origin["lon0"], origin["lat0"]))
    if not rings:
        review.append("%s (%s): no k.o. of that name in the modern cadastre" % (name, ko_rec["sig"]))
        return None
    if matched["alternatives"]:
        review.append("%s (%s): the name is shared — took k.o. %s, not %s"
                      % (name, ko_rec["sig"], matched["sifko"],
                         ", ".join(str(a) for a in matched["alternatives"])))

    records = ko_sheets(vac, ko_rec["id"])
    if not records:
        review.append("%s (%s): no graphic sheets" % (name, ko_rec["sig"]))
        return None
    os.makedirs(args.scans, exist_ok=True)
    sheets = []
    for rec in records:
        path = os.path.join(args.scans, "%s.jpg" % rec["id"])
        fetch(vac.scan_url(rec["id"]), path)
        sheets.append(dict(id=rec["id"], sig=rec["sig"], path=path))

    corners = frames([s["path"] for s in sheets])
    for s in sheets:
        s["corners"] = corners[s["path"]]
        s["letters"] = read_designation(s["path"], s["corners"]) if s["corners"] else None

    placed, err = place(sheets, cass, rings)
    if err:
        review.append("%s (%s): %s" % (name, ko_rec["sig"], err))
        return None
    # A sheet whose printed designation someone has read off the scan is the
    # last word: --pin is how a k.o. comes back from the review list.
    pins = json.load(open(args.pin, encoding="utf-8")) if args.pin else {}
    for s in placed:
        if s["id"] in pins:
            entry = pins[s["id"]]
            s["cell"] = tuple(entry["cell"]) if isinstance(entry, dict) else tuple(entry)
            s["how"] = entry.get("as", "pinned") if isinstance(entry, dict) else "pinned"
            s["score"] = 1.0
            if isinstance(entry, dict) and entry.get("frame"):
                # A sheet trimmed so close to its border rule, or with a rule
                # too faint to read, gets its four corners measured by hand.
                f = entry["frame"]
                s["corners"] = tuple((f[i], f[i + 1]) for i in range(0, 8, 2))
        elif pins.get("-" + s["id"]) is not None:
            s["cell"], s["how"] = None, pins["-" + s["id"]]

    if args.calibrate:
        fit = calibrate([s for s in placed if s["cell"] and s["corners"]], cass, rings)
        if fit:
            print("   %s: lattice fits best %+.0f m east, %+.0f m north (r %.3f)"
                  % (name, fit[0], fit[1], fit[2]), flush=True)

    entries = []
    for s in sorted(placed, key=lambda s: s["sig"]):
        if s["cell"] is None or s["corners"] is None:
            review.append("%s (%s): %s — %s (score %.2f)%s"
                          % (name, s["sig"], os.path.basename(s["path"]), s["how"], s["score"],
                             ", printed %s%s" % s["letters"] if s.get("letters") else ""))
            continue
        entries.append({
            "image": os.path.relpath(os.path.abspath(s["path"]),
                                     os.path.dirname(os.path.abspath(out_path))),
            "url": vac.scan_url(s["id"]),
            "cell": list(s["cell"]),
            "frame": [round(v, 1) for c in s["corners"] for v in c],
            "source": s["sig"],
            "placed": "%s (%.2f)" % (s["how"], s["score"]),
        })
    if not entries:
        return None
    return {
        "name": name,
        "cassini": dict(origin, system=origin_key),
        "source": "Arhiv Republike Slovenije, %s — Franciscean cadastre" % ko_rec["sig"],
        "sheets": entries,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ko-id", help="VAČ record id of one cadastral municipality")
    ap.add_argument("--fond", choices=sorted(FOND_ID), help="walk a whole fond (176/177/178/179)")
    ap.add_argument("--name", help="its name in the modern cadastre (default: the record's own)")
    ap.add_argument("--sifko", help="pin the modern k.o. by code, when the name is shared")
    ap.add_argument("--pin", metavar="PINS.json",
                    help='sheets whose cell was read off the scan by hand: '
                         '{"225877": {"cell": [-5, 22], "as": "printed W.C.II.14.ag"}}, '
                         'or {"-225877": "1853 reambulation, off the lattice"} to leave one out')
    ap.add_argument("--calibrate", action="store_true",
                    help="report how far the lattice sits from the modern boundary and stop "
                         "short of trusting it — the shift belongs in ORIGINS, not per k.o.")
    ap.add_argument("--scans", default="scans", help="where the sheet scans are kept")
    ap.add_argument("--cache", default="scans/.vac", help="where archive pages are kept")
    ap.add_argument("--manifest", help="manifest to write (one k.o.)")
    ap.add_argument("--manifest-dir", help="directory to write one manifest per k.o. into")
    ap.add_argument("--review", help="file to list the sheets that could not be placed")
    ap.add_argument("--limit", type=int, default=0, help="stop after this many k.o. (a whole-fond trial)")
    args = ap.parse_args()
    if not args.ko_id and not args.fond:
        raise SystemExit("--ko-id or --fond is required")
    if not args.manifest and not args.manifest_dir:
        raise SystemExit("--manifest or --manifest-dir is required")

    vac = Vac(args.cache)
    review = []
    if args.ko_id:
        targets = [vac.record(args.ko_id)]
    else:
        targets = [k for k in _walk_kos(vac, FOND_ID[args.fond])]
        if args.limit:
            targets = targets[:args.limit]
    print("%d cadastral municipalit%s" % (len(targets), "y" if len(targets) == 1 else "ies"), flush=True)

    for rec in targets:
        name = args.name or re.sub(r",?\s*k\.?o\.?\s*$", "", rec["title"], flags=re.I).strip()
        if args.manifest_dir:
            os.makedirs(args.manifest_dir, exist_ok=True)
            path = os.path.join(args.manifest_dir, "%s.json" % _slug(name))
        else:
            path = args.manifest
        manifest = build_manifest(vac, rec, args, path, review)
        if not manifest:
            continue
        json.dump(manifest, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        print("%-24s %2d sheets → %s" % (manifest["name"], len(manifest["sheets"]), path), flush=True)

    if review:
        text = "\n".join(review) + "\n"
        if args.review:
            open(args.review, "w", encoding="utf-8").write(text)
        print("\n%d sheet(s)/k.o. left for review%s"
              % (len(review), " — see " + args.review if args.review else ":"), flush=True)
        if not args.review:
            print(text, flush=True)


def _walk_kos(vac, root, depth=0):
    """Every k.o. record under a fond: descend until a record has a `grafični`
    child, which is what a cadastral municipality looks like in this tree."""
    for child in vac.children(str(root)):
        kids = vac.children(child["id"], limit=8)
        if any("grafi" in k["title"].lower() for k in kids):
            yield child
        elif depth < 3:
            yield from _walk_kos(vac, child["id"], depth + 1)


def _slug(name):
    table = str.maketrans("ČčŠšŽžĆćĐđ", "CcSsZzCcDd")
    return re.sub(r"[^a-z0-9]+", "-", name.translate(table).lower()).strip("-")


if __name__ == "__main__":
    sys.exit(main())
