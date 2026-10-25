import { test, expect, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// Tools → Health check: a source's filing number and periodical in the `_FILN`
// / `_PERI` extensions (written by earlier GED Merge versions) are rewritten in
// the standard's forms — the repository link's call number, the title — in
// every source at once, through the worker's re-check.
const FILE = path.join(tmpdir(), "health-check-source-fields.ged");

writeFileSync(FILE, [
  "0 HEAD", "1 SOUR TEST", "1 GEDC", "2 VERS 5.5.1", "2 FORM LINEAGE-LINKED", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Janez /Kos/", "1 SEX M", "1 RACE Slovenian", "1 BIRT", "2 DATE 1880", "2 SOUR @S1@",
  "0 @S1@ SOUR", "1 TITL Obituary", "1 _PERI Slovenec", "1 _FILN 123", "1 REPO @R1@",
  "0 @S2@ SOUR", "1 TITL Register", "1 _FILN 9",
  "0 @R1@ REPO", "1 NAME Nadškofijski arhiv",
  "0 TRLR", "",
].join("\n"), "utf-8");

async function save(page: Page): Promise<string> {
  await page.locator(".app-head-actions .export-btn").click();
  const ged = page.waitForEvent("download", (d) => d.suggestedFilename().endsWith(".ged"));
  await page.locator(".preview-actions .export-btn").click();
  return readFileSync((await (await ged).path())!, "utf-8");
}

test("old _FILN/_PERI lines become the repository's call number and the title", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor();

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Health check", { exact: true }).first().click();
  await page.getByRole("tab", { name: /GEDCOM .* compliance/ }).click();
  const filn = page.locator(".tools-issue", { hasText: "Custom tag _FILN" });
  await expect(filn).toBeVisible();

  // A program's bare tag is a deviation of its own, with the page that
  // explains it a click away.
  const race = page.locator(".tools-issue", { hasText: "RACE is not a GEDCOM 5.5.1 tag" });
  await expect(race).toBeVisible();
  const about = race.getByRole("link", { name: "RACE" });
  await expect(about).toHaveAttribute("href", "/terms/macfamilytree/RACE");
  const pageText = await (await page.request.get("/terms/macfamilytree/RACE/")).text();
  expect(pageText).toContain("without the underscore that marks an extension");

  await filn.getByRole("button", { name: "Write the standard way" }).click();
  await expect(page.locator(".tools-issue", { hasText: "Custom tag _FILN" })).toHaveCount(0);
  await expect(page.locator(".tools-issue", { hasText: "Custom tag _PERI" })).toHaveCount(0);

  const text = await save(page);
  expect(text).toContain("1 TITL Obituary, Slovenec\n1 REPO @R1@\n2 CALN 123");
  expect(text).toContain("1 TITL Register\n1 REPO\n2 CALN 9");
  expect(text).not.toMatch(/_FILN|_PERI/);

  expect(errors).toEqual([]);
});
