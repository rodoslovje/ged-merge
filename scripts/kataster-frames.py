#!/usr/bin/env python3
"""Audit — and optionally re-cut — the neatline frames in a cadastral manifest.

A sheet is drawn by mapping its frame (the four corners of the printed
neatline) onto its lattice cell, so a frame that is off by n pixels moves the
whole sheet on the ground by n × the scan's metres-per-pixel.  Those errors are
indistinguishable, by eye, from a sheet placed on the wrong cell: the map looks
shifted, and nudging the cell to compensate only opens a gap at the seam.

The detector here is a matched filter rather than an edge walk.  A neatline is
a pair of ruled lines a known distance apart — one sheet is 1000 × 800 klafter
and the scans run near 0.77 m/px — and the ratio is always exactly 1.25.  So it
scores every (width, offset) whose two rules both fall on ink, which ignores
the dark scan borders and the map's own straight features that defeat a
one-rule-at-a-time search.

    kataster-frames.py --manifest <file>          # report
    kataster-frames.py --manifest <file> --fix    # rewrite frames that are out
"""
import argparse
import json
import os

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
sliding = np.lib.stride_tricks.sliding_window_view

RATIO = 1.25            # 1000 klafter across by 800 down
WIDTHS = range(2280, 2620, 2)   # the fond's scans run 2440-2470 px, near 0.77 m/px


def dips(profile, half=7):
    """How much darker each pixel is than the brightest one near it."""
    pad = np.pad(profile, half, mode="edge")
    return sliding(pad, 2 * half + 1).max(axis=1) - profile


def best_pair(profile, size):
    """Where a pair of rules `size` apart best explains the ink."""
    d = dips(profile)
    s = int(round(size))
    if s + 20 >= len(d):
        return None, -1e9
    a, b = d[: len(d) - s], d[s:]
    # both rules have to be real ink: a single strong line must not win.
    score = np.minimum(a, b) + 0.25 * (a + b)
    score[:10] = -1e9
    score[-10:] = -1e9
    i = int(score.argmax())
    return i, float(score[i])


def detect(path):
    with Image.open(path) as im:
        a = np.asarray(im.convert("L"), dtype=np.float32)
    h, w = a.shape
    row = a[int(h * 0.2):int(h * 0.8), :].mean(axis=0)
    col = a[:, int(w * 0.2):int(w * 0.8)].mean(axis=1)
    best = None
    for width in WIDTHS:
        height = width / RATIO
        if width + 20 >= w or height + 20 >= h:
            continue
        x0, sx = best_pair(row, width)
        y0, sy = best_pair(col, height)
        if x0 is None or y0 is None:
            continue
        if best is None or sx + sy > best[0]:
            best = (sx + sy, width, height, x0, y0)
    if best is None:
        return None
    _, width, height, x0, y0 = best
    return [float(x0), float(y0), float(x0 + width), float(y0),
            float(x0 + width), float(y0 + height), float(x0), float(y0 + height)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--fix", action="store_true", help="rewrite frames that are out")
    ap.add_argument("--tolerance", type=float, default=25.0, help="pixels")
    ap.add_argument("--only", nargs="*", help="limit to these scan ids")
    ap.add_argument("--widths", nargs=2, type=int, metavar=("MIN", "MAX"),
                    help="hold the neatline width to this pixel range — worth "
                         "narrowing when a scan's margin ink outscores its rules")
    args = ap.parse_args()

    if args.widths:
        global WIDTHS
        WIDTHS = range(args.widths[0], args.widths[1], 2)

    base = os.path.dirname(os.path.abspath(args.manifest))
    spec = json.load(open(args.manifest))
    changed = []
    for sheet in spec["sheets"]:
        sid = os.path.splitext(os.path.basename(sheet["image"]))[0]
        if args.only and sid not in args.only:
            continue
        path = sheet["image"]
        if not os.path.isabs(path):
            path = os.path.join(base, path)
        found = detect(path)
        old = sheet.get("frame")
        if found is None or not isinstance(old, list):
            print(f"{sid:>8}  no reading")
            continue
        delta = [f - o for f, o in zip(found, old)]
        off = max(abs(d) for d in delta)
        metres = off * 1896.484 / (found[2] - found[0])
        note = ""
        if off > args.tolerance:
            note = "  <-- OUT" + (", re-cut" if args.fix else "")
            if args.fix:
                sheet["frame"] = [round(v, 1) for v in found]
                changed.append(sid)
        print(f"{sid:>8}  x{found[0]:.0f}-{found[2]:.0f} y{found[1]:.0f}-{found[7]:.0f}"
              f"  ({found[2]-found[0]:.0f}x{found[7]-found[1]:.0f} @ {1896.484/(found[2]-found[0]):.4f} m/px)"
              f"  worst {off:5.0f} px = {metres:4.0f} m{note}")

    if args.fix and changed:
        json.dump(spec, open(args.manifest, "w"), ensure_ascii=False, indent=1)
        print(f"re-cut {len(changed)}: {', '.join(changed)} → {args.manifest}")


if __name__ == "__main__":
    main()
