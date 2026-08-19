import { test, expect } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(__dirname, "../src/__fixtures__/corpus/reunion-5.5.1-utf8.ged");

// Settings › Editing › "Married surname from partner": adding a wife to a man
// whose surname is known writes his surname as her married name. The picker
// makes her record before her own name is typed, and the married name used to
// be skipped for want of a primary NAME to hang on — so the setting did
// nothing at all on the path the card itself leads you down.
test("a wife added to a husband takes his surname as her married name", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(SAMPLE);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  // Turn the opt-in on.
  await page.locator('button[title*="etting"]').first().click();
  const toggle = page.locator(".settings-row-toggle", { hasText: "Married surname from partner" }).locator("input");
  await toggle.check();
  await page.keyboard.press("Escape");
  await page.locator(".edit-person").waitFor();

  // A man with a surname, and no partner yet: give him one.
  await page.locator(".edit-name-input").first().waitFor();
  await page.locator(".edit-name-input").first().fill("Janez");
  await page.locator(".edit-name-input").nth(1).fill("Košnjek");
  await page.locator(".sex-select").click();
  await page.locator('.dd-menu .dd-item[data-value="M"]').click();

  // "+ Add new person" with nothing typed — her name comes later, in the card.
  await page.locator(".edit-families .person-card-add", { hasText: "Add partner" }).first().click();
  await page.locator(".relative-picker-new").click();
  await page.locator(".edit-name-input").first().waitFor();

  // Her married name is already there, as a chip beside her own (still empty) name.
  const chips = page.locator(".edit-other-names");
  await expect(chips).toContainText("Košnjek");

  // Typing her own name fills the primary line, leaving the married one alone.
  await page.locator(".edit-name-input").first().fill("Marija");
  await page.locator(".edit-name-input").nth(1).fill("Pilar");
  await page.locator(".edit-name-input").nth(1).blur();
  await expect(page.locator(".edit-name-input").first()).toHaveValue("Marija");
  await expect(page.locator(".edit-name-input").nth(1)).toHaveValue("Pilar");
  await expect(chips).toContainText("Košnjek");
});
