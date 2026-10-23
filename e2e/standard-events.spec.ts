import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// The standard events the app lifts as first-class ones are offered by the
// "+ Add" menus like any other: an ordination on the person, an annulment on
// the couple — both written to the saved file where the standard puts them.
test("an ordination and a family's annulment are added in Edit and saved", async ({ page }) => {
  const ged = [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Anton /Renka/", "1 SEX M", "1 BIRT", "2 DATE 1880", "1 FAMS @F1@",
    "0 @I2@ INDI", "1 NAME Marija /Kos/", "1 SEX F", "1 FAMS @F1@",
    "0 @F1@ FAM", "1 HUSB @I1@", "1 WIFE @I2@", "1 MARR", "2 DATE 1905",
    "0 TRLR", "",
  ].join("\n");
  const filePath = path.join(tmpdir(), `standard-events-${Date.now()}.ged`);
  writeFileSync(filePath, ged, "utf-8");

  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(filePath);
  await expect(page.locator(".edit-person .edit-name-input").first()).toHaveValue("Anton");

  // The person's ordination, from the Career group.
  await page.getByRole("button", { name: "+ Add Event" }).click();
  await page.getByRole("option", { name: "Ordination", exact: true }).click();
  const ordn = page.locator(".edit-event").filter({ hasText: "Ordination" }).first();
  const ordnDate = ordn.locator("input.edit-event-date").first();
  await ordnDate.fill("1904");
  await ordnDate.blur();
  await expect(ordnDate).toHaveValue("1904");

  // The couple's annulment, from the family's own menu.
  await page.getByRole("button", { name: "+ Add Family Event" }).click();
  await page.getByRole("option", { name: /Annulment/ }).click();
  const anul = page.locator(".edit-family .edit-event").filter({ hasText: "Annulment" }).first();
  const anulDate = anul.locator("input.edit-event-date").first();
  await anulDate.fill("1910");
  await anulDate.blur();
  await expect(anulDate).toHaveValue("1910");

  const saveBtn = page.locator(".app-head-actions .export-btn");
  await expect(saveBtn).toBeEnabled();
  await saveBtn.click();
  const downloadPromise = page.waitForEvent("download", (d) => d.suggestedFilename().endsWith(".ged"));
  await page.locator(".preview-actions .export-btn").click();
  const saved = readFileSync((await (await downloadPromise).path())!, "utf-8");
  expect(saved).toMatch(/1 BIRT\r?\n2 DATE 1880\r?\n(?:[2-9] .*\r?\n)*1 ORDN\r?\n2 DATE 1904\r?\n/);
  expect(saved).toMatch(/0 @F1@ FAM\r?\n(?:[1-9] .*\r?\n)*1 ANUL\r?\n2 DATE 1910\r?\n/);
});
