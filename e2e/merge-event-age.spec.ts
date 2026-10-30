import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

const MAIN = path.join(tmpdir(), "merge-event-age-main.ged");
const COMPARE = path.join(tmpdir(), "merge-event-age-compare.ged");

writeFileSync(MAIN, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Janez /Kalan/", "1 SEX M",
  "1 BIRT", "2 DATE 3 MAR 1858", "2 PLAC Kranj",
  "1 FAMS @F1@",
  "0 @I2@ INDI", "1 NAME Doroteja /Lebar/", "1 SEX F",
  "1 BIRT", "2 DATE 5 MAY 1862",
  "1 FAMS @F1@",
  "0 @F1@ FAM", "1 HUSB @I1@", "1 WIFE @I2@",
  "0 TRLR", "",
].join("\n"), "utf-8");

// The same couple, with a residence and a marriage the main file lacks.
writeFileSync(COMPARE, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Janez /Kalan/", "1 SEX M",
  "1 BIRT", "2 DATE 3 MAR 1858", "2 PLAC Kranj",
  "1 RESI", "2 DATE 12 JUL 1886", "2 PLAC Stražišče",
  "1 FAMS @F1@",
  "0 @I2@ INDI", "1 NAME Doroteja /Lebar/", "1 SEX F",
  "1 BIRT", "2 DATE 5 MAY 1862",
  "1 FAMS @F1@",
  "0 @F1@ FAM", "1 HUSB @I1@", "1 WIFE @I2@",
  "1 MARR", "2 DATE 12 JUL 1886", "2 PLAC Kranj",
  "0 TRLR", "",
].join("\n"), "utf-8");

test("a merged-in date shows the ages before it is taken over", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("gedmerge.settings", JSON.stringify({ showAge: true }));
  });
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(MAIN);
  await page.locator(".edit-person").first().waitFor();
  await page.getByRole("button", { name: "Merge", exact: true }).click();
  await page.locator("input.file-input").last().setInputFiles(COMPARE);

  const janez = page.locator(".candidate", { hasText: "Janez" }).first();
  await janez.click();
  const bar = page.locator(".compare-name-decisions");
  await bar.getByRole("button", { name: "Confirm" }).click();
  await expect(bar.locator(".decision.confirmed.active")).toBeVisible();

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator(".edit-name-input").first()).toHaveValue("Janez");

  // The incoming residence: Janez's own age at it.
  await expect(page.locator(".edit-view .edit-event-age", { hasText: /^28$/ })).toBeVisible();
  // The incoming marriage: each spouse's age.
  const couple = page.locator(".edit-view .edit-event-age", { hasText: "♂28" });
  await expect(couple).toBeVisible();
  await expect(couple).toContainText("♀24");
});
