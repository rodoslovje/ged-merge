import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

const MAIN = path.join(tmpdir(), "gs-main.ged");
const COMPARE = path.join(tmpdir(), "gs-compare.ged");

writeFileSync(MAIN, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Ana /Kukic/", "1 SEX F",
  "1 BIRT", "2 DATE 9 AUG 1982", "2 PLAC Kranj",
  "0 TRLR", "",
].join("\n"), "utf-8");

writeFileSync(COMPARE, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Ana /Kukic/", "1 SEX F",
  "1 BIRT", "2 DATE 9 AUG 1982", "2 PLAC Kranj",
  "1 BAPM", "2 DATE 6 OCT 1982", "2 PLAC Strazisce,Kranj,Slovenia",
  "0 TRLR", "",
].join("\n"), "utf-8");

/** Load main + compare and wait for the match candidate list to appear. */
async function loadWithMatches(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(MAIN);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Merge", exact: true }).click();
  await page.locator("input.file-input").last().setInputFiles(COMPARE);
  await page.locator(".candidate").first().waitFor({ timeout: 30000 });
}

test("global search: opening a candidate from Merge stays in Merge on that pair", async ({ page }) => {
  await loadWithMatches(page);

  await page.keyboard.press("/");
  const modal = page.locator(".global-search-modal");
  await expect(modal).toBeVisible();
  await modal.locator(".global-search-input").fill("ana kukic");
  await modal.locator(".global-search-row").first().locator(".global-search-open").click();

  await expect(modal).toHaveCount(0);
  await expect(page.locator(".mode-tabs .seg-btn.active")).toHaveText("Merge");
  await expect(page.locator(".candidate.selected")).toContainText("Kukic");
});

test("global search: opening a person from Edit stays in Edit (mode-aware)", async ({ page }) => {
  await loadWithMatches(page);

  // In Edit, opening a person who is *also* a match candidate must not yank the
  // user into Merge — it opens them in Edit.
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").first().waitFor();

  await page.keyboard.press("/");
  const modal = page.locator(".global-search-modal");
  await modal.locator(".global-search-input").fill("ana kukic");
  await modal.locator(".global-search-row").first().locator(".global-search-open").click();

  await expect(modal).toHaveCount(0);
  await expect(page.locator(".mode-tabs .seg-btn.active")).toHaveText("Edit");
  await expect(page.locator(".edit-name-input").first()).toHaveValue(/Ana/);
});

test("global search: Ctrl+F focuses the match name filter", async ({ page }) => {
  await loadWithMatches(page);

  await page.keyboard.press("ControlOrMeta+f");
  await expect(page.locator(".name-search")).toBeFocused();
});
