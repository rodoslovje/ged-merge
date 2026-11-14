import { test, expect } from "@playwright/test";

/**
 * Batch actions panel: the source picker narrows to what is typed, applying
 * asks in a dialog first, and Clear all starts over.
 */
const GED = `0 HEAD
1 GEDC
2 VERS 5.5.1
2 FORM LINEAGE-LINKED
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ana /Novak/
1 SEX F
0 @I2@ INDI
1 NAME Janez /Novak/
1 SEX M
0 @S1@ SOUR
1 TITL Krstna knjiga Kranj 1832-1870
0 @S2@ SOUR
1 TITL Mrliška knjiga Vojsko
0 @S3@ SOUR
1 TITL Poročna knjiga Šmartin
0 TRLR
`;

test("batch panel: searchable source picker, confirm dialog, Clear all", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles({ name: "batch.ged", mimeType: "text/plain", buffer: Buffer.from(GED) });
  await expect(page.locator(".edit-person").first()).toBeVisible();
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Normalize & batch", { exact: true }).first().click();
  await expect(page.locator(".batch-row")).toHaveCount(2);

  // A filter from the grouped menu.
  await page.locator(".batch-add-filter").click();
  await expect(page.locator(".dd-menu .dd-group-label").first()).toHaveText("Person");
  await page.locator(".dd-menu [role=option]", { hasText: /^Sex$/ }).click();
  await expect(page.locator(".batch-row")).toHaveCount(1);

  // The source picker narrows as you type — accents ignored.
  await page.locator(".batch-action .batch-select").first().click();
  await page.locator(".dd-menu [role=option]", { hasText: "Add source citation" }).click();
  await page.locator(".batch-action .batch-media-select").click();
  await expect(page.locator(".dd-menu .dd-search")).toHaveText("Type to search…");
  await page.keyboard.type("smartin");
  await expect(page.locator(".dd-menu [role=option]")).toHaveCount(1);
  await expect(page.locator(".dd-menu [role=option]")).toHaveText("Poročna knjiga Šmartin");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Enter");
  await expect(page.locator(".batch-action .batch-media-select")).toHaveText(/Poročna knjiga Šmartin/);

  // Applying asks in a dialog; Cancel changes nothing.
  await page.locator(".batch-action .tools-run").click();
  await expect(page.locator(".confirm-dialog")).toBeVisible();
  await page.locator(".confirm-dialog").getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator(".confirm-dialog")).toHaveCount(0);
  await expect(page.locator(".batch-done")).toHaveCount(0);

  // Clear all removes the filter and the action.
  await page.getByRole("button", { name: "Clear all" }).click();
  await expect(page.locator(".batch-crit")).toHaveCount(0);
  await expect(page.locator(".batch-row")).toHaveCount(2);
  await expect(page.locator(".batch-action .batch-select").first()).toHaveText(/Choose an action/);
});
