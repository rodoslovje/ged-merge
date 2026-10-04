import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// A relative's name followed in the comparison is a step of its own: ⌫ takes
// it back to the match it was followed from, as the browser's Back does.

const FILE = path.join(tmpdir(), "merge-back-key.ged");
writeFileSync(FILE, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Janez /Novak/", "1 SEX M", "1 BIRT", "2 DATE 1850", "1 FAMS @F1@",
  "0 @I2@ INDI", "1 NAME Ana /Kos/", "1 SEX F", "1 BIRT", "2 DATE 1855", "1 FAMS @F1@",
  "0 @I3@ INDI", "1 NAME Peter /Novak/", "1 SEX M", "1 BIRT", "2 DATE 1880", "1 FAMC @F1@",
  "0 @F1@ FAM", "1 HUSB @I1@", "1 WIFE @I2@", "1 CHIL @I3@",
  "0 TRLR", "",
].join("\n"), "utf-8");

test("Backspace returns to the match a relative was opened from", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor();
  await page.getByRole("button", { name: "Merge", exact: true }).click();
  await page.locator("input.file-input").last().setInputFiles(FILE);

  const selected = page.locator(".candidate.selected");
  await page.locator(".candidate", { hasText: "Janez" }).first().locator(".candidate-main").click();
  await expect(selected).toContainText("Janez");

  await page.locator(".compare-panel .person-link", { hasText: "Peter" }).first().click();
  await expect(selected).toContainText("Peter");

  await page.locator("body").click({ position: { x: 1, y: 1 } });
  await page.keyboard.press("Backspace");
  await expect(selected).toContainText("Janez");
});
