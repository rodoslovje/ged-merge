import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// A child only the incoming file knows is added the moment it is ticked on a
// confirmed match, so it can be edited before the save. The same child listed
// under the other parent's match then reads as already added, and the save
// writes it once, with the edit.

const MAIN = path.join(tmpdir(), "live-adds-main.ged");
const COMPARE = path.join(tmpdir(), "live-adds-compare.ged");

writeFileSync(MAIN, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Janez /Novak/", "1 SEX M", "1 BIRT", "2 DATE 1850", "1 FAMS @F1@",
  "0 @I2@ INDI", "1 NAME Ana /Kos/", "1 SEX F", "1 BIRT", "2 DATE 1855", "1 FAMS @F1@",
  "0 @I3@ INDI", "1 NAME Peter /Novak/", "1 SEX M", "1 BIRT", "2 DATE 1880", "1 FAMC @F1@",
  "0 @F1@ FAM", "1 HUSB @I1@", "1 WIFE @I2@", "1 CHIL @I3@",
  "0 TRLR", "",
].join("\n"), "utf-8");

writeFileSync(COMPARE, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @P1@ INDI", "1 NAME Janez /Novak/", "1 SEX M", "1 BIRT", "2 DATE 1850", "1 FAMS @G1@",
  "0 @P2@ INDI", "1 NAME Ana /Kos/", "1 SEX F", "1 BIRT", "2 DATE 1855", "1 FAMS @G1@",
  "0 @P3@ INDI", "1 NAME Peter /Novak/", "1 SEX M", "1 BIRT", "2 DATE 1880", "1 FAMC @G1@",
  "0 @P4@ INDI", "1 NAME Marko /Novak/", "1 SEX M", "1 BIRT", "2 DATE 1883", "1 FAMC @G1@",
  "0 @G1@ FAM", "1 HUSB @P1@", "1 WIFE @P2@", "1 CHIL @P3@", "1 CHIL @P4@",
  "0 TRLR", "",
].join("\n"), "utf-8");

test("a ticked child is added at once, editable, and shown as added under the other parent", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(MAIN);
  await page.locator(".edit-person").first().waitFor();

  await page.getByRole("button", { name: "Merge", exact: true }).click();
  await page.locator("input.file-input").last().setInputFiles(COMPARE);
  await page.locator(".candidate", { hasText: "Janez" }).first().locator(".candidate-main").click();
  await page.locator(".decision-bar button").first().click();
  await page.locator(".compare-panel button.choice.take", { hasText: "add" }).click();
  // Ticked on a confirmed match: Marko is in the file now, and the tick stays.
  await expect(page.locator(".compare-panel button.choice.take.active")).toBeVisible();

  // Edit him before saving.
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-children .person-card-wrap", { hasText: "Marko" }).locator("button.person-card").click();
  const name = page.locator(".edit-name-input").first();
  await expect(name).toHaveValue(/Marko/);
  await name.fill("Marko Anton Novak");
  await name.press("Tab");

  // The mother's match lists the same child: matched, and already added.
  await page.getByRole("button", { name: "Merge", exact: true }).click();
  await page.locator(".candidate", { hasText: "Ana" }).first().locator(".candidate-main").click();
  await page.locator(".decision-bar button").first().click();
  await expect(page.locator(".compare-panel .gm-added-tag")).toBeVisible();
  await expect(page.locator(".compare-panel")).toContainText("Marko Anton");
  await expect(page.locator(".compare-panel button.choice.take")).toHaveCount(0);

  // The save writes him once, with the edit.
  await page.locator(".app-head-actions .export-btn").click();
  await expect(page.locator(".preview-card-head").filter({ hasText: "Marko Anton" })).toHaveCount(1);
  await expect(page.locator(".preview-card-head").filter({ hasText: /Marko Novak/ })).toHaveCount(0);
});

const WITH_FATHER = path.join(tmpdir(), "live-adds-father.ged");
writeFileSync(WITH_FATHER, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @P1@ INDI", "1 NAME Janez /Novak/", "1 SEX M", "1 BIRT", "2 DATE 1850", "1 FAMC @G2@",
  "0 @P5@ INDI", "1 NAME Jakob /Novak/", "1 SEX M", "1 BIRT", "2 DATE 1820", "1 FAMS @G2@",
  "0 @G2@ FAM", "1 HUSB @P5@", "1 CHIL @P1@",
  "0 TRLR", "",
].join("\n"), "utf-8");

test("confirming a match adds the incoming father, who opens in Edit", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(MAIN);
  await page.locator(".edit-person").first().waitFor();
  await page.getByRole("button", { name: "Merge", exact: true }).click();
  await page.locator("input.file-input").last().setInputFiles(WITH_FATHER);
  await page.locator(".candidate", { hasText: "Janez" }).first().locator(".candidate-main").click();
  await page.locator(".decision-bar button").first().click();
  await expect(page.locator('.compare-panel tr[data-row-key="father"] .gm-added-tag')).toBeVisible();

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-parents .person-card-wrap", { hasText: "Jakob" }).locator("button.person-card").click();
  await expect(page.locator(".edit-name-input").first()).toHaveValue(/Jakob/);
});

test("undo and an untick each take the added child back out of the file", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(MAIN);
  await page.locator(".edit-person").first().waitFor();
  await page.getByRole("button", { name: "Merge", exact: true }).click();
  await page.locator("input.file-input").last().setInputFiles(COMPARE);
  await page.locator(".candidate", { hasText: "Janez" }).first().locator(".candidate-main").click();
  await page.locator(".decision-bar button").first().click();

  const take = page.locator(".compare-panel button.choice.take");
  const children = page.locator(".edit-children");
  const toEdit = () => page.getByRole("button", { name: "Edit", exact: true }).click();
  const toMerge = () => page.getByRole("button", { name: "Merge", exact: true }).click();

  await take.click();
  await toEdit();
  await expect(children).toContainText("Marko");

  // Undo the tick: the decision and the record go back together.
  await page.locator("body").click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(take).not.toHaveClass(/active/);
  await toEdit();
  await expect(children).not.toContainText("Marko");

  // Tick again, then untick: gone again.
  await toMerge();
  await take.click();
  await expect(take).toHaveClass(/active/);
  await take.click();
  await expect(take).not.toHaveClass(/active/);
  await toEdit();
  await expect(children).toContainText("Peter");
  await expect(children).not.toContainText("Marko");
});
