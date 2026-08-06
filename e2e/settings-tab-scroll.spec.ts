import { test, expect } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(__dirname, "../src/__fixtures__/corpus/reunion-5.5.1-utf8.ged");

// All tabs share one scroll box, so a tab opened after a long scroll on another
// used to land somewhere in its middle, past its own first heading.
test("switching a settings tab returns to the top", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(SAMPLE);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();
  await page.locator('button[title*="etting"]').first().click();

  const body = page.locator(".modal-body");
  await body.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  expect(await body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

  await page.getByRole("tab", { name: "Map" }).click();
  expect(await body.evaluate((el) => el.scrollTop)).toBe(0);
});
