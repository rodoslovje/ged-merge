import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

const MAIN = path.join(tmpdir(), "merge-names-main.ged");
const COMPARE = path.join(tmpdir(), "merge-names-compare.ged");

writeFileSync(MAIN, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Ana /Kukic/", "1 SEX F",
  "1 BIRT", "2 DATE 9 AUG 1982", "2 PLAC Kranj",
  "0 TRLR", "",
].join("\n"), "utf-8");

// The same person, with a married name the main file lacks.
writeFileSync(COMPARE, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Ana /Kukic/", "1 NAME Ana /Novak/", "2 TYPE married", "1 SEX F",
  "1 BIRT", "2 DATE 9 AUG 1982", "2 PLAC Kranj",
  "0 TRLR", "",
].join("\n"), "utf-8");

/** Load both files, confirm the one candidate, and open the person in Edit. */
async function confirmAndOpenInEdit(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(MAIN);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Merge", exact: true }).click();
  await page.locator("input.file-input").last().setInputFiles(COMPARE);
  await page.locator(".candidate").first().waitFor({ timeout: 30000 });

  await page.locator(".candidate").first().click();
  const bar = page.locator(".compare-name-decisions");
  await bar.getByRole("button", { name: "Confirm" }).click();
  await expect(bar.locator(".decision.confirmed.active")).toBeVisible();

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator(".edit-name-input").first()).toHaveValue("Ana");
}

test("a confirmed match's additional name shows in Edit and a click makes it editable", async ({ page }) => {
  await confirmAndOpenInEdit(page);

  const mergeChip = page.locator(".edit-name-chip--merge");
  await expect(mergeChip).toHaveCount(1);
  await expect(mergeChip).toContainText("Ana Novak");

  // Taking the name over opens it for editing; once edited it is the record's own.
  await mergeChip.click();
  const given = page.locator(".edit-name-variant-input").first();
  await expect(given).toHaveValue("Ana");
  await given.fill("Anna");
  await page.locator(".edit-name-input").first().click();
  await expect(page.locator(".edit-name-chip--merge")).toHaveCount(0);
  await expect(page.locator(".edit-other-names .edit-name-chip", { hasText: "Anna Novak" })).toBeVisible();
});

test("× on an incoming additional name leaves it out of the record", async ({ page }) => {
  await confirmAndOpenInEdit(page);

  const wrap = page.locator(".edit-name-chip-wrap", { has: page.locator(".edit-name-chip--merge") });
  await wrap.hover();
  await wrap.locator(".edit-link-remove").click();

  await expect(page.locator(".edit-name-chip--merge")).toHaveCount(0);
  await expect(page.locator(".edit-other-names .edit-name-chip", { hasText: "Novak" })).toHaveCount(0);
});
