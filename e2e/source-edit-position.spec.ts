import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// Editing a source from the Sources tree must leave the tree as it was: the
// rows the reader opened still open, and the list still scrolled where they
// were reading. Rebuilding it after the save is what puts that at risk.
const FILE = path.join(tmpdir(), "source-edit-position.ged");

const sources = Array.from({ length: 40 }, (_, i) => [
  `0 @S${i}@ SOUR`,
  `1 TITL Krstna knjiga ${String(i).padStart(3, "0")} | Preddvor`,
  `1 FILN ${1000 + i}`,
  "1 REPO @R1@",
]).flat();

writeFileSync(
  FILE,
  [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Ana /Kern/", "1 SEX F", "1 BIRT", "2 SOUR @S0@",
    ...sources,
    "0 @R1@ REPO", "1 NAME Nadškofijski arhiv Ljubljana",
    "0 TRLR",
  ].join("\n"),
);

test("editing a source leaves the tree open where it was", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Sources", { exact: true }).click();

  // Open the archive so its sources show (it may already be).
  const repoRow = page.locator(".tools-tree-row", { hasText: "Nadškofijski arhiv" }).first();
  await expect(repoRow).toBeVisible({ timeout: 15000 });
  const rows = page.locator(".tools-tree-row", { hasText: /Krstna knjiga/ });
  if (!(await rows.count())) await repoRow.locator(".tools-pair-toggle").click();
  await expect(rows.first()).toBeVisible();
  const openedRows = await rows.count();
  expect(openedRows).toBeGreaterThan(30);

  // Edit one well down the list, and save an unchanged title.
  const target = page.locator(".tools-tree-row", { hasText: "Krstna knjiga 030" }).first();
  await target.scrollIntoViewIfNeeded();
  const before = await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0);
  await target.hover();
  await target.locator(".tools-place-edit-btn").click();
  const dialog = page.locator(".add-source-dialog");
  await expect(dialog).toBeVisible();
  await dialog.locator("input").first().fill("Krstna knjiga 030 | Preddvor (popravljeno)");
  await dialog.getByRole("button", { name: /Save|Shrani/ }).click();
  await expect(dialog).toBeHidden();

  // The archive is still open, and the reader is still where they were.
  await expect(rows).toHaveCount(openedRows);
  const after = await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0);
  expect(Math.abs(after - before)).toBeLessThan(120);
});
