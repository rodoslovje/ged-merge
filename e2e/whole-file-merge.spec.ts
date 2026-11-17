import { test, expect, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// Merge → "Whole file": the save brings in everyone in the incoming file. A
// confirmed pair is merged, an unreviewed candidate is added or joined as the
// save asks, and everyone else — with their families and sources — comes too.

const MAIN = path.join(tmpdir(), "whole-file-main.ged");
const COMPARE = path.join(tmpdir(), "whole-file-compare.ged");

writeFileSync(MAIN, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Janez /Novak/", "1 SEX M", "1 BIRT", "2 DATE 1850", "1 FAMS @F1@",
  "0 @I2@ INDI", "1 NAME Ana /Kos/", "1 SEX F", "1 BIRT", "2 DATE 1855", "1 FAMS @F1@",
  "0 @F1@ FAM", "1 HUSB @I1@", "1 WIFE @I2@",
  "0 TRLR", "",
].join("\n"), "utf-8");

writeFileSync(COMPARE, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @P1@ INDI", "1 NAME Janez /Novak/", "1 SEX M", "1 BIRT", "2 DATE 1850", "1 FAMS @G1@",
  "0 @P2@ INDI", "1 NAME Ana /Kos/", "1 SEX F", "1 BIRT", "2 DATE 1855", "1 FAMS @G1@",
  "0 @P3@ INDI", "1 NAME Marko /Novak/", "1 SEX M", "1 BIRT", "2 DATE 1883", "1 FAMC @G1@",
  // A family nobody in the main file belongs to, with its own marriage.
  "0 @P4@ INDI", "1 NAME Franc /Zupan/", "1 SEX M", "1 BIRT", "2 DATE 1700", "1 FAMS @G2@",
  "0 @P5@ INDI", "1 NAME Neza /Zupan/", "1 SEX F", "1 BIRT", "2 DATE 1702", "1 FAMS @G2@",
  "0 @G1@ FAM", "1 HUSB @P1@", "1 WIFE @P2@", "1 CHIL @P3@",
  "0 @G2@ FAM", "1 HUSB @P4@", "1 WIFE @P5@", "1 MARR", "2 DATE 1725", "2 SOUR @S1@",
  "0 @S1@ SOUR", "1 TITL Zupan letters",
  "0 @S2@ SOUR", "1 TITL Parish book nobody cites",
  "0 TRLR", "",
].join("\n"), "utf-8");

async function openMerge(page: Page) {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(MAIN);
  await page.locator(".edit-person").first().waitFor();
  await page.getByRole("button", { name: "Merge", exact: true }).click();
  await page.locator("input.file-input").last().setInputFiles(COMPARE);
  await page.locator(".candidate", { hasText: "Janez" }).first().waitFor();
}

async function save(page: Page, answer?: string): Promise<string> {
  await page.locator(".app-head-actions .export-btn").click();
  if (answer) await page.locator(".confirm-dialog").getByRole("button", { name: answer }).click();
  const ged = page.waitForEvent("download", (d) => d.suggestedFilename().endsWith(".ged"));
  await page.locator(".preview-actions .export-btn").click();
  return readFileSync((await (await ged).path())!, "utf-8");
}

const count = (text: string, line: string) => text.split(line).length - 1;

/** Switch to Whole file; the confirmation counts who comes beyond the list. */
async function chooseWholeFile(page: Page) {
  await page.getByRole("tab", { name: "Whole file" }).click();
  const dialog = page.locator(".confirm-dialog");
  await expect(dialog).toContainText("on the match list: 2");
  await expect(dialog).toContainText("no match, added as new: 3");
  await dialog.getByRole("button", { name: "Bring in the whole file" }).click();
  await expect(page.getByRole("tab", { name: "Whole file" })).toHaveAttribute("aria-selected", "true");
}

test("the whole incoming file comes across, joined where confirmed", async ({ page }) => {
  await openMerge(page);
  await chooseWholeFile(page);
  await expect(page.locator(".merge-scope-progress")).toHaveText("Reviewed: 0 of 2");

  // Confirm Janez; Ana stays unreviewed and is joined at the save's question.
  await page.locator(".candidate", { hasText: "Janez" }).first().locator(".candidate-main").click();
  await page.locator(".decision-bar button").first().click();
  // Marko comes with the whole file whatever is ticked: no "+ add" to press.
  await expect(page.getByRole("button", { name: "+ add" })).toHaveCount(0);
  await expect(page.locator(".gm-added-tag", { hasText: "added" })).toHaveCount(1);
  await expect(page.locator(".merge-scope-progress")).toHaveText("Reviewed: 1 of 2");

  const text = await save(page, "Merge where name, sex and birth year agree");
  expect(count(text, "1 NAME Janez /Novak/")).toBe(1);
  expect(count(text, "1 NAME Ana /Kos/")).toBe(1);
  expect(count(text, "1 NAME Marko /Novak/")).toBe(1);
  expect(count(text, "1 NAME Franc /Zupan/")).toBe(1);
  expect(text).toContain("2 DATE 1725");
  expect(text).toContain("1 TITL Zupan letters");
  expect(text).toContain("1 TITL Parish book nobody cites");
  // Marko is the child of the main couple's own family, not of a second one.
  expect(count(text, " FAM\n")).toBe(2);
});

test("unreviewed candidates can be added as new people instead", async ({ page }) => {
  await openMerge(page);
  await chooseWholeFile(page);
  const text = await save(page, "Add as new people");
  expect(count(text, "1 NAME Janez /Novak/")).toBe(2);
  expect(count(text, "1 NAME Ana /Kos/")).toBe(2);
});
