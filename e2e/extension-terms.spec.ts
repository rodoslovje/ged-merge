import { expect, test } from "@playwright/test";

/**
 * The pages behind the URIs a GEDCOM 7 header's HEAD.SCHMA gets for extension
 * tags (src/terms/): the index, a tag's page reached by its URI's path (no
 * trailing slash), and an unknown tag's page, which names the tag.
 */

test("the extension-tag index links each tag to its page", async ({ page }) => {
  await page.goto("/terms/extensions/");
  await expect(page.getByRole("heading", { level: 1, name: "GEDCOM extension tags" })).toBeVisible();
  await page.locator("#myheritage").getByRole("link", { name: "_UPD", exact: true }).click();
  await expect(page).toHaveURL(/\/terms\/myheritage\/_UPD\/$/);
  await expect(page.getByRole("heading", { level: 1, name: "_UPD" })).toBeVisible();
  await expect(page.getByText("Slovensko: časovni žig zadnje spremembe")).toBeVisible();
});

test("a tag's URI path without the slash opens its page, styled", async ({ page }) => {
  await page.goto("/terms/common/_MARNM");
  await expect(page).toHaveURL(/\/terms\/common\/_MARNM\/$/);
  await expect(page.getByRole("heading", { level: 1, name: "_MARNM" })).toBeVisible();
  // The site's theme applies: its tokens are defined on the page.
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()))
    .not.toBe("");
});

test("an unknown tag's URI names the tag", async ({ page }) => {
  await page.goto("/terms/unknown/#_myTag");
  await expect(page.getByRole("heading", { level: 1, name: "_myTag" })).toBeVisible();
  await expect(page.getByText("whose meaning GED Merge does not know")).toBeVisible();
});
