import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// The Contemporaries chart's Map layout: each relative at one place, and the
// ones with no place listed rather than guessed.

// Root Ana, born in Kranj (coordinated). Father Jožef: born in Kranj
// (coordinated). Mother Marija: a birth place with no coordinates. Brother
// Peter: no place at all. All four lives overlap Ana's.
const FILE = path.join(tmpdir(), "kin-map.ged");
const KRANJ = ["3 MAP", "4 LATI N46.239", "4 LONG E14.355"];
writeFileSync(FILE, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Ana /Kovac/", "1 SEX F",
  "1 BIRT", "2 DATE 12 JAN 1900", "2 PLAC Kranj,Kranj,Slovenia", ...KRANJ,
  "1 DEAT", "2 DATE 1975",
  "1 FAMC @F1@",
  "0 @I2@ INDI", "1 NAME Jozef /Kovac/", "1 SEX M",
  "1 BIRT", "2 DATE 1870", "2 PLAC Kranj,Kranj,Slovenia", ...KRANJ,
  "1 DEAT", "2 DATE 1940",
  "1 FAMS @F1@",
  "0 @I3@ INDI", "1 NAME Marija /Novak/", "1 SEX F",
  "1 BIRT", "2 DATE 1875", "2 PLAC Delnice,Gorski kotar,Croatia",
  "1 DEAT", "2 DATE 1950",
  "1 FAMS @F1@",
  "0 @I4@ INDI", "1 NAME Peter /Kovac/", "1 SEX M",
  "1 BIRT", "2 DATE 1902",
  "1 DEAT", "2 DATE 1960",
  "1 FAMC @F1@",
  "0 @F1@ FAM", "1 HUSB @I2@", "1 WIFE @I3@", "1 CHIL @I1@", "1 CHIL @I4@",
  "0 TRLR", "",
].join("\n"), "utf-8");

test("the map layout places the coordinated and lists the rest", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor();
  await page.locator(".charts-open-btn").first().click();
  // By name, not by digit: the digit moves whenever a kind is added or folded.
  await page.getByRole("tablist", { name: "Chart kind" }).getByRole("tab", { name: "Contemporaries" }).click();
  await expect(page.locator(".kin-svg")).toBeVisible();

  // The layout's own tab strip — the hub's kind strip has a "Map" tab too.
  const layouts = page.getByRole("tablist", { name: "Layout" });
  await layouts.getByRole("tab", { name: "Map" }).click();
  // Leaflet arrives lazily; the map, the father's dot and the root's hub follow.
  await expect(page.locator(".kin-map-wrap .map-canvas")).toBeVisible();
  // The wheel's canvas must be off the page, not just empty: mounted over the
  // map it swallowed the drags and wheels that started on open water.
  await expect(page.locator(".kin-map-wrap .tree-canvas")).toBeHidden();
  // A drag on open water moves the map.
  const canvas = page.locator(".kin-map-wrap .map-canvas");
  const centerBefore = await canvas.evaluate((el) =>
    (el as HTMLDivElement & { _leafletMap?: { getCenter(): { lat: number; lng: number } } })._leafletMap!.getCenter().lng,
  );
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.8);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.8, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(() =>
      canvas.evaluate((el) =>
        (el as HTMLDivElement & { _leafletMap?: { getCenter(): { lat: number; lng: number } } })._leafletMap!.getCenter().lng,
      ),
    )
    .not.toBe(centerBefore);
  // Let the drag's inertia run out — it can carry the dot clean out of view —
  // then the fit button brings the dots back before one is clicked.
  await canvas.evaluate(
    (el) =>
      new Promise<void>((resolve) => {
        const map = (el as HTMLDivElement & { _leafletMap?: { getCenter(): { equals(o: unknown): boolean } } })._leafletMap!;
        let last = map.getCenter();
        const timer = setInterval(() => {
          const now = map.getCenter();
          if (now.equals(last)) {
            clearInterval(timer);
            resolve();
          }
          last = now;
        }, 150);
      }),
  );
  await page.locator(".kin-map-wrap .map-fit-link").click();
  await expect(page.locator(".kin-map-dot")).toHaveCount(1);
  await expect(page.locator(".kin-map-hub-initials")).toHaveText("AK");
  await expect(page.locator(".kin-count")).toContainText("1 on the map");

  // The two without coordinates are counted, and the count opens their list —
  // split by what each lacks, with the geocoding tool offered for the one a
  // geocode would fix.
  const unplaced = page.locator(".kin-unplaced-btn");
  await expect(unplaced).toHaveText("2 not placed");
  await unplaced.click();
  const panel = page.locator(".kin-unplaced-panel");
  await expect(panel).toBeVisible();
  await expect(panel.locator(".kin-unplaced-group")).toHaveText([/Place without coordinates: 1/, /No place at all: 1/]);
  await expect(panel.locator(".map-panel-person")).toHaveText([/Marija/, /Peter/]);
  await expect(panel.getByRole("button", { name: "Geocode places" })).toBeVisible();
  // …and it opens the tool: the chart closes, the geocoding page comes up, and
  // Back returns to the chart. Then straight back to the map for the rest.
  await panel.getByRole("button", { name: "Geocode places" }).click();
  await expect(page.locator(".tools-geocode, .tools-geo-addr-list").first()).toBeVisible();
  await expect(page.locator(".kin-map-wrap")).toHaveCount(0);
  await page.goBack();
  await expect(page.locator(".kin-map-wrap .map-canvas")).toBeVisible();
  await expect(page.locator(".kin-map-dot")).toHaveCount(1);

  // A dot opens the person's panel.
  await page.locator(".kin-map-dot").click();
  await expect(page.locator(".kin-map-wrap .tree-compare")).toContainText("Jozef");

  // The wheel comes back on its tab, map gone.
  await layouts.getByRole("tab", { name: "Wheel" }).click();
  await expect(page.locator(".kin-svg")).toBeVisible();
  await expect(page.locator(".kin-map-wrap")).toHaveCount(0);
});
