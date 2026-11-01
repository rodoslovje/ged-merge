import { test, expect, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// "Bring ancestors" / "Bring descendants" on a compare-tree node grafts that
// person's incoming branch into the main file on save.

const MAIN = path.join(tmpdir(), "branch-import-main.ged");
const COMPARE = path.join(tmpdir(), "branch-import-compare.ged");

writeFileSync(MAIN, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Janez /Novak/", "1 SEX M", "1 BIRT", "2 DATE 1850", "1 FAMS @F1@",
  "0 @I2@ INDI", "1 NAME Ana /Kos/", "1 SEX F", "1 BIRT", "2 DATE 1855", "1 FAMS @F1@",
  "0 @F1@ FAM", "1 HUSB @I1@", "1 WIFE @I2@",
  "0 TRLR", "",
].join("\n"), "utf-8");

writeFileSync(COMPARE, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @P1@ INDI", "1 NAME Janez /Novak/", "1 SEX M", "1 BIRT", "2 DATE 1850", "1 FAMS @G1@", "1 FAMC @G2@",
  "0 @P2@ INDI", "1 NAME Ana /Kos/", "1 SEX F", "1 BIRT", "2 DATE 1855", "1 FAMS @G1@",
  "0 @P4@ INDI", "1 NAME Marko /Novak/", "1 SEX M", "1 BIRT", "2 DATE 1883", "1 FAMC @G1@", "1 FAMS @G3@",
  "0 @P6@ INDI", "1 NAME Luka /Novak/", "1 SEX M", "1 BIRT", "2 DATE 1910", "1 FAMC @G3@",
  "0 @P5@ INDI", "1 NAME Jakob /Novak/", "1 SEX M", "1 BIRT", "2 DATE 1820", "1 FAMS @G2@", "1 FAMC @G4@",
  "0 @P7@ INDI", "1 NAME Tomaz /Novak/", "1 SEX M", "1 BIRT", "2 DATE 1790", "1 FAMS @G4@",
  "0 @G1@ FAM", "1 HUSB @P1@", "1 WIFE @P2@", "1 CHIL @P4@",
  "0 @G2@ FAM", "1 HUSB @P5@", "1 CHIL @P1@",
  "0 @G3@ FAM", "1 HUSB @P4@", "1 CHIL @P6@",
  "0 @G4@ FAM", "1 HUSB @P7@", "1 CHIL @P5@",
  "0 TRLR", "",
].join("\n"), "utf-8");

async function openTree(page: Page, confirm: boolean) {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(MAIN);
  await page.locator(".edit-person").first().waitFor();
  await page.getByRole("button", { name: "Merge", exact: true }).click();
  await page.locator("input.file-input").last().setInputFiles(COMPARE);
  await page.locator(".candidate", { hasText: "Janez" }).first().locator(".candidate-main").click();
  if (confirm) await page.locator(".decision-bar button").first().click();
  await page.getByRole("button", { name: /Compare Tree/ }).click();
  await page.locator("svg.tree-svg").waitFor();
}

async function bring(page: Page, who: string) {
  await page.locator("svg.tree-svg g.tree-node", { hasText: who }).first().click();
  const btn = page.locator(".tree-import-btn");
  await btn.click();
  await expect(btn).toHaveClass(/active/);
}

async function expectSaved(page: Page, names: string[]) {
  await page.keyboard.press("Escape");
  await page.locator(".app-head-actions .export-btn").click();
  const ged = page.waitForEvent("download", (d) => d.suggestedFilename().endsWith(".ged"));
  await page.locator(".preview-actions .export-btn").click();
  const text = readFileSync((await (await ged).path())!, "utf-8");
  for (const name of names) {
    expect(text.split(`1 NAME ${name} /Novak/`).length - 1, name).toBe(1);
  }
}

test("deciding a match on a tree node keeps its panel open", async ({ page }) => {
  await openTree(page, false);
  await page.locator("svg.tree-svg g.tree-node", { hasText: "Janez" }).first().click();
  const confirm = page.locator(".tree-compare-decisions button.decision").first();
  await confirm.click();
  await expect(confirm).toHaveClass(/active/);
  await expect(page.locator(".tree-compare-decisions")).toBeVisible();
});

test("a marked branch shows its people as added in the match panel", async ({ page }) => {
  await openTree(page, true);
  await page.getByRole("tab", { name: /Descendants/ }).click();
  await bring(page, "Janez");
  await page.getByRole("button", { name: "Back to Matches" }).click();
  const marko = page.locator(".compare-panel td.f-rel", { hasText: "Marko" });
  await expect(marko.getByTitle(/whole branch you marked/)).toBeVisible();
  await expect(marko.locator("button.choice.take")).toHaveCount(0);
});

for (const confirm of [false, true]) {
  const label = confirm ? "a confirmed match" : "an undecided match";

  test(`bringing ancestors from ${label} adds them on save`, async ({ page }) => {
    await openTree(page, confirm);
    await page.getByRole("tab", { name: /Ancestors/ }).click();
    await bring(page, "Janez");
    await expectSaved(page, ["Jakob", "Tomaz"]);
  });

  test(`bringing descendants from ${label} adds them on save`, async ({ page }) => {
    await openTree(page, confirm);
    await page.getByRole("tab", { name: /Descendants/ }).click();
    await bring(page, "Janez");
    await expectSaved(page, ["Marko", "Luka"]);
  });

  test(`bringing ancestors of an incoming-only parent from ${label} adds them on save`, async ({ page }) => {
    await openTree(page, confirm);
    await page.getByRole("tab", { name: /Ancestors/ }).click();
    await bring(page, "Jakob");
    await expectSaved(page, ["Jakob", "Tomaz"]);
  });

  test(`bringing descendants of an incoming-only child from ${label} adds them on save`, async ({ page }) => {
    await openTree(page, confirm);
    await page.getByRole("tab", { name: /Descendants/ }).click();
    await bring(page, "Marko");
    await expectSaved(page, ["Marko", "Luka"]);
  });
}
