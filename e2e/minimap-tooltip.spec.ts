import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import os from "os";
import path from "path";

// A mini-map pin says what it is about — the place, its address — and prints
// its coordinate the way the app prints coordinates everywhere else.

const FILE = path.join(os.tmpdir(), "minimap-tooltip.ged");

writeFileSync(
  FILE,
  [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Ana /Kos/",
    "1 BIRT", "2 PLAC Otlica, Ajdovščina, Slovenija",
    "3 MAP", "4 LATI N45.93851", "4 LONG E13.91788",
    "0 TRLR", "",
  ].join("\n"),
  "utf-8",
);

test("a place's map pin names the place and prints its coordinate", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Places", { exact: true }).click();

  // The tree opens expanded, so the settlement carrying the coordinate is
  // already on screen; its coordinate opens the row's own map.
  const coord = page.locator(".tools-place-coord").first();
  await expect(coord).toBeVisible();
  await coord.click();

  const pin = page.locator(".tools-place-map .leaflet-interactive").first();
  await expect(pin).toBeVisible({ timeout: 15000 });
  await pin.hover({ force: true });

  const tip = page.locator(".minimap-tooltip").first();
  await expect(tip).toBeVisible();
  // The place as the file writes it, and the coordinate on its own pinned row
  // rather than standing in as the title.
  await expect(tip).toContainText("Otlica, Ajdovščina, Slovenija");
  await expect(tip.locator(".gm-coord--set")).toHaveText("45.93851, 13.91788");
});
