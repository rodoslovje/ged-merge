import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "fs";
import { gunzipSync } from "zlib";
import path from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "./tmpdir";

// Period borders on the Map chart: the chip draws OpenHistoricalMap's
// territories for the year the filter ends at, and moving that year redraws
// them. OHM itself is stubbed with the same tile the unit tests read, so the
// suite never touches the network and the drawing is the only thing under test.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TILE = gunzipSync(readFileSync(path.resolve(__dirname, "../src/__fixtures__/ohm/ohm-admin-z10-553-364.mvt.gz")));

const MAP_KEY = "8";

// Two placed events, a lifetime apart, so the year filter has a range to move.
const MAPPED = path.join(tmpdir(), "borders.ged");
const KRANJ = ["3 MAP", "4 LATI N46.239", "4 LONG E14.355"];
writeFileSync(
  MAPPED,
  [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Ana /Kovac/", "1 SEX F",
    "1 BIRT", "2 DATE 12 JAN 1860", "2 PLAC Kranj,Kranj,Slovenia", ...KRANJ,
    "1 DEAT", "2 DATE 1935", "2 PLAC Kranj,Kranj,Slovenia", ...KRANJ,
    "0 TRLR", "",
  ].join("\n"),
  "utf-8",
);

test("the borders chip draws OHM's territories for the year the filter ends at", async ({ page }) => {
  // Tiles are opt-in, and both providers are stubbed: the base map with a
  // transparent pixel, OHM with one real boundary tile served for every
  // coordinate, so whatever the map asks for it gets the same territories.
  await page.addInitScript(() => {
    localStorage.setItem("gedmerge.settings", JSON.stringify({ allowMapTiles: true }));
  });
  await page.route("**/basemaps.cartocdn.com/**", (route) =>
    route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64",
      ),
    }),
  );
  let tileRequests = 0;
  await page.route("**/vtiles.openhistoricalmap.org/**", (route) => {
    tileRequests++;
    return route.fulfill({ contentType: "application/x-protobuf", body: TILE });
  });

  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(MAPPED);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });
  await page.locator(".charts-open-btn").first().click();
  await page.keyboard.press(MAP_KEY);
  await page.locator(".map-count").first().waitFor({ timeout: 20000 });

  // Off, the chip is the bare word: no year, because none is being drawn.
  const chip = page.locator(".map-borders-chip");
  await expect(chip).not.toContainText("1935");
  await expect(page.locator("canvas.leaflet-tile")).toHaveCount(0);

  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  // On, it carries the year it draws — the far end of the year filter.
  await expect(chip).toContainText("1935");
  // Canvas tiles, because OHM ships vector tiles the app draws itself.
  await expect(page.locator("canvas.leaflet-tile-loaded").first()).toBeVisible({ timeout: 20000 });
  // The chart's own map is the first of the two on the page — Edit's place map
  // stays mounted behind it, and carries only the base map's credit.
  await expect(page.locator(".leaflet-control-attribution").first()).toContainText("OpenHistoricalMap");

  // Moving the year redraws what is already in hand: no further requests.
  const fetched = tileRequests;
  await page.locator(".map-year-input").last().fill("1880");
  await expect(chip).toContainText("1880");
  await expect(page.locator("canvas.leaflet-tile-loaded").first()).toBeVisible();
  expect(tileRequests).toBe(fetched);

  // Switching it off takes the layer, and the year, with it.
  await chip.click();
  await expect(page.locator("canvas.leaflet-tile")).toHaveCount(0);
  await expect(chip).not.toContainText("1880");
});
