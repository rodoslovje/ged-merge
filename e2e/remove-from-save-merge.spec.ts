import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

/**
 * "Remove from Save" in a merge preview. The preview of a merge is the output
 * of the merge over a clone of the file, and taking an edit out of it reverted
 * the live record only: the download still carried the edit while the report
 * no longer listed it. The preview is now built again after the removal.
 */
const MAIN = path.join(tmpdir(), "rfs-main.ged");
const COMPARE = path.join(tmpdir(), "rfs-compare.ged");

writeFileSync(MAIN, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Marija /Kos/", "1 SEX F",
  "0 @I2@ INDI", "1 NAME Janez /Novak/", "1 SEX M",
  "1 BIRT", "2 DATE 12 MAR 1850",
  "0 TRLR", "",
].join("\n"), "utf-8");

writeFileSync(COMPARE, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @P1@ INDI", "1 NAME Janez /Novak/", "1 SEX M",
  "1 BIRT", "2 DATE 12 MAR 1850", "2 PLAC Kranj,Slovenia",
  "0 TRLR", "",
].join("\n"), "utf-8");

test("removing an edit from a merge save leaves it out of the download", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(MAIN);
  await page.locator(".edit-person").first().waitFor();

  // Edit Marija's given name.
  const given = page.locator(".edit-name-input").first();
  await expect(given).toHaveValue("Marija");
  await given.fill("Mojca");
  await given.press("Enter");

  await page.getByRole("button", { name: "Merge", exact: true }).click();
  await page.locator("input.file-input").last().setInputFiles(COMPARE);
  await page.locator(".candidate").first().waitFor();
  await page.locator(".candidate-main").first().click();
  await page.locator(".decision-bar button").first().click();

  await page.locator(".app-head-actions .export-btn").click();
  const editedCard = page.locator(".preview-card").filter({ hasText: "Mojca" });
  await expect(editedCard).toHaveCount(1);
  await editedCard.locator(".preview-item-remove").click();
  await expect(page.locator(".preview-card").filter({ hasText: "Mojca" })).toHaveCount(0);

  const ged = page.waitForEvent("download", (d) => d.suggestedFilename().endsWith(".ged"));
  await page.locator(".preview-actions .export-btn").click();
  const text = readFileSync((await (await ged).path())!, "utf-8");
  expect(text).toContain("1 NAME Marija /Kos/");
  expect(text).not.toContain("Mojca");
  // The merge itself still lands.
  expect(text).toContain("2 PLAC Kranj,Slovenia");
});
