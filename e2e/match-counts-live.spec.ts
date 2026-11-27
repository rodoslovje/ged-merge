import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// The match list's "new people" count follows the live main file: a confirmed
// match adds the incoming father ahead of the save, and the row stops
// offering him — as the Compare Tree button already did.

const MAIN = path.join(tmpdir(), "match-counts-main.ged");
const COMPARE = path.join(tmpdir(), "match-counts-compare.ged");

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
  "0 @P5@ INDI", "1 NAME Jakob /Novak/", "1 SEX M", "1 BIRT", "2 DATE 1820", "1 FAMS @G2@",
  "0 @G1@ FAM", "1 HUSB @P1@", "1 WIFE @P2@",
  "0 @G2@ FAM", "1 HUSB @P5@", "1 CHIL @P1@",
  "0 TRLR", "",
].join("\n"), "utf-8");

test("a confirmed match takes the people it added off the list's count", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(MAIN);
  await page.locator(".edit-person").first().waitFor();
  await page.getByRole("button", { name: "Merge", exact: true }).click();
  await page.locator("input.file-input").last().setInputFiles(COMPARE);

  const row = page.locator(".candidate", { hasText: "Janez" }).first();
  await expect(row.locator(".nd.import")).toHaveText("1");
  await row.locator(".candidate-main").click();
  await page.locator(".decision-bar button").first().click();
  await expect(row.locator(".nd.import")).toHaveText("0");
});
