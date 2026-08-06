import { test, expect } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(__dirname, "../src/__fixtures__/corpus/reunion-5.5.1-utf8.ged");

// Opening one person after another in Edit is navigation, so the browser Back
// button has to undo it person by person — the way Edit's own Back button does.
// Before this, Edit kept that trail in its own state alone: the browser knew
// only the app's first entry, so Back went straight to "leave the page?".
test("Back walks back through the people opened in Edit", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(SAMPLE);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  const shownName = page.locator(".edit-person .edit-name-input").first();
  const names: string[] = [(await shownName.inputValue()).trim()];

  // Walk to a relative, twice, by clicking their card.
  for (let i = 0; i < 2; i++) {
    await page.locator(".person-card").filter({ hasNot: page.locator(".person-card-add") }).first().click();
    await expect(shownName).not.toHaveValue(names[names.length - 1]);
    names.push((await shownName.inputValue()).trim());
  }

  // Back retraces the trail one person at a time…
  await page.goBack();
  await expect(shownName).toHaveValue(names[1]);
  await page.goBack();
  await expect(shownName).toHaveValue(names[0]);

  // …and Edit's own Back button is on the same path, not pointing forward:
  // there is nothing left to go back to.
  await expect(page.getByRole("button", { name: "Back" })).toBeDisabled();
});
