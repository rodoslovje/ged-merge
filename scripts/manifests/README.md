# Overlay tile-pyramid manifests

Reproducible sheet lists for `scripts/overlay-tiles.py`. Each entry pins a
scanned public-domain map sheet to its geographic bbox and its measured
neatline (map-frame) corners, so the pyramid can be rebuilt from the source
scans without re-measuring.

- **spezialkarte-corridor.json** — 5-sheet Ljubljana→Zagreb demo.
- **spezialkarte-se-europe.json** — the full 165-sheet mosaic: Slovenia,
  Croatia, Bosnia-Herzegovina, coastal Montenegro, southern Austria and
  south-west Hungary. Serves `tiles.gedmerge.com/spezialkarte-se-europe/`.
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

## Getting the source scans

The `image` field is only a basename — the multi-GB scans are **not** in the
repo. Fetch them from Wikimedia Commons (and, for a few sheets, NYPL's image
endpoint) into one directory, then copy the manifest beside them and run the
build. The three collections used:

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

## Coverage gaps

26 grid cells in the target rectangle have no reachable public scan. Most are
open Adriatic (no sheet was ever published); the genuine content gaps are
Pula/southern Istria, Mali Lošinj, Prijedor, Požega, Prnjavor, southern
Velebit (Medak), Pelješac/Ston, Novi Sad, and the interior-Montenegro edge
(Durmitor, Podgorica) where the NYPL collection stops. One Commons file
(`Curzola und Lagosta`, NYPL1227026) is a mislabelled New York state atlas
page and is unusable. If those scans surface later, add one manifest entry
each and rebuild to a new path.
