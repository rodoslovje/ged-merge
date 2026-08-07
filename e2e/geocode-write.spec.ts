import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import os from "os";
import path from "path";

// A place written twice, placed once: the second mention has no coordinate, so
// the row proposes the one the file itself already carries.
//
// What this guards is the row's answer to "what will be written". Declining the
// proposal (clicking the option that is already selected) leaves the row with no
// coordinate at all — and the row must then say so: no position on the header
// line, and no way to tick it into a write that would do nothing. Clicking the
// option again takes it back, and the write lands.

const FILE = path.join(os.tmpdir(), "geocode-write.ged");

writeFileSync(
  FILE,
  [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Ana /Kos/",
    "1 BIRT", "2 PLAC Kranj, Kranj, Slovenia", "3 MAP", "4 LATI N46.2396", "4 LONG E14.3563",
    "0 @I2@ INDI", "1 NAME Bo /Kos/",
    "1 BIRT", "2 PLAC Kranj, Kranj, Slovenia",
    "0 TRLR", "",
  ].join("\n"),
  "utf-8",
);

test("a declined proposal writes nothing — and says so instead of arming the button", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Places", { exact: true }).click();
  await page.getByRole("button", { name: /Geocoding/ }).click();

  const row = page.locator(".tools-geocode .tools-tree > li:not(.v-spacer)").first();
  await expect(row).toContainText("Kranj, Kranj, Slovenia");
  const coord = row.locator(".tools-geo-coord-btn");
  const write = page.getByRole("button", { name: /^Write coordinates/ });

  // The file's own coordinate is the standing proposal — shown, but nothing is
  // staged until the researcher picks it.
  await expect(coord).toContainText("46.2396, 14.3563");
  await expect(coord).not.toHaveClass(/staged/);
  await expect(write).toContainText("(0)");

  await row.locator(".tools-pair-toggle").click();
  const fromFile = row.getByRole("radio", { name: "from this file" });
  // The radio itself sits under its number badge — click the option the way a
  // reader does, on its line.
  const fromFileOption = row.locator("label").filter({ hasText: "from this file" });
  await expect(fromFile).not.toBeChecked();

  // Picking it is what stages the row: the header's coordinate says so, and the
  // write reaches the mention that had no coordinate — one record, not zero.
  await fromFileOption.click();
  await expect(fromFile).toBeChecked();
  await expect(coord).toHaveClass(/staged/);
  await expect(write).toContainText("(1)");

  // Picking it again drops it — a radio group has no "none" of its own.
  await fromFileOption.click();
  await expect(fromFile).not.toBeChecked();
  await expect(coord).not.toHaveClass(/staged/);
  await expect(write).toContainText("(0)");

  await fromFileOption.click();
  await write.click();
  await expect(page.getByText("1 record updated")).toBeVisible();
  await expect(page.getByText("Every place reference already carries coordinates.")).toBeVisible();
});
