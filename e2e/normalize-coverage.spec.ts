import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// A file in MacFamilyTree's shape: each source states what it covers as a flat
// PLAC/DATE and carries the archive's id as a filing number. Choosing the
// standard coverage in Settings is what converts both — the PLAC/DATE into
// DATA › EVEN, the FILN into the repository link's call number. The Normalize
// preview has to re-run on that choice, or the pass is never offered: its
// count stays at what the file's own habit needed, which is nothing.
const FILE = path.join(tmpdir(), "normalize-coverage.ged");

writeFileSync(
  FILE,
  [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Ana /Kern/", "1 SEX F",
    "1 BIRT", "2 DATE 12 MAR 1868", "2 SOUR @S1@", "3 PAGE 56",
    "0 @S1@ SOUR",
    "1 TITL Krstna knjiga / Taufbuch - 02329 | Stara Loka",
    "1 PLAC Stara Loka",
    "1 DATE 1790-1803",
    "1 FILN 02329",
    "1 REPO @R1@",
    "0 @R1@ REPO", "1 NAME Nadškofijski arhiv Ljubljana",
    "0 TRLR",
  ].join("\n"),
);

test("choosing the standard source coverage offers the conversion in Normalize", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Normalize & batch", { exact: true }).click();
  // The card opens on Batch actions; the preview lives on its sibling tab.
  await page.locator(".batch-section-tab", { hasText: "Normalize file" }).click();
  // The first run works against the file's own habit and finds nothing.
  await expect(page.locator(".tools-clean--ok")).toBeVisible({ timeout: 20000 });

  // Choose the standard shape in Settings › GEDCOM.
  await page.locator('button[title*="etting"]').first().click();
  await page.locator('.settings-tabs button', { hasText: "GEDCOM" }).click();
  const setting = page.locator(".settings-format-row", { hasText: "Source coverage" });
  await setting.locator("button").first().click();
  await page.locator('.dd-menu .dd-item[data-value="standard"]').click();
  await page.keyboard.press("Escape");

  // The preview re-runs against the new choice and now has work to offer.
  const row = page.locator(".tools-norm-check", { hasText: /coverage shape/ });
  await expect(row).toBeVisible({ timeout: 20000 });
  await expect(row).toContainText("1 source restated");
});
