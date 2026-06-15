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
  await birth.locator(".edit-event-addr").fill("Glavni trg 1");
  await birth.locator(".edit-link-add").click();
  await birth.locator(".edit-link-input").fill("https://example.com/test");
  await birth.locator(".edit-link-input").press("Tab");

  await expect(exportBtn).toBeEnabled();

  const downloadPromise = page.waitForEvent("download");
  await exportBtn.click();
  const download = await downloadPromise;
  const filePath = await download.path();
  const content = readFileSync(filePath!, "utf-8");

  expect(content).toContain(`${oldGiven} TEST`);
  expect(content).toContain("1 JAN 1900");
  expect(content).toContain("Ljubljana, Slovenija");
  expect(content).toContain("Glavni trg 1");
  expect(content).toContain("https://example.com/test");
});

test("edit mode: family marriage fields are editable and exportable", async ({ page }) => {
  await page.goto("/");

  await page.locator('input[type="file"]').first().setInputFiles(SAMPLE);
  await page.getByRole("button", { name: "Edit" }).click();
  await page.locator(".edit-person").waitFor();

  const marriage = page.locator(".edit-family .edit-event").first();
  await marriage.locator(".edit-event-date").fill("3 MAR 1999");
  await marriage.locator(".edit-event-place").fill("Maribor, Slovenija");
  await marriage.locator(".edit-event-addr").fill("Trg 5");
  await marriage.locator(".edit-link-add").click();
  await marriage.locator(".edit-link-input").fill("https://example.com/marr");
  await marriage.locator(".edit-link-input").press("Tab");

  const exportBtn = page.locator(".edit-toolbar button", { hasText: "Export" });
  await expect(exportBtn).toBeEnabled();

  const downloadPromise = page.waitForEvent("download");
  await exportBtn.click();
  const download = await downloadPromise;
  const filePath = await download.path();
  const content = readFileSync(filePath!, "utf-8");

  expect(content).toContain("3 MAR 1999");
  expect(content).toContain("Maribor, Slovenija");
  expect(content).toContain("Trg 5");
  expect(content).toContain("https://example.com/marr");
});
