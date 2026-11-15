import { test, expect, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// Tools → Health check → Detached branches: a branch's row downloads the whole
// branch as a GEDCOM file, and removes it from the file after a confirmation
// that counts what goes.
const FILE = path.join(tmpdir(), "health-check-branch.ged");

writeFileSync(FILE, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "2 FORM LINEAGE-LINKED", "1 CHAR UTF-8",
  // The main tree.
  "0 @I1@ INDI", "1 NAME Jože /Novak/", "1 SEX M", "1 FAMS @F1@",
  "0 @I2@ INDI", "1 NAME Ana /Novak/", "1 SEX F", "1 FAMS @F1@",
  "0 @I3@ INDI", "1 NAME Tone /Novak/", "1 SEX M", "1 FAMC @F1@",
  "0 @I4@ INDI", "1 NAME Mica /Novak/", "1 SEX F", "1 FAMC @F1@",
  // A detached branch citing a source of its own.
  "0 @I5@ INDI", "1 NAME Franc /Kos/", "1 SEX M", "1 BIRT", "2 DATE 1900", "2 SOUR @S1@", "1 FAMS @F2@",
  "0 @I6@ INDI", "1 NAME Neža /Kos/", "1 SEX F", "1 BIRT", "2 DATE 1902", "1 FAMS @F2@",
  "0 @I7@ INDI", "1 NAME Pavel /Kos/", "1 SEX M", "1 BIRT", "2 DATE 1930", "1 FAMC @F2@",
  "0 @F1@ FAM", "1 HUSB @I1@", "1 WIFE @I2@", "1 CHIL @I3@", "1 CHIL @I4@",
  "0 @F2@ FAM", "1 HUSB @I5@", "1 WIFE @I6@", "1 CHIL @I7@",
  "0 @S1@ SOUR", "1 TITL Kos letters",
  "0 TRLR", "",
].join("\n"), "utf-8");

const chip = (page: Page, name: string) => page.locator(".tools-chip", { hasText: name });

async function openBranches(page: Page) {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor();
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Health check", { exact: true }).first().click();
  await chip(page, "Detached branches").click();
  return page.locator(".tools-issue", { hasText: "Pavel" });
}

test("a detached branch downloads as a GEDCOM file of its own", async ({ page }) => {
  const row = await openBranches(page);
  const dl = page.waitForEvent("download");
  await row.getByRole("button", { name: "Download this branch as a GEDCOM file" }).click();
  const download = await dl;
  expect(download.suggestedFilename()).toMatch(/^Pavel-Kos-branch\.ged$/);
  const text = readFileSync((await download.path())!, "utf-8");
  for (const name of ["Franc /Kos/", "Neža /Kos/", "Pavel /Kos/", "Kos letters"]) expect(text).toContain(name);
  expect(text).not.toContain("Novak");
});

test("removing a detached branch says what goes and takes it out of the file", async ({ page }) => {
  const row = await openBranches(page);
  await row.getByRole("button", { name: "Remove branch" }).click();
  const dialog = page.locator(".confirm-dialog");
  await expect(dialog).toContainText("people: 3");
  await expect(dialog).toContainText("families: 1");
  await expect(dialog).toContainText("sources only this branch cites: 1");
  await dialog.getByRole("button", { name: "Remove branch" }).click();
  await expect(chip(page, "Detached branches")).toHaveCount(0);

  await page.locator(".app-head-actions .export-btn").click();
  const ged = page.waitForEvent("download", (d) => d.suggestedFilename().endsWith(".ged"));
  await page.locator(".preview-actions .export-btn").click();
  const text = readFileSync((await (await ged).path())!, "utf-8");
  expect(text).not.toContain("/Kos/");
  expect(text).not.toContain("Kos letters");
  expect(text).toContain("Tone /Novak/");
});
