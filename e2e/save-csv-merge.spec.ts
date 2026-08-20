import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// Save after merging a genealogical-index matches CSV: both files must actually
// download, not just be announced by the toast.
const MAIN = path.join(tmpdir(), "save-csv-main.ged");
const CSV = path.join(tmpdir(), "save-csv-matches.csv");

writeFileSync(MAIN, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Marko /Kocevar/", "1 SEX M",
  "1 BIRT", "2 DATE 14 MAY 1777", "2 PLAC Malo Lesce,Metlika,Slovenia",
  "1 DEAT", "2 DATE 20 DEC 1834",
  "1 FAMS @F1@",
  "0 @I2@ INDI", "1 NAME Ana /Stefanic/", "1 SEX F",
  "1 BIRT", "2 DATE 3 JUN 1789",
  "1 FAMS @F1@",
  "0 @I3@ INDI", "1 NAME Marko /Kocevar/", "1 SEX M",
  "1 BIRT", "2 DATE 2 FEB 1807",
  "1 FAMC @F1@",
  "0 @F1@ FAM", "1 HUSB @I1@", "1 WIFE @I2@", "1 CHIL @I3@",
  "0 TRLR", "",
].join("\n"), "utf-8");

const HEADER =
  '"Name","Surname","Date of Birth","Place of Birth","Date of Death","Place of Death","Burial date","Burial place","Links","Partners","Father","Mother","Genealogist","Confidence"';
const row = (cells: string[]) => cells.map((c) => `"${c.replace(/"/g, '""')}"`).join(",");

writeFileSync(CSV, [
  HEADER,
  row(["Marko", "Kocevar", "14 MAY 1777", "Malo Lesce", "20 DEC 1834", "", "", "", "", "Ana Stefanic | 3 JUN 1789", "", "", "Renko", "99"]),
  row(["Marko", "Kocevar", "14 MAY 1777", "Malo Lesce 8", "20 DEC 1834", "", "", "", "https://example.com/x", "Ana Stefanic | 3 JUN 1789", "", "", "Kocevar", "99"]),
  "",
].join("\n"), "utf-8");

test("save after a matches-CSV merge downloads both files", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(MAIN);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });

  await page.getByRole("button", { name: "Merge", exact: true }).click();
  await page.locator("input.file-input").last().setInputFiles(CSV);
  await page.locator(".candidate").first().waitFor({ timeout: 30000 });
  await page.locator(".candidate-main").first().click();
  await page.locator(".decision-bar button").first().click();

  const saveBtn = page.locator(".app-head-actions .export-btn");
  await expect(saveBtn).toBeEnabled();
  await saveBtn.click();

  // The change report is opt-in, so ask for it — this save covers both files.
  await page.locator(".preview-report-toggle input").check();

  const ged = page.waitForEvent("download", (d) => d.suggestedFilename().endsWith(".ged"));
  const report = page.waitForEvent("download", (d) => d.suggestedFilename().endsWith(".report.txt"));
  await page.locator(".preview-actions .export-btn").click();

  expect(await (await ged).path()).toBeTruthy();
  expect(await (await report).path()).toBeTruthy();
  expect(errors).toEqual([]);
});
