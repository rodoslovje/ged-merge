import { test, expect } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(__dirname, "../src/__fixtures__/corpus/reunion-5.5.1-utf8.ged");

// A dialog works on the person it was opened over. The browser's Back button
// used to change that person underneath it, and a source or photo confirmed in
// the dialog was then written to whoever had come on screen.
test("Back with a dialog open closes the dialog and keeps the person on screen", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(SAMPLE);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  const shownName = page.locator(".edit-person .edit-name-input").first();
  const first = (await shownName.inputValue()).trim();
  await page.locator(".person-card").filter({ hasNot: page.locator(".person-card-add") }).first().click();
  await expect(shownName).not.toHaveValue(first);
  const second = (await shownName.inputValue()).trim();

  await page.locator("body").click({ position: { x: 2, y: 2 } }); // out of the name field
  await page.keyboard.press("?");
  const dialog = page.locator(".modal-overlay");
  await expect(dialog).toBeVisible();

  await page.goBack();
  await expect(dialog).toHaveCount(0);
  await expect(shownName).toHaveValue(second);

  // With the dialog gone, Back is the step it always was.
  await page.goBack();
  await expect(shownName).toHaveValue(first);
});
