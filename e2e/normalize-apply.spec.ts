import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// Normalize changes the open file, as one step, and the save preview then
// shows what it changed. Its health-check repairs come with it: a 7.0 name
// type in the wrong case, a repeated SEX line, a media file with no FORM and a
// citation of a source that is not there.
const FILE = path.join(tmpdir(), "normalize-apply.ged");

writeFileSync(
  FILE,
  [
    "0 HEAD", "1 GEDC", "2 VERS 7.0",
    "0 @I1@ INDI", "1 NAME Ana /Kos/", "2 TYPE birth", "1 SEX F", "1 SEX F",
    "1 BIRT", "2 DATE 2 FEB 1850", "2 SOUR @S9@", "1 OBJE @M1@",
    "0 @M1@ OBJE", "1 FILE slike/ana.jpg",
    "0 TRLR",
  ].join("\n"),
);

test("Normalize applies its passes to the open file and Save shows the changes", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor();
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Normalize & batch", { exact: true }).click();
  await page.locator(".batch-section-tab", { hasText: "Normalize file" }).click();

  const repairs = page.locator(".tools-norm-check", { hasText: /repaired as the health check proposes/ });
  await expect(repairs).toBeVisible();
  const list = page.locator(".tools-examples", { hasText: "Health-check repairs" });
  await expect(list).toContainText("Remove dangling references");
  await expect(list).toContainText("Add media formats");

  await page.getByRole("button", { name: "Apply to the file" }).click();
  await expect(page.locator(".tools-clean--ok", { hasText: /^Normalized 2 records\./ })).toBeVisible();

  // The save preview lists the person; the download carries the repairs.
  await page.locator(".app-head-actions .export-btn").click();
  const preview = page.locator(".save-preview, .preview-body, .modal").first();
  await expect(preview.locator(".preview-card-head", { hasText: "Ana Kos" })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: /Download GEDCOM/ }).click();
  const text = await readFile(await (await download).path(), "utf-8");
  expect(text).toContain("2 TYPE BIRTH");
  expect(text).toMatch(/1 FILE slike\/ana\.jpg\r?\n2 FORM image\/jpeg/);
  expect(text).not.toContain("@S9@");
  expect(text.match(/1 SEX F/g)).toHaveLength(1);
});
