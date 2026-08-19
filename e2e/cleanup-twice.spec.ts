import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// Converting one site's links, then coming back for the next: the page
// re-scans itself after an apply, and the second run has to work off what
// that scan brought rather than what the first one was holding.
const FILE = path.join(tmpdir(), "cleanup-twice.ged");

writeFileSync(
  FILE,
  [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Ana /Kern/", "1 SEX F",
    "1 BIRT", "2 DATE 12 MAR 1868", "2 PLAC Šenčur, Kranj, Slovenia",
    "2 NOTE KK https://data.matricula-online.eu/sl/slovenia/ljubljana/sencur/03173/?pg=56",
    // The second group's shape in a real file: the link is a media record
    // attached to the person, and the file already holds a source for it —
    // the row the panel badges EXISTING.
    "0 @I2@ INDI", "1 NAME Janez /Sajovic/", "1 SEX M",
    "1 OBJE @O1@",
    "1 BIRT", "2 DATE 1831",
    "0 @O1@ OBJE",
    "1 FILE https://www.slovenska-biografija.si/oseba/sbi123456/",
    "1 TITL Sajovic, Janez (1831–1917) - Slovenska biografija",
    "0 @S1@ SOUR",
    "1 TITL Sajovic, Janez (1831–1917) - Slovenska biografija",
    "1 OBJE @O1@",
    "0 TRLR",
  ].join("\n"),
);

test("a second run converts the next site after the first one re-scanned", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Sources", { exact: true }).click();
  const openCleanup = page.locator(".tools-dup-toggle", { hasText: "Organize sources" });
  await expect(openCleanup).toBeEnabled({ timeout: 15000 });
  await openCleanup.click();

  // The first site with hits arrives ticked; convert it.
  const apply = page.getByRole("button", { name: /Convert to sources|Apply to the file/ });
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(page.locator(".tools-cleanup-status")).toContainText(/record/i);

  // Now the other site: tick its chip and convert that too.
  const other = page.locator(".tools-reshape-site", { hasText: /biografija|Matricula/ }).last();
  await other.locator("input[type=checkbox]").check();
  const applyAgain = page.getByRole("button", { name: /Convert to sources|Apply to the file/ });
  await expect(applyAgain).toBeEnabled();
  await applyAgain.click();

  // Each run leaves its own rows behind it: a converted group that comes back
  // on the next scan can never be cleared, and a run holding only such rows
  // writes nothing at all.
  await expect(page.locator(".tools-cleanup-status")).toContainText(/record/i);
  await expect(page.locator(".tools-cleanup-section").first().locator(".tools-tree-node")).toHaveCount(0);

  // Both books are now source records in the file, and nothing blew up.
  await page.getByRole("button", { name: /Back to Sources|Nazaj/ }).click();
  const tree = page.locator(".tools-tree").first();
  await expect(tree).toContainText("Matricula", { timeout: 10000 });
  await expect(tree).toContainText(/biografija/i);
  expect(errors).toEqual([]);
});
