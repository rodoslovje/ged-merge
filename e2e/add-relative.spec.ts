import { test, expect } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(__dirname, "../src/__fixtures__/corpus/reunion-5.5.1-utf8.ged");

test("edit mode: adding father/mother/partner/child creates new people and links them", async ({ page }) => {
  await page.goto("/");

  await page.locator('input.file-input').first().setInputFiles(SAMPLE);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  // Navigate up the paternal line until we find someone missing their own parents.
  for (let i = 0; i < 10; i++) {
    if (await page.locator(".edit-parents .person-card-add", { hasText: "Add father" }).count()) break;
    await page.locator(".edit-parents .person-card-wrap", { hasText: "Father" }).locator("button.person-card").click();
    await page.locator(".edit-name-input").first().waitFor();
  }

  // Add a father — clicking the placeholder opens a search-or-add picker;
  // "+ Add new person" creates a blank individual, which becomes selected.
  await page.locator(".edit-parents .person-card-add", { hasText: "Add father" }).first().click();
  await page.locator(".relative-picker-new").click();
  await page.locator(".edit-name-input").first().waitFor();
  await page.locator(".edit-name-input").first().fill("New Father");
  await page.locator(".sex-select").click();
  await page.locator('.dd-menu .dd-item[data-value="M"]').click();

  // The new father's only family is the one he now shares with the ancestor as
  // a child — "+ Add partner" fills its missing WIFE slot, i.e. adds the ancestor's mother.
  await page.locator(".edit-families .person-card-add", { hasText: "Add partner" }).first().click();
  await page.locator(".relative-picker-new").click();
  await page.locator(".edit-name-input").first().waitFor();
  await page.locator(".edit-name-input").first().fill("New Mother");

  // "+ Add child" on that same family adds a sibling of the ancestor.
  await page.locator(".edit-children .person-card-add", { hasText: "Add child" }).first().click();
  await page.locator(".relative-picker-new").click();
  await page.locator(".edit-name-input").first().waitFor();
  await page.locator(".edit-name-input").first().fill("New Sibling");

  // Go back to "New Mother" — her partner is "New Father", and her children
  // include both the ancestor and the new sibling.
  await page.locator(".tree-open-btn", { hasText: "Back" }).click(); // -> New Mother
  await expect(page.locator(".edit-families")).toContainText("New Father");
  await expect(page.locator(".edit-children")).toContainText("New Sibling");

  await page.locator(".tree-open-btn", { hasText: "Back" }).click(); // -> New Father
  await page.locator(".tree-open-btn", { hasText: "Back" }).click(); // -> original ancestor
  await expect(page.locator(".edit-parents")).toContainText("New Father");
  await expect(page.locator(".edit-parents")).toContainText("New Mother");

  // New Mother's only family now names a partner, so her page offers one more
  // "+ Add partner" card after it — a brand-new union, i.e. a second family.
  await page.locator(".edit-parents .person-card-wrap", { hasText: "Mother" }).locator("button.person-card").click();
  // Her partner card names New Father — proof the navigation landed.
  await expect(page.locator(".edit-families")).toContainText("New Father");
  await page.locator(".edit-family-new .person-card-add", { hasText: "Add partner" }).click();
  await page.locator(".relative-picker-new").click();
  await page.locator(".edit-name-input").first().waitFor();
  await page.locator(".edit-name-input").first().fill("Second Husband");

  await page.locator(".tree-open-btn", { hasText: "Back" }).click(); // -> New Mother
  await expect(page.locator(".edit-families")).toContainText("New Father");
  await expect(page.locator(".edit-families")).toContainText("Second Husband");
  // Two real families plus the offer of a third.
  await expect(page.locator(".edit-families .edit-family")).toHaveCount(3);

  await expect(page.locator(".app-head-actions .export-btn")).toBeEnabled();
});
