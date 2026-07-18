# Overlay tile-pyramid manifests

Reproducible sheet lists for `scripts/overlay-tiles.py`. Each entry pins a
scanned public-domain map sheet to its geographic bbox and its measured
neatline (map-frame) corners, so the pyramid can be rebuilt from the source
scans without re-measuring.

- **spezialkarte-corridor.json** — 5-sheet Ljubljana→Zagreb demo.
- **spezialkarte-se-europe.json** — the full 165-sheet mosaic: Slovenia,
  Croatia, Bosnia-Herzegovina, coastal Montenegro, southern Austria and
  south-west Hungary. Serves `tiles.gedmerge.com/spezialkarte-se-europe/`.

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

## Coverage gaps

26 grid cells in the target rectangle have no reachable public scan. Most are
open Adriatic (no sheet was ever published); the genuine content gaps are
Pula/southern Istria, Mali Lošinj, Prijedor, Požega, Prnjavor, southern
Velebit (Medak), Pelješac/Ston, Novi Sad, and the interior-Montenegro edge
(Durmitor, Podgorica) where the NYPL collection stops. One Commons file
(`Curzola und Lagosta`, NYPL1227026) is a mislabelled New York state atlas
page and is unusable. If those scans surface later, add one manifest entry
each and rebuild to a new path.
