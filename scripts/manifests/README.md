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
- **kataster-*.json** — cadastral municipalities of the Franciscean cadastre,
  1:2880, from the Archives of the Republic of Slovenia. Eleven so far:
  Stražišče, Kranj, Bela and Breg ob Kokri in Gorenjska; Metlika, Semič,
  Gradac, Podzemelj, Drašiči, Krasinec and Štrekljevec in Bela krajina. Note
  that a k.o. is named for one of its villages and holds others — Preddvor is
  in Breg ob Kokri, Osojnik in Štrekljevec, and Zgornje, Srednje and Spodnje
  Bitnje are all one k.o. Bitnje. A third manifest kind: cells of
  the survey's own Cassini-Soldner lattice — see "Cadastral manifests" below.
  Serve `tiles.gedmerge.com/kataster-<k.o.>/`.

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

## Cadastral manifests (the Franciscean cadastre, 1:2880)

The Franciscean cadastre is the largest scale these lands were ever drawn at —
every parcel, every house, every field name, surveyed in the 1820s — and the
Archives of the Republic of Slovenia have the whole of it online, sheet by
sheet, open to anyone, in four fonds: **SI AS 176** Carniola, **177** Styria,
**178** Carinthia, **179** the Littoral. `scripts/kataster-sheets.py` walks
that catalogue and writes a manifest per cadastral municipality:

```json
{ "name": "STRAŽIŠČE",
  "cassini": { "lat0": 45.928944, "lon0": 14.474694, "shift": [0, 0] },
  "sheets": [ { "image": "…/225877.jpg", "cell": [-5, 22],
                "frame": [8 corner pixels], "source": "SI AS 176/L/L278/g/A04",
                "placed": "printed W.C.II.14.ag (1.00)" } ] }
```

A sheet has no `bbox`, only its `cell`. The survey divided the land into
sections one Austrian post mile square (4000 klafter = 7585.9 m), each into 4
sheet columns of 1000 klafter and 5 sheet rows of 800 klafter, on
Cassini-Soldner about the crown land's origin. So a cell fixes a sheet
absolutely, and the tiler derives its corners from the projection.

### Reading a sheet's own address

Every sheet prints its designation in the top margin: `W.C.II.14.ag` is **W**est
column **II**, section row **14**, and inside that section the sheet in column
**a**, row **g**. Columns run **a–d from the section's eastern edge westward**
and rows **e–i from north to south** — both established here from the sheets
themselves, since Gradac straddles the VIII/IX section boundary and only one
reading joins its halves, and since the archive files a k.o.'s sheets in raster
order, which only one reading makes monotonic.

Section columns are counted west and east of the origin meridian; section rows
southward from 18 sections north of the origin parallel. Hence
`cell = (ix, iy)` with the cell spanning `[ix·1896.484, (ix+1)·1896.484]` east
and `[iy·1517.187, (iy+1)·1517.187]` north of the origin.

A cadastral sheet is a rectangle of the *survey's* grid, not of lon/lat: at the
eastern edge of a crown land the meridians converge about half a degree away
from grid north, which tilts a sheet by ~18 m corner to corner. Each sheet is
therefore clipped to its cell's ring rather than to a lon/lat box, or it would
cover its neighbour.

### Finding the frame, and squaring it up

Placing a sheet by its cell is only as good as the neatline it was measured
against, and a bad edge is worse here than in a single-sheet mosaic because the
neighbour does not follow it: 89 px of false lean across a 2460 px frame is
68 m at the corner, and the join tears. On these scans the plain
innermost-rule-per-edge heuristic leaned sheets by 89, 102, 107 and 160 px, and
on one it put the sheet's own "Aufgenommen und berechnet von…" footer inside
the map.

So each scan is read every way that works — plain, told the printed size, and
told the printed size with a margin of its own paper tone pasted back around it
for sheets trimmed to within a few pixels of their rule — and the reading
closest to a cadastral sheet's known shape wins. Then every frame is rebuilt as
a rectangle of exactly the series' size (the median of the readings that check
out: 2462 × 1970 px here) about its own **centre**, with lean clamped to 0.23°.
The centre, not a corner, because the detector brackets an edge between the
pair of rules the printed distance apart, so half of whatever is left over goes
each way instead of all of it to the far edge.

What remains at a join is ten metres or so in places. That is the paper's own
two centuries of distortion and the survey's sheet-to-sheet edge matching, and
removing it would mean nudging sheets relative to each other — fitting, which
is exactly what this pipeline is built not to do.

### How a sheet gets placed, and what still needs a human

Placement leans on three readings, scored together as one assignment so that no
single one can drag a sheet off on its own: OCR of the printed letter pair; the
shape of the colour wash (a sheet paints its own k.o. and leaves the rest of the
paper blank, so the wash is the k.o. clipped to that cell); and the archive's
raster filing order. Measured against designations read by eye on the 13
lattice sheets of these two k.o., that places about two in three.

The rest is what `--review` is for, and `--pin` is how they come back:

```json
{ "225877": {"cell": [-5, 22], "as": "printed W.C.II.14.ag"},
  "227433": {"cell": [31, -23], "as": "printed O.VIII.23.ag",
             "frame": [86, 87, 2552, 87, 2552, 2060, 86, 2060]},
  "-227435": "1853 reambulation, cut to its own frame — off the lattice" }
```

Both committed manifests are pinned this way, so every sheet in them sits where
its own printed designation says and not where an algorithm guessed. What the
automatic pass gets wrong is worth knowing for a whole-fond run: it fails where
a municipality has since been trimmed (the wash then covers ground today's
boundary no longer claims, so the shape argues for the wrong cell), and OCR
turns `h` into `g` often enough to matter. Two sheets also needed help of their
own — one trimmed so close to its border rule that the rule has no paper
outside it to be a rule against, and Gradac's 1853 reambulation, which is cut
to a frame of its own and is left out rather than forced onto the lattice.

### The survey's degrees are not today's degrees, here either

The Krim origin is 45°55′44.2″ N, 14°28′28.9″ E, and the projection is computed
on Bessel 1841 — which is the datum the survey was computed on, not the one a
map viewer uses. Treating its output as WGS 84 puts the sheets **370 m east** at
Kranj, the same drift the Spezialkarte sheets showed there (+264 m); `Cassini`
therefore converts through the same geocentric shift the 1:75 000 grid uses
(EPSG:1188). Do this and no other correction and Stražišče lands 80 m west.

`shift` closes that last 80 m, and it is measured rather than fitted to a
shape: the churches of St. Martin and St. Bartholomew, a kilometre apart, both
came out 80 m west and neither north nor south, so `ORIGINS["krim"]["shift"]`
is `[80, 0]`. It is one number for the crown land — every sheet of Carniola
moves by it together, and no sheet moves relative to its neighbour.

Checked afterwards: at Stražišče the two churches sit on their drawn symbols.
At Gradac, 60 km away and in the other half of the system, the church of St.
Mary comes out 27 m west and 46 m south — a residual of ~50 m, which is the
survey's own, and is left visible.

An earlier attempt measured this by sliding today's cadastral boundary over the
sheets' colour wash instead. It is recorded here as a warning: Stražišče's fit
was a hill rather than a peak (0.454 → 0.472 over 200 m) and Gradac's was
worthless, because that municipality has lost ground since 1824 and its 1824
wash and its 2026 boundary are not the same shape. Two churches beat two
polygons.

### What the archive actually filed, and where it stops

`--fond 176 --list index.csv` walks a fond and writes every municipality in it
with its record id, whether its sheets are online, and which modern k.o. it
answers to. Carniola: **932 municipalities, 865 of them scanned**, in three
districts (Ljubljana 349, Novo mesto 365, Postojna 218). Of those, 589 share a
name with exactly one modern k.o., 128 with several, and 215 with none — the
last two groups need `--sifko`, because the name is what says which section of
the lattice to look in.

The other thing a rollout meets is that **not every scan is one whole sheet**.
Some are a sheet photographed with a strip of its neighbour still attached,
some are a sheet with a corner mounted on separately, and some are trimmed
inside their own border rule. Measured over eight municipalities, the scans
that are not sheet-shaped (aspect outside 1.20–1.31) are where placement fails:

| k.o. | sheets | placed |
|---|---|---|
| Breg ob Kokri | 11 | 11 |
| Metlika | 9 | 9 |
| Bela | 9 | 9 |
| Štrekljevec | 8 | 8 |
| Stražišče | 7 | 7 |
| Gradac | 7 | 6 |
| Podzemelj | 6 | 6 |
| Drašiči | 6 | 6 |
| Krasinec | 6 | 4 |
| Kranj | 5 | 5 |
| Semič | 5 | 5 |

The per-edge detector alone reached 4 of Metlika's 9: it wants each border rule
to stand out on its own, and on a faint or trimmed scan one of the four never
does. `_fixed_size_frame` is what closed the gap. A cadastral sheet's frame is
a *known* size, so there is only one rectangle to place — slide it over the
scan and take the position where all four edges together land on the most ink.
Three faint rules and one clear one still find it. It carries a penalty against
the real readings, so it only wins where they fail, and it is checked the same
way afterwards: by the wash, the printed letter pair and the filing order.

Scans that are still beyond it: a sheet trimmed *inside* its own border rule
(there is no rectangle of the printed size to find), and a scan holding two
sheets at once where the fallback may bracket rules belonging to different
ones. Those come out in `--review`.

### Rebuilding

```sh
# crawl, download the scans, propose a placement, list what needs a look
python3 scripts/kataster-sheets.py --ko-id 225872 --name STRAŽIŠČE \
    --scans scripts/manifests/kataster-scans \
    --manifest scripts/manifests/kataster-strazisce.json --review review.txt

# then, with the review worked through
python3 scripts/kataster-sheets.py … --pin pins.json --calibrate

python3 scripts/overlay-tiles.py --manifest scripts/manifests/kataster-strazisce.json \
    --out public/tiles-local/kataster-strazisce --base-zoom 18 --min-zoom 2 --webp 90
```

Min zoom 2 is the Map chart's own shallowest zoom, and it matters: the chart
opens by fitting the tree's places at z10 or less, so a pyramid that stops at
z11 is invisible until you zoom in a step. A municipality is a speck at those
zooms and costs one tile each.

Base zoom 18: the scans are 0.771 m a pixel (a sheet's neatline measures
2460 × 1968 px for 1000 × 800 klafter, and every scan in the fond is at that one
resolution), which falls between z17 (0.83 m) and z18 (0.41 m). z17 would
resample the scan *down* by 7%, and the red parcel numbers — the thing a land
record is matched against — are what that costs first, so the base is z18 and
the scan is only ever enlarged. At WebP 90 a tile is then indistinguishable
from the scan it came from. A k.o. costs about 2 500 tiles and 12 MB; the scans
are **not** in the repo
— each sheet entry carries the `url` it came from, and `kataster-scans/` is
git-ignored.

Scale, for whoever runs the fond: roughly 2 700 municipalities at ~7 sheets
each, so ~19 000 scans (~10 GB) and, at 2 MB of tiles per k.o., something like
5 GB of pyramid.

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
