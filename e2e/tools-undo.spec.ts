// Undoing a Tools-tab batch must apply where the user stands: no jump into
// Edit mode, and the geocode list rescans off the edit version so the undone
// rows come back. (A tools batch carries the undo entry's `stay` flag; the
// hidden EditView still applies the patches.)
import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import os from "os";
import path from "path";

const FILE = path.join(os.tmpdir(), "tools-undo.ged");

writeFileSync(
  FILE,
  [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Ana /Kos/",
    "1 BIRT", "2 PLAC Črni vrh",
    "0 TRLR", "",
  ].join("\n"),
  "utf-8",
);

test("undoing a tools rename restores the geocode row without leaving Tools", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Places", { exact: true }).click();
  await page.getByRole("button", { name: /Geocoding/ }).click();

  const places = page.locator(".tools-geocode .tools-tree > li:not(.v-spacer)");
  await expect(places).toHaveCount(1);
  await expect(places.first()).toContainText("Črni vrh");

  // Rename the row's raw value through the tools rename path.
  await places.first().hover();
  await places.first().locator(".tools-place-edit-btn").click();
  await page.locator(".tools-place-rename-input").fill("Beli vrh");
  await page.getByRole("button", { name: /Rename|Preimenuj/ }).click();
  await expect(places.first()).toContainText("Beli vrh");

  // Undo: must stay on the Tools page and restore the old value in the list.
  await page.getByRole("button", { name: /Undo|Razveljavi/ }).click();
  await expect(page.locator(".tools-geocode")).toBeVisible();
  await expect(places.first()).toContainText("Črni vrh", { timeout: 5000 });
});
