import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

const MAIN = path.join(tmpdir(), `addr-in-place-main-${process.pid}.ged`);
const COMPARE = path.join(tmpdir(), `addr-in-place-compare-${process.pid}.ged`);
writeFileSync(MAIN, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Ana /Kukic/", "1 SEX F", "1 BIRT", "2 DATE 9 AUG 1882",
  "0 TRLR", "",
].join("\n"), "utf-8");
writeFileSync(COMPARE, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Ana /Kukic/", "1 SEX F", "1 BIRT", "2 DATE 9 AUG 1882", "2 PLAC Kranj, Glavni trg 5",
  "0 TRLR", "",
].join("\n"), "utf-8");

// The incoming file writes the address inside the place. The review shows it
// on an address row of its own, but there is no ADDR line to copy: offered as
// "incoming", the row promised a write the merge could not make.
test("an address read out of the incoming place is shown without a choice", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(MAIN);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Merge", exact: true }).click();
  await page.locator("input.file-input").last().setInputFiles(COMPARE);
  await page.locator(".candidate").first().waitFor({ timeout: 30000 });
  await page.locator(".candidate-main").first().click();

  const addressRow = page.locator("tr", { hasText: "Glavni trg 5" }).filter({ hasText: "in the place" });
  await expect(addressRow).toHaveCount(1);
  await expect(addressRow.getByRole("button")).toHaveCount(0);
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });
});
