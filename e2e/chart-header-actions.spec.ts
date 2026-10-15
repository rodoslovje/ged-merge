import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// A full-page chart carries the app's own header, so its Save, Undo/Redo and
// Add person must act over the chart. The save preview used to open in the
// app hidden beneath the chart, so Save on a chart appeared to do nothing.

const FILE = path.join(tmpdir(), "chart-header-actions.ged");

writeFileSync(
  FILE,
  [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Jurij /Vidmar/", "1 SEX M",
    "1 BIRT", "2 DATE 12 MAR 1880", "2 PLAC Kranj",
    "1 FAMC @F1@",
    "0 @I2@ INDI", "1 NAME Janez /Vidmar/", "1 SEX M", "1 FAMS @F1@",
    "0 @F1@ FAM", "1 HUSB @I2@", "1 CHIL @I1@",
    "0 TRLR", "",
  ].join("\n"),
  "utf-8",
);

test("Save, Undo/Redo and Add person in the header work on a chart", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor();

  const birthDate = page.locator(".edit-event").first().locator(".edit-event-date");
  await birthDate.fill("13 MAR 1880");
  await birthDate.blur();

  await page.locator(".charts-open-btn").click();
  await expect(page.locator("svg.tree-svg")).toBeVisible();

  // The header's Save opens its preview over the chart…
  const saveBtn = page.locator(".tree-shell .app-head-actions .export-btn");
  await expect(saveBtn).toBeEnabled();
  await saveBtn.click();
  await expect(page.locator(".preview-card").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".preview-card")).toHaveCount(0);

  // …and so does the save chord.
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.locator(".preview-card").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".preview-card")).toHaveCount(0);

  // Undo and Redo take the edit back and forth without leaving the chart.
  await page.locator(".tree-shell .undo-btn").first().click();
  await expect(saveBtn).toBeDisabled();
  await expect(page.locator("svg.tree-svg")).toBeVisible();
  await page.locator(".tree-shell .undo-btn").nth(1).click();
  await expect(saveBtn).toBeEnabled();
  await expect(page.locator("svg.tree-svg")).toBeVisible();

  // Add person leaves the chart for Edit, where the new person is.
  await page.locator(".tree-shell").getByRole("button", { name: "Add new person" }).click();
  await expect(page.locator("svg.tree-svg")).toHaveCount(0);
  await expect(page.locator(".edit-person").first()).toBeVisible();
});
