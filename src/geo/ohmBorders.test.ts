import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  adminMinZoom,
  aliveAt,
  bordersAt,
  borderWeight,
  decodeBorderTile,
  gridCoords,
  labelAnchor,
  ohmTileUrl,
  ringArea,
  sourceCoords,
  tileTransform,
} from "./ohmBorders";

// A real OpenHistoricalMap tile (zoom 10, over Ljubljana), stored as served but
// gzipped — in the browser fetch undoes that transport encoding itself. It is
// the boundary tileset's own bytes, so these tests fail if OHM's property names
// (`start_decdate`, `admin_level`, `name_sl`) ever move under us.
const TILE = gunzipSync(
  readFileSync(fileURLToPath(new URL("../__fixtures__/ohm/ohm-admin-z10-553-364.mvt.gz", import.meta.url))),
);
const buffer = () => TILE.buffer.slice(TILE.byteOffset, TILE.byteOffset + TILE.byteLength) as ArrayBuffer;

describe("aliveAt", () => {
  it("keeps a territory through the year it ended in", () => {
    // Austria-Hungary ended 1918-11-11 — 1918 is still its year, 1919 is not.
    const monarchy = { start: 1867.41, end: 1918.86 };
    expect(aliveAt(monarchy, 1918)).toBe(true);
    expect(aliveAt(monarchy, 1919)).toBe(false);
    expect(aliveAt(monarchy, 1867)).toBe(true);
    expect(aliveAt(monarchy, 1866)).toBe(false);
  });

  it("treats a missing end as still standing, a missing start as always there", () => {
    expect(aliveAt({ start: 1991.48 }, 2026)).toBe(true);
    expect(aliveAt({ start: 1991.48 }, 1990)).toBe(false);
    expect(aliveAt({ end: 1918.86 }, 1500)).toBe(true);
    expect(aliveAt({}, -3000)).toBe(true);
  });
});

describe("adminMinZoom / borderWeight", () => {
  it("draws countries at every zoom and communes only from close up", () => {
    expect(adminMinZoom(2)).toBe(0);
    expect(adminMinZoom(4)).toBe(3);
    expect(adminMinZoom(6)).toBe(8);
    expect(adminMinZoom(9)).toBe(11);
  });

  it("weights an empire's outline over the districts inside it", () => {
    expect(borderWeight(2)).toBeGreaterThan(borderWeight(4));
    expect(borderWeight(4)).toBeGreaterThan(borderWeight(6));
  });
});

describe("decodeBorderTile", () => {
  it("reads the territories of a real OHM tile", () => {
    const tile = decodeBorderTile(buffer());
    expect(tile.extent).toBe(4096);
    expect(tile.areas.length).toBeGreaterThan(100);
    // The duchy is in the tile several times over — a territory gets a new
    // record whenever its borders move — so it is the 1880 one that is checked.
    const krain = bordersAt(tile, 1880, 10).find((a) => a.name === "Herzogtum Krain");
    expect(krain).toBeDefined();
    expect(krain!.level).toBe(4);
    expect(krain!.startDate).toBe("1849-12-08");
    expect(krain!.endDate).toBe("1918-12-01");
    expect(krain!.rings.length).toBeGreaterThan(0);
  });

  it("takes the name in the interface's language where OHM has one", () => {
    const sl = decodeBorderTile(buffer(), "sl");
    expect(sl.areas.some((a) => a.name === "Vojvodina Kranjska")).toBe(true);
    // A language OHM doesn't carry falls back to the territory's own name.
    const none = decodeBorderTile(buffer(), "xx");
    expect(none.areas.some((a) => a.name === "Herzogtum Krain")).toBe(true);
  });
});

describe("bordersAt", () => {
  it("keeps the year's territories, largest first", () => {
    const tile = decodeBorderTile(buffer());
    const drawn = bordersAt(tile, 1880, 10);
    expect(drawn.map((a) => a.name)).toEqual([
      "Österreich-Ungarn / Ausztria-Magyarország",
      "Cisleithanien",
      "Herzogtum Krain",
    ]);
  });

  it("moves with the year", () => {
    const tile = decodeBorderTile(buffer());
    // Over one place: the Empire, then the Monarchy, then the kingdom that
    // followed it. (Between them sit years OHM has nothing mapped for — 1919
    // over this tile draws nothing at all, which is a gap in the data and not
    // in the reading of it.)
    expect(bordersAt(tile, 1780, 10).map((a) => a.name)).toContain("Sacrum Imperium Romanum");
    expect(bordersAt(tile, 1880, 10).map((a) => a.name)).toContain("Herzogtum Krain");
    expect(bordersAt(tile, 1935, 10).map((a) => a.name)).toContain(
      "Kraljevina Jugoslavija / Краљевина Југославија",
    );
    expect(bordersAt(tile, 1935, 10).some((a) => a.name === "Herzogtum Krain")).toBe(false);
  });

  it("drops the levels this zoom doesn't draw", () => {
    const tile = decodeBorderTile(buffer());
    // Cisleithania is level 3, which starts at zoom 5; the duchy (4) at zoom 3.
    const far = bordersAt(tile, 1880, 4);
    expect(far.some((a) => a.name === "Cisleithanien")).toBe(false);
    expect(far.some((a) => a.name === "Herzogtum Krain")).toBe(true);
  });
});

describe("gridCoords / sourceCoords / tileTransform", () => {
  it("reads a 512-px grid tile as the standard tile one zoom coarser", () => {
    // Leaflet numbers the drawn tile by the map's zoom whatever size it is;
    // what OHM serves for it is the z − 1 tile with the same x and y.
    expect(gridCoords({ z: 11, x: 553, y: 364 })).toEqual({ z: 10, x: 553, y: 364 });
  });

  it("fetches a tile itself until the deepest zoom, then its ancestor", () => {
    expect(sourceCoords({ z: 10, x: 553, y: 364 })).toEqual({ z: 10, x: 553, y: 364 });
    expect(sourceCoords({ z: 14, x: 8853, y: 5829 })).toEqual({ z: 12, x: 2213, y: 1457 });
  });

  it("scales a tile's own coordinates onto its canvas", () => {
    const coords = { z: 10, x: 553, y: 364 };
    const t = tileTransform(coords, coords, 4096, 256);
    expect(t.scale).toBe(256 / 4096);
    expect(t.dx).toBe(0);
    expect(t.dy).toBe(0);
    // The tile's far corner lands on the far corner of the canvas.
    expect(4096 * t.scale + t.dx).toBe(256);
  });

  it("blows an ancestor up and slides the right part of it into view", () => {
    const source = { z: 12, x: 2213, y: 1457 };
    // The second of the four children in each direction: the ancestor's middle
    // becomes this canvas's origin.
    const child = { z: 13, x: 4427, y: 2915 };
    const t = tileTransform(child, source, 4096, 256);
    expect(t.scale).toBe((2 * 256) / 4096);
    expect(2048 * t.scale + t.dx).toBe(0);
    expect(4096 * t.scale + t.dx).toBe(256);
  });
});

describe("ringArea / labelAnchor", () => {
  const square = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ];

  it("measures a ring however it winds", () => {
    expect(Math.abs(ringArea(square))).toBe(10000);
    expect(Math.abs(ringArea([...square].reverse()))).toBe(10000);
  });

  it("puts the name in the middle of a territory's largest part", () => {
    const small = square.map((p) => ({ x: p.x / 10 + 500, y: p.y / 10 + 500 }));
    const anchor = labelAnchor({ id: 1, level: 4, name: "Krain", rings: [small, square] });
    expect(anchor).toEqual({ x: 50, y: 50, area: 10000 });
  });

  it("has nowhere to write a name on a degenerate ring", () => {
    expect(labelAnchor({ id: 1, level: 4, name: "x", rings: [] })).toBeUndefined();
    expect(
      labelAnchor({
        id: 1,
        level: 4,
        name: "x",
        rings: [
          [
            { x: 5, y: 5 },
            { x: 5, y: 5 },
          ],
        ],
      }),
    ).toBeUndefined();
  });
});

describe("ohmTileUrl", () => {
  it("fills the template", () => {
    expect(ohmTileUrl({ z: 10, x: 553, y: 364 })).toBe(
      "https://vtiles.openhistoricalmap.org/maps/ohm_admin/10/553/364.pbf",
    );
  });
});
