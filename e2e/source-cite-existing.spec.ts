import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// A book has no link to be matched by: "+ Add source" finds it by name among
// the file's own sources and cites it with a page of its own, instead of
// writing a second record of the same book.
const FILE = path.join(tmpdir(), "source-cite-existing.ged");

writeFileSync(
  FILE,
  [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Blaž /Kern/", "1 SEX M",
    "1 BIRT", "2 DATE 1 JAN 1850", "2 SOUR @S1@", "3 PAGE 12",
    "0 @S1@ SOUR", "1 TITL Cerkniško jezero in ljudje ob njem", "1 AUTH Kebe, Janez",
    "0 TRLR",
  ].join("\n"),
);

test("a source already in the file is found by name and cited with another page", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();
  const dialog = page.locator(".add-source-dialog");
  const pageField = dialog.locator("label.add-source-field", { hasText: /^Page/ }).locator("input");
  const addChip = page.locator(".edit-name-chip-add", { hasText: "Add Source" }).first();

  // Typed, without diacritics, into the paste box: the book is offered.
  await addChip.click();
  await dialog.locator(".add-source-textarea").fill("kebe cerknisko");
  await dialog.locator(".add-source-found-row", { hasText: "Cerkniško jezero in ljudje ob njem" }).click();
  await expect(dialog.locator(".add-source-chip")).toContainText("already in the file");
  await expect(pageField).toBeFocused();
  await pageField.fill("45");
  await dialog.getByRole("button", { name: "Add source", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  // The same title typed by hand into the Title field: the book is proposed.
  await addChip.click();
  await dialog.locator("label.add-source-field", { hasText: /^Title/ }).locator("input").fill("Cerkniško jezero in ljudje ob njem");
  await dialog.getByRole("button", { name: "Cite that source", exact: true }).click();
  await pageField.fill("7");
  await pageField.press("Enter");
  await expect(dialog).toHaveCount(0);

  // The birth's own citation, cited once more on the birth.
  await page.locator(".edit-person .source-ref").last().click();
  await dialog.getByRole("button", { name: "Cite again", exact: true }).click();
  await expect(dialog.locator(".add-source-chip")).toContainText("Cerkniško jezero in ljudje ob njem");
  await pageField.fill("99");
  await dialog.getByRole("button", { name: "Add source", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  await page.locator(".app-head-actions .export-btn").click();
  const download = page.waitForEvent("download", (d) => d.suggestedFilename().endsWith(".ged"));
  await page.locator(".preview-actions .export-btn").click();
  const text = readFileSync((await (await download).path())!, "utf-8");
  expect(text.match(/^0 @\S+@ SOUR/gm)).toHaveLength(1);
  expect(text).toContain("1 SOUR @S1@\n2 PAGE 45");
  expect(text).toContain("1 SOUR @S1@\n2 PAGE 7");
  expect(text).toContain("2 SOUR @S1@\n3 PAGE 12");
  expect(text).toContain("2 SOUR @S1@\n3 PAGE 99");
});
