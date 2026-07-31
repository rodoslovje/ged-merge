# Overlay tile-pyramid manifests

Reproducible sheet lists for `scripts/overlay-tiles.py`. Each entry pins a
scanned public-domain map sheet to its geographic bbox and its measured
neatline (map-frame) corners, so the pyramid can be rebuilt from the source
scans without re-measuring.

- **spezialkarte-monarchy.json** — the whole series: 805 sheets, Saxony to
  Montenegro and Tyrol to Bukovina. Generated, not hand-written — see
  "The whole series" below. Serves `tiles.gedmerge.com/spezialkarte-monarchy/`.
- **spezialkarte-corridor.json** — 5-sheet Ljubljana→Zagreb demo.
- **spezialkarte-se-europe.json** — the earlier 165-sheet mosaic of Slovenia,
  Croatia and Bosnia, measured by hand from Commons scans. Superseded by the
  monarchy manifest, kept because its frames are the calibration the automatic
  measurement was checked against.
- **schraembl-1797.json** — Schraembl's *Neueste Generalkarte von Deutschland*
  (Vienna, 1797), the Holy Roman Empire on the eve of Napoleon. One conic
  projection rather than a sheet grid — see "Conic manifests" below. Serves
  `tiles.gedmerge.com/schraembl-1797/`.

## Entry shape

```json
{ "id": "z22c11",                       // zone/column of the survey grid
  "image": "weixelburg.jpg",            // source scan basename
  "bbox": [west, south, east, north],   // Greenwich degrees of the neatline
  "frame": [nwx,nwy, nex,ney, sex,sey, swx,swy],  // corner pixels in the scan
  "source": "…title / collection…" }
```

`bbox` comes from the sheet's printed Ferro graticule: each sheet spans
0.5° lon × 0.25° lat; Greenwich = Ferro − 17°39′46″ (17.662778°).

## The whole series

The Spezialkarte is a lattice, and every sheet carries its place in it — the
*godło*, zone (south-counting) and column (east of Ferro). That alone fixes the
sheet's box:

    west  = (col + 53) · 0.5° − 17.662778°
    north = 47° + (18 − zone) · 0.25°

which reproduces all 165 hand-measured bboxes of `spezialkarte-se-europe.json`
exactly. So nothing has to be measured to *place* a sheet; only its neatline
inside its own scan does, and that is what `--write-frames` finds.

    # catalogue → manifest, and fetch the scans beside it (≈49 GB, one hour)
    python3 scripts/spezialkarte-sheets.py --manifest scans/sheets.json --download scans/

    # measure every neatline, keeping only the frames that check out
    python3 scripts/overlay-tiles.py --manifest scans/sheets.json \
        --write-frames scripts/manifests/spezialkarte-monarchy.json --jobs 6

    # build (base zoom 14 — the scans hold more, the overlay does not show it)
    python3 scripts/overlay-tiles.py --manifest scripts/manifests/spezialkarte-monarchy.json \
        --out public/tiles-local/spezialkarte-monarchy --base-zoom 14 --min-zoom 7 \
        --webp --jobs 6

The sheet list and the scans come from **Mapster** (igrek.amzp.pl /
mapywig.org), which catalogues 3 600+ files over the 805 grid cells, most in
several editions and resolutions, each row carrying its godło and a direct
link. `spezialkarte-sheets.py` picks the newest in-period edition at the best
resolution and falls through to the next one when a link is dead, recording in
the manifest which edition actually landed. The scans behind it are the
Jagiellonian Library's, the NYPL's (CC0), Slovenia's NUK/dLib and
Regensburg's; the maps themselves are public domain by age, and Mapster asks
that its copies be used non-commercially.

### The survey's degrees are not today's degrees

A sheet pinned at its printed Ferro graticule lands a few hundred metres east
of where those coordinates fall on WGS 84: the survey was computed on the
Bessel ellipsoid from the Hermannskogel datum. Measured against modern rivers,
railways and main roads, the uncorrected overlay sat +172 m east at Prague,
+280 m at Vienna, +292 m at Ljubljana, +439 m at Budapest and +442 m at
Kraków — **growing eastward**, as the old triangulation drifts away from its
Vienna origin. That growth is the giveaway: no constant nudge can fix a map
whose error doubles across it, but a geocentric datum shift reproduces it
(predicting 366 / 386 / 367 / 414 / 423 m for those five).

`cell_bbox` therefore converts each sheet's graticule box to WGS 84 before the
tiler sees it, with the MGI→WGS 84 parameters of EPSG:1188 — chosen because
they track the measurements across the whole series, where the Austrian set
(EPSG:1618) predicts only ~56 m and would leave most of the error in place.
The shift is applied to the *grid*, so every sheet moves by the same rule and
neighbours cannot be pulled out of register with each other.

Measured again after the rebuild, east offset before → after:

| | Kranj | Ljubljana | Koper | Zagreb | Vienna | Prague | Budapest | Kraków | Lviv |
|---|---|---|---|---|---|---|---|---|---|
| before | +264 | +292 | +174 | +266 | +280 | +172 | +439 | +442 | +431 |
| after | −106 | −80 | −161 | −107 | −102 | −172 | +26 | +294 | +74 |

Mean |error| 307 m → 125 m, and no region ends up worse than it began (Prague
keeps its magnitude and changes sign; Kraków stays under-corrected). What is
left is the survey's own error and stays visible — same principle as the
Schraembl map below: no rubber-sheeting. It is also near the floor of the
measurement itself: these come from correlating the scans against modern
rivers, railways and main roads, which agree to about a hundred metres at best.

### Why the neatline needs a prior

The obvious heuristic — take the innermost long rule with paper outside it —
picks a road or a contour running parallel to the frame on a good fraction of
the scans, and a frame that is 150 px out shifts that sheet by half a
kilometre. `detect_frame` is therefore given `printed_size(bbox, dpi)`: a
survey sheet is printed to scale, so its box on the ground and the scan's
resolution say exactly how many pixels apart its border rules must be. It
looks for the pair that is that distance apart, with blank paper a few
millimetres outside them, then refines to the innermost rule of that bundle at
full size. What is left over is caught by the shape check in `--write-frames`,
which drops a sheet whose frame is more than 3% off the aspect its bbox
implies rather than smearing it across its neighbours.

## Getting the source scans from Commons (the older manifests)

The `image` field is only a basename — the multi-GB scans are **not** in the
repo. `spezialkarte-monarchy.json` records a `url` per sheet and
`spezialkarte-sheets.py --download` fetches them; the earlier hand-built
manifests instead name Commons files, which are resolved like this. The three
collections they use:

- **dLib.si** (Digital Library of Slovenia) — high-resolution (~600 dpi)
  Slovenian sheets, on Commons as
  `File:Spezialkarte der Österreichisch-ungarischen Monarchie - <Name> <year>.jpg`.
  Public domain.
- **NYPL** (New York Public Library) — the bulk of Croatia + Bosnia, on
  Commons as `File:<Name>. NYPL<id>.tiff`, CC0. Portrait-scanned sheets are
  rotated upright by the tiler's `prep`/`rotate` handling.
- **IOS / GeoPortOst** — a few Hungarian border sheets, high-resolution on
  Commons.

A sheet's Commons file title is recorded in its manifest `source` field.
Resolve a title to a download URL with the Commons API
(`action=query&titles=File:…&prop=imageinfo&iiprop=url`) — send a
`User-Agent` header or it 403s, and pace requests (Wikimedia rate-limits bulk
downloads with 429s). `scripts/overlay-tiles.py` and the build helpers handle
rotation, neatline masking and palette quantization (`--png8`).

## Conic manifests (one big map instead of a sheet grid)

A wall map engraved as one continuous projection has no per-sheet graticule to
pin corners to, so `bbox`/`frame` do not apply. Such a manifest instead carries
a top-level `conic` block and cuts the single scan into panes:

```json
{ "conic": { "n": …, "lam0": …, "rho0": …, "k": …, "cx": …, "cy": …,
             "primeMeridian": 2.3372, "shift": [dx, dy] },
  "sheets": [ { "image": "p0000.jpg", "origin": [x, y] }, … ] }
```

Every pane shares the one projection and only records its pixel `origin` in the
full scan; the tiler derives each pane's bbox from the projection. Panes exist
purely so a 600-megapixel scan never has to be in memory at once — they overlap
by `paneOverlap` px so bicubic sampling leaves no seam.

### Recovering the projection

The parameters come from the map's **own printed border graduation**, not from
control points on modern places, so the overlay reproduces the map's coordinate
system exactly as engraved. For schraembl-1797 that meant: locate the graduated
band inside each neatline, detect the degree tick lines crossing it, read the
printed degree labels to anchor the numbering, then least-squares fit an
equidistant conic (meridians straight through an apex, parallels concentric and
evenly spaced) to all four edges' ticks. The fit closed to 15 px rms over
24 000 px — i.e. the engraver really did draw a clean conic.

What the numbers came out as, for the record: 1405 px per degree of longitude
along the north edge against 1752 along the south (the cos φ ratio, which is
what identifies it as conic in the first place), 2489 px per degree of latitude
on both sides, standard parallel ≈ 49°, and longitudes counted **east of
Paris** — `primeMeridian` converts them to Greenwich.

### Accuracy, and why there is no rubber-sheeting

`shift` is a constant pixel offset that centres the residual against modern
coordinates. It is deliberately the *only* correction applied. Checked against
12 cities, the overlay sits ~6 km rms from truth (Hamburg 1 km, Vienna 2.5 km,
Prague 5.6 km, Ljubljana 10.6 km), and that error is the **map's**, not the
registration's: it jumps by ~8 km between Dresden and Prague, where Schraembl
switched compilation sources, while the scan itself runs geometrically
continuous across that line. A smooth warp cannot represent a step like that —
fitted linear and quadratic corrections both scored *worse* than no correction
at all under leave-one-out cross-validation (6.4 km and 13.5 km against
6.0 km). Only dense rubber-sheeting could hide it, and that would falsify the
document. So the map is placed by its own graticule and its errors are left
visible.

## Getting the scan for schraembl-1797

The composite scan (30065 × 29378 px) is served by David Rumsey's IIIF endpoint
under CC BY-NC-SA 3.0 — attribution "David Rumsey Map Collection, David Rumsey
Map Center, Stanford Libraries", non-commercial, share-alike, which the built
tiles inherit. The endpoint caps a response at 1536 px per side, hence the
1504-px panes. Rebuild the 288 pane files with:

```sh
IIIF=https://www.davidrumsey.com/luna/servlet/iiif/RUMSEY~8~1~303924~90074401
python3 - <<'EOF' > cmds.txt
import json
m = json.load(open("schraembl-1797.json"))
x0, y0, x1, y1 = m["neatline"]; step, ov = m["paneStep"], m["paneOverlap"]
for s in m["sheets"]:
    ox, oy = s["origin"]
    w, h = min(step + ov, x1 - ox), min(step + ov, y1 - oy)
    print(f'curl -sf --retry 3 -o {s["image"]} "$IIIF/{ox},{oy},{w},{h}/full/0/default.jpg"')
EOF
xargs -P 6 -I{} sh -c '{}' < cmds.txt
python3 ../overlay-tiles.py --manifest schraembl-1797.json \
    --out public/tiles-local/schraembl-1797 --min-zoom 6 --png8
```

Base zoom lands on 11 (~49 m/px, which is the scan's own resolution — z12 would
only enlarge it) for ~11 000 tiles / 270 MB.

## Coverage

805 grid cells is the series — the sheets the k.u.k. Militärgeographisches
Institut published, plus the foreign-margin ones. **801 of them are in.** The
gaps that dogged the Commons-only build (Pula, Mali Lošinj, Prijedor, Požega,
Prnjavor, Medak, Pelješac/Ston, Novi Sad, the Montenegrin interior) are all in
the Mapster catalogue and are covered; cells with no sheet at all are open
Adriatic, where none was ever published.

The four that are not in — `z02c35` Kostopol, `z25c22` Karlowitz und Titel,
`z26c22` Alt-Pazua, `z30c20` Rogatica — have had every edition Mapster lists
tried, and no neatline could be measured on any of them (each is a scan on a
grey mount whose border rule is too faint to find). They need eight numbers
measured by hand in an image editor, added as a `frame` on their manifest
entry; the ids are the file names.

How the 805 came out, for the record: 765 measured on the first pass, 26 more
after re-fetching the rejects from a different collection (`--again`), 10 more
after a second round, 4 left.
