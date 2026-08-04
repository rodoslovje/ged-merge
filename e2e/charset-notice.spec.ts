import { test, expect } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const W1250 = path.resolve(__dirname, "../src/__fixtures__/corpus/brotherskeeper-5.5.1-w1250.ged");
const UTF8 = path.resolve(__dirname, "../src/__fixtures__/corpus/reunion-5.5.1-utf8.ged");

// A file that didn't arrive as UTF-8 leaves as UTF-8 with a rewritten CHAR
// line — a change to a header other software trusts, so the app has to say so
// rather than let the user discover it in their genealogy program.
test("a non-UTF-8 file is told it will be saved as UTF-8", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(W1250);
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Health check", { exact: true }).first().click();

  const note = page.locator(".tools-note");
  await expect(note).toHaveCount(1);
  await expect(note).toContainText("WINDOWS-1250");
  await expect(note).toContainText("UTF-8");

  // It sits with the findings, so filtering to the decoder's own Encoding line
  // — which says what was read, not what will be written — keeps it in view.
  await page.getByRole("button", { name: /^Encoding/ }).click();
  await expect(note).toBeVisible();
  await expect(page.locator(".tools-issues")).toBeVisible();
});

test("a UTF-8 file gets no encoding notice", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(UTF8);
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Health check", { exact: true }).first().click();
  await page.locator(".tools-fix-list").first().waitFor();
  await expect(page.locator(".tools-note")).toHaveCount(0);
});
