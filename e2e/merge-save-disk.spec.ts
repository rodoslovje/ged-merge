import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

/**
 * The product's headline flow, verified where it counts: on disk. A compare
 * file adds a birth place and a spouse to a person the main already has; the
 * pair is confirmed with the review's defaults and the file is saved. The
 * downloaded .ged must carry the place, the new spouse and their family, and
 * every pointer in it must resolve — and the file must load back as a main.
 * Until now the one merge-save spec only checked that a download happened.
 */
const MAIN = path.join(tmpdir(), "msd-main.ged");
const COMPARE = path.join(tmpdir(), "msd-compare.ged");

writeFileSync(MAIN, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Janez /Novak/", "1 SEX M",
  "1 BIRT", "2 DATE 12 MAR 1850",
  "0 TRLR", "",
].join("\n"), "utf-8");

writeFileSync(COMPARE, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @P1@ INDI", "1 NAME Janez /Novak/", "1 SEX M",
  "1 BIRT", "2 DATE 12 MAR 1850", "2 PLAC Kranj,Slovenia",
  "1 FAMS @G1@",
  "0 @P2@ INDI", "1 NAME Ana /Kos/", "1 SEX F",
  "1 BIRT", "2 DATE 3 JUN 1855",
  "1 FAMS @G1@",
  "0 @G1@ FAM", "1 HUSB @P1@", "1 WIFE @P2@",
  "1 MARR", "2 DATE 20 NOV 1875",
  "0 TRLR", "",
].join("\n"), "utf-8");

/** Every pointer value under a record's structural lines. */
function pointers(ged: string): string[] {
  return [...ged.matchAll(/^\d+ (?:HUSB|WIFE|CHIL|FAMS|FAMC) (@[^@]+@)\s*$/gm)].map((m) => m[1]);
}

test("a GEDCOM-on-GEDCOM merge writes the incoming place, spouse and family to disk, and the file loads back", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(MAIN);
  await page.locator(".edit-person").first().waitFor();

  await page.getByRole("button", { name: "Merge", exact: true }).click();
  await page.locator("input.file-input").last().setInputFiles(COMPARE);
  await page.locator(".candidate").first().waitFor();
  await page.locator(".candidate-main").first().click();
  // Confirm with the review's defaults: an incoming-only place and partner
  // are taken.
  await page.locator(".decision-bar button").first().click();

  const saveBtn = page.locator(".app-head-actions .export-btn");
  await expect(saveBtn).toBeEnabled();
  await saveBtn.click();
  await page.locator(".preview-report-toggle input").check();

  const ged = page.waitForEvent("download", (d) => d.suggestedFilename().endsWith(".ged"));
  const report = page.waitForEvent("download", (d) => d.suggestedFilename().endsWith(".report.txt"));
  await page.locator(".preview-actions .export-btn").click();
  const gedPath = (await (await ged).path())!;
  const text = readFileSync(gedPath, "utf-8");
  const reportText = readFileSync((await (await report).path())!, "utf-8");

  // What the merge promised, as GEDCOM lines.
  expect(text).toContain("1 CHAR UTF-8");
  expect(text).toMatch(/0 @I1@ INDI\n1 NAME Janez \/Novak\/\n/);
  expect(text).toContain("2 PLAC Kranj,Slovenia");
  expect(text).toContain("1 NAME Ana /Kos/");
  expect(text).toMatch(/0 @F\d+@ FAM\n1 HUSB @I1@\n1 WIFE @I\d+@\n1 MARR\n2 DATE 20 NOV 1875/);
  expect(text.endsWith("0 TRLR\n")).toBe(true);

  // Every family pointer resolves to a record the file holds.
  const xrefs = new Set([...text.matchAll(/^0 (@[^@]+@) /gm)].map((m) => m[1]));
  for (const ptr of pointers(text)) expect(xrefs.has(ptr), `dangling pointer ${ptr}`).toBe(true);

  // The report names the pair that was merged and the family the file gained.
  expect(reportText).toContain("Janez Novak");
  expect(reportText).toContain("Ana Kos");

  // The saved file is a main file in its own right: load it fresh.
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(gedPath);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").first().waitFor();
  await expect(page.locator(".edit-name-input").first()).toHaveValue("Janez");
  await expect(page.locator(".edit-name-input").nth(1)).toHaveValue("Novak");
  // The imported wife is a person of the file now, on his family card.
  await expect(page.locator(".edit-family").first()).toContainText("Ana");

  expect(errors).toEqual([]);
});
