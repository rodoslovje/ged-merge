import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// A chart opened from Merge returns to Merge, on the pair it was opened from.
// Two things got in the way: Edit, following Merge in the background (it is
// pointed at the first candidate when a match result lands), pushed entries of
// its own that claimed to be Edit pages — so Back from the chart opened Edit;
// and a pair picked from the list is not a step, so the entry Back returned to
// could still name a pair chosen before it.

const FILE = path.join(tmpdir(), "merge-chart-back.ged");
writeFileSync(FILE, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Janez /Novak/", "1 SEX M", "1 BIRT", "2 DATE 1850", "1 FAMS @F1@",
  "0 @I2@ INDI", "1 NAME Ana /Kos/", "1 SEX F", "1 BIRT", "2 DATE 1855", "1 FAMS @F1@",
  "0 @I3@ INDI", "1 NAME Peter /Novak/", "1 SEX M", "1 BIRT", "2 DATE 1880", "1 FAMC @F1@",
  "0 @F1@ FAM", "1 HUSB @I1@", "1 WIFE @I2@", "1 CHIL @I3@",
  "0 TRLR", "",
].join("\n"), "utf-8");

async function openMerge(page: Page) {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor();
  await page.getByRole("button", { name: "Merge", exact: true }).click();
  await page.locator("input.file-input").last().setInputFiles(FILE);
}

const pick = (page: Page, name: string) =>
  page.locator(".candidate", { hasText: name }).first().locator(".candidate-main").click();

async function relationshipAndBack(page: Page) {
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  await page.keyboard.press("s");
  const chartBack = page.locator(".tree-toolbar .tree-back-btn");
  await expect(chartBack).toBeVisible();
  await page.keyboard.press("Backspace");
  await expect(chartBack).toBeHidden();
}

test("S then Backspace returns to Merge on the same pair", async ({ page }) => {
  await openMerge(page);
  const selected = page.locator(".candidate.selected");
  await pick(page, "Peter");
  await expect(selected).toContainText("Peter");

  await relationshipAndBack(page);
  await expect(page.locator(".compare-panel").first()).toBeVisible();
  await expect(page.locator(".edit-person")).toBeHidden();
  await expect(selected).toContainText("Peter");
});

test("a pair shown in Matches from the Compare Tree is a Merge page Back returns to", async ({ page }) => {
  await openMerge(page);
  const selected = page.locator(".candidate.selected");
  await pick(page, "Peter");
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  await page.keyboard.press("v");
  await page.locator("svg.tree-svg").getByRole("button", { name: /^Peter/ }).first().click();
  await page.locator(".tree-compare-title-link").click();
  await expect(page.locator(".compare-panel").first()).toBeVisible();

  // E opens the pair's person in Edit; Back returns to the Matches page, which
  // the tree's push had left naming no mode at all.
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  await page.keyboard.press("e");
  await expect(page.locator(".edit-person")).toBeVisible();
  await page.goBack();
  await expect(page.locator(".compare-panel").first()).toBeVisible();
  await expect(page.locator(".edit-person")).toBeHidden();
  await expect(selected).toHaveCount(1);
});

test("Back from a chart restores the pair picked last, not one followed earlier", async ({ page }) => {
  await openMerge(page);
  const selected = page.locator(".candidate.selected");
  await pick(page, "Janez");
  // Following a relative is a step, so its entry names Peter…
  await page.locator(".compare-panel .person-link", { hasText: "Peter" }).first().click();
  await expect(selected).toContainText("Peter");
  // …and picking Ana from the list is not — the chart's Back must still land on her.
  await pick(page, "Ana");
  await expect(selected).toContainText("Ana");

  await relationshipAndBack(page);
  await expect(page.locator(".compare-panel").first()).toBeVisible();
  await expect(selected).toContainText("Ana");
});
