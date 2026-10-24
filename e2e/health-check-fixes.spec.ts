import { test, expect, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// Tools → Health check end to end: a file with four known defects is listed,
// the one-button repairs remove theirs from the list *and* from the saved
// file, and Undo puts a repaired defect back.
const FILE = path.join(tmpdir(), "health-check-fixes.ged");

writeFileSync(FILE, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  // Broken FAMC (no such family) and a dangling source citation.
  "0 @I1@ INDI", "1 NAME Janez /Kos/", "1 SEX M",
  "1 BIRT", "2 DATE 1880", "2 SOUR @S9@", "3 PAGE fol. 12",
  "1 FAMC @F9@",
  // The same FAMS pointer twice.
  "0 @I2@ INDI", "1 NAME Anton /Novak/", "1 SEX M",
  "1 BIRT", "2 DATE 1850",
  "1 FAMS @F1@", "1 FAMS @F1@",
  // A range that ends before it starts.
  "0 @I3@ INDI", "1 NAME Marija /Zupan/", "1 SEX F",
  "1 BIRT", "2 DATE 1855",
  "1 RESI", "2 DATE FROM 1890 TO 1880",
  "1 FAMS @F1@",
  "0 @F1@ FAM", "1 HUSB @I2@", "1 WIFE @I3@",
  "0 TRLR", "",
].join("\n"), "utf-8");

const chip = (page: Page, name: string) => page.locator(".tools-chip", { hasText: name });

/** Pick every fixable row under a chip and run them as one batch. */
async function applyFix(page: Page, chipName: string) {
  await chip(page, chipName).click();
  await page.locator(".tools-pick-all input").check();
  await page.getByRole("button", { name: /^Fix selected/ }).click();
  await page.getByRole("button", { name: "Apply fix" }).click();
}

async function save(page: Page): Promise<string> {
  await page.locator(".app-head-actions .export-btn").click();
  const ged = page.waitForEvent("download", (d) => d.suggestedFilename().endsWith(".ged"));
  await page.locator(".preview-actions .export-btn").click();
  return readFileSync((await (await ged).path())!, "utf-8");
}

/** The lines of one level-0 record, from its header to the next record. */
function record(text: string, xref: string): string[] {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => l.startsWith(`0 ${xref} `));
  if (at < 0) return [];
  const end = lines.findIndex((l, i) => i > at && l.startsWith("0 "));
  return lines.slice(at, end < 0 ? undefined : end);
}

test("fixes picked together run as one step, and one Undo brings them all back", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor();
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Health check", { exact: true }).first().click();
  await expect(chip(page, "Broken links")).toBeVisible();

  await page.locator(".tools-issue", { hasText: "@F9@" }).locator(".tools-pick").check();
  await chip(page, "Duplicate pointers").click();
  await page.locator(".tools-issue").first().locator(".tools-pick").check();
  await expect(page.locator(".tools-pick-count")).toHaveText("Selected: 2");
  await page.getByRole("button", { name: "Fix selected (2)" }).click();
  await page.getByRole("button", { name: "Apply fix" }).click();
  await expect(page.locator(".tools-clean--ok")).toContainText("Fixes made: 2.");
  await expect(chip(page, "Broken links")).toHaveCount(0);
  await expect(chip(page, "Duplicate pointers")).toHaveCount(0);

  await page.getByRole("button", { name: /^Undo/ }).first().click();
  await page.locator(".tools-fix-item button.tools-run", { hasText: "Run again" }).click();
  await expect(chip(page, "Broken links")).toBeVisible();
  await expect(chip(page, "Duplicate pointers")).toBeVisible();
});

test("health-check fixes repair the file and undo brings a defect back", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor();

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Health check", { exact: true }).first().click();
  await expect(page.locator(".tools-issues").first()).toBeVisible();

  // All four defects are found.
  await expect(chip(page, "Broken links")).toBeVisible();
  await expect(chip(page, "Duplicate pointers")).toBeVisible();
  await expect(chip(page, "Dangling references")).toBeVisible();
  await expect(chip(page, "Reversed date ranges")).toBeVisible();
  await chip(page, "Reversed date ranges").click();
  await expect(page.locator(".tools-issue", { hasText: "Range ends before it starts" })).toContainText("FROM 1890 TO 1880");

  await applyFix(page, "Broken links");
  await expect(page.locator(".tools-clean--ok")).toContainText("Removed broken links from 1 record");
  await expect(chip(page, "Broken links")).toHaveCount(0);

  await applyFix(page, "Dangling references");
  await expect(page.locator(".tools-clean--ok")).toContainText("Removed dangling references from 1 record");
  await expect(chip(page, "Dangling references")).toHaveCount(0);

  await applyFix(page, "Duplicate pointers");
  await expect(chip(page, "Duplicate pointers")).toHaveCount(0);

  // The reversed range has no automatic repair and stays reported.
  await expect(chip(page, "Reversed date ranges")).toBeVisible();

  // Undo the last repair (a save clears the history, so before saving): the
  // duplicate pointer is reported again, the other two repairs hold.
  await page.getByRole("button", { name: /^Undo/ }).first().click();
  await page.locator(".tools-fix-item button.tools-run", { hasText: "Run again" }).click();
  await expect(chip(page, "Duplicate pointers")).toBeVisible();
  await expect(chip(page, "Broken links")).toHaveCount(0);
  await expect(chip(page, "Dangling references")).toHaveCount(0);

  const undone = await save(page);
  const janez = record(undone, "@I1@");
  expect(janez).toContain("1 NAME Janez /Kos/");
  expect(janez).toContain("2 DATE 1880");
  expect(janez.join("\n")).not.toContain("@F9@");
  expect(janez.join("\n")).not.toContain("@S9@");
  expect(janez.join("\n")).not.toContain("PAGE fol. 12");
  expect(record(undone, "@I2@").filter((l) => l === "1 FAMS @F1@")).toHaveLength(2);
  expect(record(undone, "@I3@")).toContain("2 DATE FROM 1890 TO 1880");
  expect(record(undone, "@F1@")).toEqual(["0 @F1@ FAM", "1 HUSB @I2@", "1 WIFE @I3@"]);

  // Repair it again and the next save carries one pointer.
  await applyFix(page, "Duplicate pointers");
  await expect(chip(page, "Duplicate pointers")).toHaveCount(0);
  const fixed = await save(page);
  expect(record(fixed, "@I2@").filter((l) => l === "1 FAMS @F1@")).toHaveLength(1);
  expect(record(fixed, "@I3@")).toContain("1 FAMS @F1@");

  expect(errors).toEqual([]);
});
