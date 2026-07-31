#!/usr/bin/env python3
"""Resolve the Spezialkarte 1:75 000 sheet grid into a tiler manifest, and fetch
the scans.

The Austro-Hungarian Spezialkarte is a regular lattice: every sheet spans
exactly 0.5° of longitude by 0.25° of latitude and is identified by its
*godło* — zone (arabic, counting south) and column (roman, counting east of
Ferro).  So a sheet's geographic box follows from its godło alone:

    west  = (col + 53) · 0.5° − 17.662778°      (Ferro → Greenwich)
    north = 47° + (18 − zone) · 0.25°

which reproduces all 165 hand-measured bboxes of spezialkarte-se-europe.json
exactly.  Nothing about a sheet has to be measured to place it; only the
neatline corners inside its own scan do, and overlay-tiles.py --write-frames
finds those.

The sheet list and the scans come from Mapster (igrek.amzp.pl / mapywig.org),
which catalogues 3 600+ files over 805 grid cells — the whole series, most
cells in several editions and resolutions, each row carrying its godło.  This
script reads that catalogue, picks one edition per cell, and writes a manifest
overlay-tiles.py can build from.

    # whole series → manifest (catalogue is cached after the first run)
    python3 scripts/spezialkarte-sheets.py --manifest sheets.json

    # …only part of the grid, and fetch the scans beside the manifest
    python3 scripts/spezialkarte-sheets.py --manifest tiles/sheets.json \
        --zones 18-36 --cols 9-24 --download tiles/

Edition choice: newest in-period edition at the highest available resolution,
preferring `--prefer-dpi` (600 by default — 3.2 m/px, twice the detail zoom 14
can show).  `--year-from/--year-to` bound "in period"; a cell with no in-period
edition falls back to whatever it has, and is flagged in the summary.
"""

import argparse
import html
import json
import os
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

CATALOGUE = "http://igrek.amzp.pl/maplist.php?cat=KUK075&listtype=standard&listsort=sortoption1"
UA = "ged-merge overlay-tiles (github.com/lukarenko/ged-merge; historical map overlay build)"

# Greenwich = Ferro − 17°39'46"; column 1 starts at 27°E of Ferro, zone 18's
# northern neatline sits on 47°N.
FERRO = 17.662778
COL0 = 53          # west = (col + COL0) · 0.5° − FERRO
ZONE0, LAT0 = 18, 47.0

ROMAN = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100}

# Holding libraries behind Mapster's per-resolution folders, for the credit
# line each selected sheet carries into the manifest.
COLLECTIONS = {
    "UJ": "Biblioteka Jagiellońska",
    "NYPL": "New York Public Library (CC0)",
    "NLSlov": "Narodna in univerzitetna knjižnica / dLib.si",
    "UnivRegensburg": "Universitätsbibliothek Regensburg",
}


def roman(s):
    n = 0
    for i, c in enumerate(s):
        v = ROMAN.get(c, 0)
        n += -v if i + 1 < len(s) and ROMAN.get(s[i + 1], 0) > v else v
    return n


def cell_bbox(zone, col):
    """(west, south, east, north) of a godło's neatline, Greenwich degrees."""
    west = (col + COL0) * 0.5 - FERRO
    north = LAT0 + (ZONE0 - zone) * 0.25
    return [round(west, 6), round(north - 0.25, 6), round(west + 0.5, 6), round(north, 6)]


def curl(url, out=None, resume=False):
    # -g: sheets that carry both names — "Nagyszeben [Hermannstadt]" — have
    # square brackets in their filename, which curl otherwise reads as a URL
    # glob and refuses.
    cmd = ["curl", "-sfLg", "--retry", "4", "--retry-delay", "3", "-A", UA]
    if out:
        cmd += ["-o", out] + (["-C", "-"] if resume and os.path.exists(out) else [])
        return subprocess.run(cmd + [url]).returncode == 0
    r = subprocess.run(cmd + [url], capture_output=True)
    return r.stdout.decode("utf-8", "replace") if r.returncode == 0 else None


# ── Catalogue ────────────────────────────────────────────────────────────────

def catalogue(cache, refresh=False):
    """Mapster's KUK075 list → [{zone, col, name, year, dpi, url, collection}]."""
    if refresh or not os.path.exists(cache):
        page = curl(CATALOGUE)
        if page is None:
            raise SystemExit(f"could not fetch the catalogue: {CATALOGUE}")
        os.makedirs(os.path.dirname(cache) or ".", exist_ok=True)
        open(cache, "w", encoding="utf-8").write(page)
    page = open(cache, encoding="utf-8", errors="replace").read()

    recs = []
    for row in re.findall(r"<tr[^>]*>(.*?)</tr>", page, re.S):
        link = re.search(r'href="(http://maps\.mapywig\.org/[^"]+\.(?:jpg|png))"', row)
        if not link:
            continue
        cells = [html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", c))).strip()
                 for c in re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)]
        if len(cells) < 6:
            continue
        godlo = re.match(r"^(\d+)\s+([IVXLC]+)$", cells[1])
        if not godlo:
            continue  # irregular/combined sheet — not on the grid
        year = re.match(r"(\d{4})", cells[4] or "")
        dpi = re.search(r"(\d+)", cells[5] or "")
        folder = link.group(1).rsplit("/", 2)[-2]
        recs.append({
            "zone": int(godlo.group(1)),
            "col": roman(godlo.group(2)),
            "name": cells[2],
            "year": int(year.group(1)) if year else 0,
            "dpi": int(dpi.group(1)) if dpi else 0,
            "url": link.group(1),
            "collection": COLLECTIONS.get(folder.split("_")[-1], "Mapster / mapywig.org"),
        })
    if not recs:
        raise SystemExit(f"no sheet rows parsed from {cache} — has the catalogue layout changed?")
    return recs


def select(recs, prefer_dpi, year_from, year_to):
    """Rank the editions of each grid cell: best resolution first, then newest.

    The whole ranking is kept, not just the winner — Mapster occasionally
    serves a dead link, and the next edition of the same sheet is a better
    answer than a hole in the mosaic."""
    by_cell = {}
    for r in recs:
        by_cell.setdefault((r["zone"], r["col"]), []).append(r)

    def rank(r):
        # In-period editions first; then resolution — but a scan finer than
        # `prefer_dpi` is no better than it for tiles zoom 14 can show, so both
        # sort as "enough"; then the latest printing.
        return (year_from <= r["year"] <= year_to, min(r["dpi"], prefer_dpi), r["year"])

    ranked, fallback = {}, []
    for cell, editions in sorted(by_cell.items()):
        ranked[cell] = sorted(editions, key=rank, reverse=True)
        if not any(year_from <= r["year"] <= year_to for r in editions):
            fallback.append(cell)
    return ranked, fallback


# ── Manifest ─────────────────────────────────────────────────────────────────

def sheet_id(zone, col):
    return f"z{zone:02d}c{col:02d}"


def manifest(chosen):
    sheets = []
    for (zone, col), r in sorted(chosen.items()):
        if r is None:
            continue
        sid = sheet_id(zone, col)
        sheets.append({
            "id": sid,
            "image": f"{sid}.jpg",
            "bbox": cell_bbox(zone, col),
            "frame": "auto",
            "godlo": f"Zone {zone} Col. {col}",
            "name": r["name"],
            "year": r["year"],
            "dpi": r["dpi"],
            "url": r["url"],
            "source": f"{r['name']} ({r['year']}) · {r['collection']} via Mapster (mapywig.org)",
        })
    return {"note": ("Spezialkarte der österreichisch-ungarischen Monarchie 1:75 000. "
                     "Generated by scripts/spezialkarte-sheets.py — bboxes follow from the "
                     "godło, frames are measured by overlay-tiles.py --write-frames."),
            "sheets": sheets}


# ── Download ─────────────────────────────────────────────────────────────────

def download(ranked, directory, jobs, again=()):
    """Fetch one scan per cell; return the edition that actually landed.

    Interrupted downloads resume, and a cell whose best edition 404s falls
    through to its next one, so the answer is what is on disk rather than what
    was picked. `.fetched.json` remembers every edition tried and the one in
    use, so a rerun neither re-downloads nor mislabels — and cells listed in
    `again` (the sheets whose neatline could not be measured) skip what has
    been tried and fetch the next edition instead. Most measuring failures are
    the scan's fault, not the sheet's: another library's copy usually reads."""
    os.makedirs(directory, exist_ok=True)
    state_path = os.path.join(directory, ".fetched.json")
    state = json.load(open(state_path)) if os.path.exists(state_path) else {}
    for sid, got in list(state.items()):           # older state held the record alone
        if "record" not in got:
            state[sid] = {"record": got, "tried": [got["url"]]}

    landed, todo = {}, []
    for cell, editions in sorted(ranked.items()):
        sid = sheet_id(*cell)
        got = state.get(sid)
        if got and os.path.exists(os.path.join(directory, f"{sid}.jpg")) and sid not in again:
            landed[cell] = got["record"]
        else:
            fresh = [r for r in editions if r["url"] not in (got or {}).get("tried", [])]
            if fresh:
                todo.append((cell, fresh))
            elif got:
                landed[cell] = got["record"]       # nothing left to try; keep what we have
    print(f"{len(landed)} of {len(ranked)} scans already present; fetching {len(todo)}", flush=True)

    def one(task):
        cell, editions = task
        path = os.path.join(directory, f"{sheet_id(*cell)}.jpg")
        for r in editions[:3]:
            if curl(r["url"], out=path + ".part", resume=True) \
                    and os.path.getsize(path + ".part") > 100_000:
                os.replace(path + ".part", path)
                return cell, r
            if os.path.exists(path + ".part"):
                os.remove(path + ".part")  # a dead link leaves an error page
        return cell, None

    done = failed = 0
    with ThreadPoolExecutor(max_workers=jobs) as pool:
        for cell, r in pool.map(one, todo):
            sid = sheet_id(*cell)
            if r:
                done += 1
                landed[cell] = r
                tried = state.get(sid, {}).get("tried", [])
                state[sid] = {"record": r, "tried": sorted(set(tried + [r["url"]]))}
                json.dump(state, open(state_path, "w"), ensure_ascii=False)
                size = os.path.getsize(os.path.join(directory, f"{sid}.jpg"))
                print(f"  [{done + failed}/{len(todo)}] {sid} {r['name'][:34]:34s} "
                      f"{r['year']} {r['dpi']}dpi {size / 1e6:6.1f} MB", flush=True)
            else:
                failed += 1
                print(f"  [{done + failed}/{len(todo)}] {sid} FAILED — no edition downloaded",
                      flush=True)
    if failed:
        print(f"{failed} sheet(s) missing — rerun to retry; partial files resume")
    return landed


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--manifest", required=True, help="manifest to write")
    ap.add_argument("--cache", default=os.path.join(os.path.dirname(__file__), "manifests",
                                                    ".kuk075-catalogue.html"))
    ap.add_argument("--refresh", action="store_true", help="re-fetch the catalogue")
    ap.add_argument("--zones", help="zone range, e.g. 18-36 (default: all)")
    ap.add_argument("--cols", help="column range, e.g. 9-24 (default: all)")
    ap.add_argument("--cells", help="explicit ids, e.g. z26c10,z27c11")
    ap.add_argument("--prefer-dpi", type=int, default=600)
    ap.add_argument("--year-from", type=int, default=1873)
    ap.add_argument("--year-to", type=int, default=1920)
    ap.add_argument("--download", metavar="DIR", help="fetch the selected scans into DIR")
    ap.add_argument("--again", metavar="IDS",
                    help="re-fetch these sheets with an edition not tried yet — pass the ids "
                         "--write-frames could not measure, or a file listing them")
    ap.add_argument("--jobs", type=int, default=3, help="parallel downloads (be gentle: default 3)")
    args = ap.parse_args()

    recs = catalogue(args.cache, args.refresh)
    ranked, fallback = select(recs, args.prefer_dpi, args.year_from, args.year_to)

    def rng(spec):
        if not spec:
            return None
        lo, _, hi = spec.partition("-")
        return range(int(lo), int(hi or lo) + 1)

    zones, cols = rng(args.zones), rng(args.cols)
    wanted = set(args.cells.split(",")) if args.cells else None
    ranked = {(z, c): eds for (z, c), eds in ranked.items()
              if (zones is None or z in zones) and (cols is None or c in cols)
              and (wanted is None or sheet_id(z, c) in wanted)}
    if not ranked:
        raise SystemExit("no sheets selected")

    missing = 0
    if args.download:
        again = set()
        if args.again:
            text = open(args.again).read() if os.path.exists(args.again) else args.again
            again = {t for t in re.split(r"[\s,]+", text) if t}
        chosen = download(ranked, args.download, args.jobs, again)
        missing = len(ranked) - len(chosen)
    else:
        chosen = {cell: eds[0] for cell, eds in ranked.items()}

    spec = manifest(chosen)
    os.makedirs(os.path.dirname(os.path.abspath(args.manifest)), exist_ok=True)
    json.dump(spec, open(args.manifest, "w"), ensure_ascii=False, indent=1)

    dpis = {}
    for s in spec["sheets"]:
        dpis[s["dpi"]] = dpis.get(s["dpi"], 0) + 1
    years = [s["year"] for s in spec["sheets"] if s["year"]]
    print(f"\n{len(spec['sheets'])} sheets → {args.manifest}")
    print("  resolutions: " + ", ".join(f"{d} dpi ×{n}" for d, n in sorted(dpis.items(), reverse=True)))
    print(f"  editions {min(years)}–{max(years)}"
          + (f"; {len(fallback)} cell(s) had no {args.year_from}–{args.year_to} edition"
             if fallback else ""))
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
