import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// Some programs write an event's address only as labelled lines — ADR1, CITY,
// POST under an ADDR that has no text of its own. The places tree and the
// geocoding address list read it as the lines joined, and renaming the house
// rewrites the line that says it, keeping the others.

const FILE = path.join(tmpdir(), "structured-address-tools.ged");

writeFileSync(
  FILE,
  [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Ana /Kos/",
    "1 BIRT", "2 DATE 1901", "2 PLAC Ljubljana, Slovenija",
    "2 ADDR", "3 ADR1 Dunajska 5", "3 CITY Ljubljana", "3 POST 1000",
    "0 @I2@ INDI", "1 NAME Bo /Kos/",
    "1 BIRT", "2 DATE 1903", "2 PLAC Ljubljana, Slovenija",
    "0 TRLR", "",
  ].join("\n"),
  "utf-8",
);

test("an address written only in labelled lines is listed, and renamed in its lines", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor();

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Places", { exact: true }).click();

  // The places tree hangs the house off its settlement.
  const slovenia = page.locator(".tools-tree > li").filter({ hasText: "Slovenija" }).first();
  await expect(slovenia).toBeVisible();
  const house = slovenia.locator(".tools-tree-addr").filter({ hasText: "Dunajska 5" });
  await expect(async () => {
    if (!(await house.isVisible())) await slovenia.locator(".tools-tree-label").filter({ hasText: "Ljubljana" }).first().click();
    await expect(house).toHaveCount(1, { timeout: 1000 });
  }).toPass({ timeout: 15_000 });

  // The geocoding address list carries it as the lines joined.
  await page.getByRole("button", { name: /Geocoding/ }).click();
  await page.locator(".tools-geo-tabs").getByRole("tab", { name: /Addresses/ }).click();
  await page.getByRole("button", { name: "Expand all" }).click();
  const rows = page.locator(".tools-geo-addr-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Dunajska 5, Ljubljana, 1000");

  // Renamed from its ✎: the street line takes the new spelling.
  await rows.first().locator(".tools-place-edit-btn").click();
  const field = page.locator(".tools-geo-addr-row .tools-place-rename-input");
  await expect(field).toHaveValue("Dunajska 5, Ljubljana, 1000");
  await field.fill("Dunajska cesta 5, Ljubljana, 1000");
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(rows.first()).toContainText("Dunajska cesta 5, Ljubljana, 1000");

  // Saved: the ADDR still has no text of its own, ADR1 is renamed, the rest kept.
  const saveBtn = page.locator(".app-head-actions .export-btn");
  await expect(saveBtn).toBeEnabled();
  await saveBtn.click();
  const download = page.waitForEvent("download", (d) => d.suggestedFilename().endsWith(".ged"));
  await page.locator(".preview-actions .export-btn").click();
  const saved = readFileSync((await (await download).path())!, "utf-8").replace(/\r\n/g, "\n");
  expect(saved).toContain("2 ADDR\n3 ADR1 Dunajska cesta 5\n3 CITY Ljubljana\n3 POST 1000\n");
  expect(saved).not.toContain("Dunajska 5");
});
