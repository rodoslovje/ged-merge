import { test, expect } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(__dirname, "../src/__fixtures__/corpus/reunion-5.5.1-utf8.ged");

/** Load the sample and wait for Edit mode (the default) to render. */
async function loadSample(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(SAMPLE);
  await page.locator(".edit-person").waitFor();
}

test("global search: / opens the dialog, finds a person, and opens them in Edit", async ({ page }) => {
  await loadSample(page);

  // `/` opens the whole-file search from Edit mode.
  await page.keyboard.press("/");
  const modal = page.locator(".global-search-modal");
  await expect(modal).toBeVisible();

  await modal.locator(".global-search-input").fill("marta3 moha");
  const rows = modal.locator(".global-search-row");
  await expect(rows.first()).toBeVisible();
  await expect(rows.first()).toContainText("Marta3");

  // Opening a result closes the dialog and lands on that person in Edit.
  await rows.first().locator(".global-search-open").click();
  await expect(modal).toHaveCount(0);
  await expect(page.locator(".edit-name-input").first()).toHaveValue(/Marta3/);
});

test("global search: Escape closes the dialog without navigating", async ({ page }) => {
  await loadSample(page);
  const givenBefore = await page.locator(".edit-name-input").first().inputValue();

  await page.keyboard.press("/");
  await expect(page.locator(".global-search-modal")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".global-search-modal")).toHaveCount(0);

  // The person shown in Edit is unchanged.
  await expect(page.locator(".edit-name-input").first()).toHaveValue(givenBefore);
});

test("global search: the Born facet narrows results", async ({ page }) => {
  await loadSample(page);

  await page.keyboard.press("/");
  const modal = page.locator(".global-search-modal");
  await modal.locator(".global-search-input").fill("marta3 karel2");
  await expect(modal.locator(".global-search-row", { hasText: "Karel2" })).toHaveCount(1);

  // Marta3 Karel2 Moharič was born 1934; a "born from 1950" facet must exclude her.
  await modal.locator(".global-search-filter-toggle").click();
  await modal.locator(".gsf-year").first().fill("1950");
  await expect(modal.locator(".global-search-row", { hasText: "Karel2" })).toHaveCount(0);
});
