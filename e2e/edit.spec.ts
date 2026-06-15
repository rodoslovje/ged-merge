import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(__dirname, "../test-data/Senen.ged");

test("edit mode: name, sex and event fields are editable and exportable", async ({ page }) => {
  await page.goto("/");

  await page.locator('input[type="file"]').first().setInputFiles(SAMPLE);
  await page.getByRole("button", { name: "Edit" }).click();
  await page.locator(".edit-person").waitFor();

  const exportBtn = page.locator(".edit-toolbar button", { hasText: "Export" });
  await expect(exportBtn).toBeDisabled();

  const given = page.locator(".edit-name-input").first();
  const surname = page.locator(".edit-name-input").nth(1);
  const oldGiven = await given.inputValue();
  await given.fill(`${oldGiven} TEST`);
  await surname.click(); // blur

  await page.locator(".sex-toggle-btn", { hasText: "M" }).click();

  const birth = page.locator(".edit-event").first();
  await birth.locator(".edit-event-date").fill("1 JAN 1900");
  await birth.locator(".edit-event-place").fill("Ljubljana, Slovenija");
  await birth.locator(".edit-event-links").fill("https://example.com/test");
  await birth.locator(".edit-event-links").press("Tab");

  await expect(exportBtn).toBeEnabled();

  const downloadPromise = page.waitForEvent("download");
  await exportBtn.click();
  const download = await downloadPromise;
  const filePath = await download.path();
  const content = readFileSync(filePath!, "utf-8");

  expect(content).toContain(`${oldGiven} TEST`);
  expect(content).toContain("1 JAN 1900");
  expect(content).toContain("Ljubljana, Slovenija");
  expect(content).toContain("https://example.com/test");
});
