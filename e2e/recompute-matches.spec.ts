import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// "Recompute matches" scores the files again without losing the decisions.

const MAIN = path.join(tmpdir(), "recompute-main.ged");
const COMPARE = path.join(tmpdir(), "recompute-compare.ged");

writeFileSync(MAIN, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Janez /Novak/", "1 SEX M", "1 BIRT", "2 DATE 2 FEB 1850",
  "0 @I2@ INDI", "1 NAME Ana /Kos/", "1 SEX F", "1 BIRT", "2 DATE 3 MAR 1855",
  "0 TRLR", "",
].join("\n"), "utf-8");

writeFileSync(COMPARE, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @P1@ INDI", "1 NAME Janez /Novak/", "1 SEX M", "1 BIRT", "2 DATE 2 FEB 1850",
  "0 @P2@ INDI", "1 NAME Ana /Kos/", "1 SEX F", "1 BIRT", "2 DATE 3 MAR 1855",
  "0 TRLR", "",
].join("\n"), "utf-8");

test("recomputing matches keeps confirmed and deferred pairs", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(MAIN);
  await page.locator(".edit-person").first().waitFor();
  await page.getByRole("button", { name: "Merge", exact: true }).click();
  await page.locator("input.file-input").last().setInputFiles(COMPARE);

  const decisions = page.locator(".section-head.compare-head .decision-bar button.decision");
  const janez = page.locator(".candidate", { hasText: "Janez" }).first();
  await janez.locator(".candidate-main").click();
  await decisions.nth(0).click();
  await expect(decisions.nth(0)).toHaveClass(/active/);
  const ana = page.locator(".candidate", { hasText: "Ana" }).first();
  await ana.locator(".candidate-main").click();
  await decisions.nth(2).click();
  await expect(decisions.nth(2)).toHaveClass(/active/);

  const recompute = page.getByRole("button", { name: "Recompute matches" });
  await recompute.click();
  await expect(recompute).toBeEnabled();
  // The pair in view stays in view, deferred; the other one stays confirmed.
  await expect(page.locator(".section-head.compare-head")).toContainText("Ana Kos");
  await expect(decisions.nth(2)).toHaveClass(/active/);
  await janez.locator(".candidate-main").click();
  await expect(decisions.nth(0)).toHaveClass(/active/);
});
