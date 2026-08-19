import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// A file in the shape FamilySearch's per-collection habit leaves behind: a
// repository per collection, each holding one source. The Organize sources
// page offers to gather them under the country the records come from.
const FILE = path.join(tmpdir(), "repo-regroup.ged");

writeFileSync(
  FILE,
  [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Ana /Renko/", "1 SEX F",
    "1 BIRT", "2 PLAC Chicago, Cook, Illinois, United States", "2 SOUR @S1@", "3 PAGE 12",
    "1 DEAT", "2 SOUR @S2@",
    "0 @I2@ INDI", "1 NAME Josip /Renko/", "1 SEX M", "1 BIRT", "2 SOUR @S3@",
    "0 @S1@ SOUR",
    "1 TITL Illinois, Cook County Deaths, 1871-1998",
    "1 PLAC Chicago, Cook, Illinois, United States",
    "1 FILN 108918058",
    "1 REPO @R1@",
    "0 @S2@ SOUR",
    "1 TITL Illinois, Cook County Marriages, 1871-1969",
    "1 REPO @R2@",
    "0 @S3@ SOUR",
    "1 TITL Croatia, Church Books, 1516-1994",
    "1 REPO @R3@",
    "0 @R1@ REPO", "1 NAME FamilySearch.org - Illinois, Cook County Deaths, 1871-1998",
    "1 WWW https://www.familysearch.org/",
    "0 @R2@ REPO", "1 NAME FamilySearch.org - Illinois, Cook County Marriages, 1871-1969",
    "0 @R3@ REPO", "1 NAME FamilySearch.org - Croatia Church Books 1516-1994",
    "0 TRLR",
  ].join("\n"),
);

test("repositories are gathered per place, and the section's own selection works", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Sources", { exact: true }).click();
  // The chip counts this page's whole work, repositories included — a file
  // whose only untidiness is its repositories must still be able to open it.
  const openCleanup = page.locator(".tools-dup-toggle", { hasText: "Organize sources" });
  await expect(openCleanup).toBeEnabled({ timeout: 15000 });
  await openCleanup.click();

  const section = page.locator(".tools-cleanup-section", { hasText: "Repositories by place" });
  await section.waitFor();
  // One row per place: the two Illinois collections, and Croatia.
  const rows = section.locator(".tools-tree-node");
  await expect(rows).toHaveCount(2);
  await expect(section).toContainText("FamilySearch.org - United States, Illinois");
  await expect(section).toContainText("FamilySearch.org - Croatia");

  // Nothing is armed on arrival: the run is ticked together, not out of.
  const checks = section.locator("input.tools-dup-check");
  await expect(checks.first()).not.toBeChecked();

  // The section's own Select all / Select none reach only its rows.
  await section.getByRole("button", { name: "Select all" }).click();
  await expect(checks.first()).toBeChecked();
  await expect(checks.nth(1)).toBeChecked();
  await section.getByRole("button", { name: "Select none" }).click();
  await expect(checks.first()).not.toBeChecked();
  await expect(checks.nth(1)).not.toBeChecked();
  await section.getByRole("button", { name: "Select all" }).click();

  // A row names a record, so it opens that record's own editor — every field
  // it holds, its link included — without leaving the page.
  await section.locator(".tools-tree-label").first().click(); // open the group
  const move = section.locator(".tools-dup-member").first();
  await move.hover();
  await move.locator(".tools-place-edit-btn").click();
  const dialog = page.locator(".add-source-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("input").first()).toHaveValue(/Croatia, Church Books/);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // Applying moves the sources and drops the emptied records: the tree then
  // shows one repository per country instead of one per collection.
  await page.getByRole("button", { name: /Gather under repositories|Apply to the file/ }).first().click();
  await page.locator(".tools-cleanup-status").waitFor();
  await page.locator(".tools-cleanup-section", { hasText: "Repositories by place" }).waitFor({ state: "detached" });
  await page.locator(".tools-page-title", { hasText: "Organize sources" }).locator("..").getByRole("button").first().click();
  const tree = page.locator(".tools-tree").first();
  await expect(tree).toContainText("FamilySearch.org - United States, Illinois");
  await expect(tree).toContainText("FamilySearch.org - Croatia");
  await expect(tree).not.toContainText("Cook County Deaths, 1871-1998 ");
});
