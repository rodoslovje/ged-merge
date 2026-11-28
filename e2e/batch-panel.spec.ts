import { test, expect } from "@playwright/test";

/**
 * Batch actions panel: the source picker is a search field, applying
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

  // The source picker is a search field: typing lists the matches — accents
  // ignored — under the "+ New source" row, and Enter picks the first match.
  await page.locator(".batch-action .batch-select").first().click();
  await page.locator(".dd-menu [role=option]", { hasText: "Add source citation" }).click();
  const field = page.locator(".batch-action .search-select-input");
  await expect(field).toHaveAttribute("placeholder", "Choose a source…");
  await field.click();
  await page.keyboard.type("smartin");
  const options = page.locator(".search-select .relative-picker-option");
  await expect(options).toHaveCount(2);
  await expect(options.nth(0)).toHaveClass(/relative-picker-new/);
  await expect(options.nth(1)).toHaveText("Poročna knjiga Šmartin");
  await page.keyboard.press("Enter");
  await expect(options).toHaveCount(0);
  await expect(field).toHaveValue("Poročna knjiga Šmartin");

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

const LABELS = `0 HEAD
1 GEDC
2 VERS 5.5.1
2 FORM LINEAGE-LINKED
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ana /Novak/
1 _LABL @L1@
0 @I2@ INDI
1 NAME Janez /Novak/
1 _LABL @L1@
1 _LABL @L2@
0 @I3@ INDI
1 NAME Miha /Kos/
0 @L1@ _LABL
1 TITL Incomplete
0 @L2@ _LABL
1 TITL Y-DNA
0 TRLR
`;

test("batch panel: a custom tag filter, and its lines converted into tasks", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles({ name: "labels.ged", mimeType: "text/plain", buffer: Buffer.from(LABELS) });
  await expect(page.locator(".edit-person").first()).toBeVisible();
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Normalize & batch", { exact: true }).first().click();
  await expect(page.locator(".batch-row")).toHaveCount(3);

  // The filter offers the file's custom tags; its text reads a pointer as the
  // title of the record it names.
  await page.locator(".batch-add-filter").click();
  await page.locator(".dd-menu [role=option]", { hasText: /^Custom tag$/ }).click();
  await expect(page.locator(".batch-crit .batch-select").nth(1)).toHaveText(/_LABL/);
  await expect(page.locator(".batch-row")).toHaveCount(2);
  await page.locator(".batch-crit .batch-input").fill("y-dna");
  await expect(page.locator(".batch-row")).toHaveCount(1);
  await page.locator(".batch-crit .batch-input").fill("incomplete");
  await expect(page.locator(".batch-row")).toHaveCount(2);

  // The action opens on the filter's tag and value, described by the label's title.
  await page.locator(".batch-action .batch-select").first().click();
  await page.locator(".dd-menu [role=option]", { hasText: "Convert custom tag to a task" }).click();
  const inputs = page.locator(".batch-action .batch-input");
  await expect(inputs.nth(0)).toHaveValue("incomplete");
  await expect(inputs.nth(1)).toHaveValue("Incomplete");
  await expect(page.locator(".batch-action input[type=checkbox]")).toBeChecked();

  await page.locator(".batch-action .tools-run").click();
  await page.locator(".confirm-dialog .confirm-dialog-confirm").click();
  await expect(page.locator(".batch-done")).toContainText("2 changed");
  // The label is off both people, so the filter finds nobody.
  await expect(page.locator(".batch-row")).toHaveCount(0);
});
