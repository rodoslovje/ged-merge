import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

/**
 * GEDCOM 7 structures the app reads, shows and keeps: SEX X, a family's NO
 * MARR, an EXID, a name's TRAN (found by search), a date PHRASE and an SDATE.
 * After one edit elsewhere in the file, every other line saves exactly as it
 * was loaded.
 */
const FILE = path.join(tmpdir(), "gedcom7-structures.ged");
const BODY = [
  "0 @I1@ INDI",
  "1 NAME Alex /Novak/",
  "2 TRAN Алекс /Новак/",
  "3 LANG ru",
  "1 SEX X",
  "1 EXID Novak-12",
  "2 TYPE https://www.wikitree.com/wiki/",
  "1 BAPM",
  "2 DATE 1850",
  "3 PHRASE Easter Sunday",
  "1 RESI",
  "2 SDATE 1870",
  "1 FAMS @F1@",
  "0 @I2@ INDI",
  "1 NAME Ana /Kos/",
  "1 SEX F",
  "1 FAMS @F1@",
  "0 @F1@ FAM",
  "1 HUSB @I1@",
  "1 WIFE @I2@",
  "1 NO MARR",
  "0 TRLR",
  "",
];
writeFileSync(FILE, ["0 HEAD", "1 GEDC", "2 VERS 7.0", ...BODY].join("\n"), "utf-8");

test("GEDCOM 7: SEX X, NO MARR, EXID, a translated name and an untouched save", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").first().waitFor();
  await expect(page.locator(".edit-name-input").first()).toHaveValue("Alex");

  // SEX X reads as its own value, not as unknown.
  await expect(page.locator(".sex-select").first()).toContainText("Other");
  // The external id and the name's translation show under the name row.
  await expect(page.locator(".edit-exid-chip")).toContainText("Novak-12");
  await expect(page.locator(".edit-person")).toContainText("Алекс Новак");
  // The date's wording reads beside its value.
  await expect(page.locator(".edit-event-date-phrase")).toHaveText("Easter Sunday");
  // The couple's "no marriage" shows on the family.
  await expect(page.locator(".edit-family .edit-no-events")).toContainText("Marriage");

  // Search finds the person by the translated name.
  await page.keyboard.press("/");
  const modal = page.locator(".global-search-modal");
  await modal.locator(".global-search-input").fill("Алекс");
  await expect(modal.locator(".global-search-row").first()).toContainText("Alex");
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);

  // One edit: Alex was never christened.
  await page.locator(".edit-event-add-row .edit-name-chip-add", { hasText: "Did not happen" }).first().click();
  await page.locator('.dd-menu .dd-item[data-value="CHR"]').click();
  await expect(page.locator(".edit-no-events", { hasText: "Christening" })).toHaveCount(1);

  const saveBtn = page.locator(".app-head-actions .export-btn");
  await expect(saveBtn).toBeEnabled();
  await saveBtn.click();
  const ged = page.waitForEvent("download", (d) => d.suggestedFilename().endsWith(".ged"));
  await page.locator(".preview-actions .export-btn").click();
  const text = readFileSync((await (await ged).path())!, "utf-8");

  // Everything after HEAD is the file as loaded, plus the one new line.
  const expected = [...BODY];
  expected.splice(BODY.indexOf("1 FAMS @F1@"), 0, "1 NO CHR");
  expect(text.slice(text.indexOf("0 @I1@ INDI"))).toBe(expected.join("\n"));
});
