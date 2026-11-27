import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// A source made from its link alone carries the title the address gives it
// ("Matricula 04406 | Vodice"), and being a source already, nothing looked at
// it again. Organize sources now offers it: its own page media names the
// book, and the record is renamed in place.
const FILE = path.join(tmpdir(), "cleanup-placeholder-title.ged");

writeFileSync(
  FILE,
  [
    "0 HEAD", "1 GEDC", "2 VERS 7.0",
    "0 @I1@ INDI", "1 NAME Ana /Kern/", "1 SEX F",
    "1 BIRT", "2 DATE 12 MAR 1868", "2 SOUR @S1@", "3 PAGE 6",
    "0 @S1@ SOUR",
    "1 TITL Matricula 04406 | Vodice",
    "1 OBJE @O1@",
    "0 @O1@ OBJE",
    "1 FILE https://data.matricula-online.eu/sl/slovenia/ljubljana/vodice/04406/?pg=6",
    "2 FORM text/html",
    "2 TITL #006 - Krstna knjiga / Taufbuch - 04406 | Vodice | Nadškofijski arhiv Ljubljana | Slovenia | Matricula Online",
    "0 TRLR",
  ].join("\n"),
);

test("a source still under its link-only title is offered and renamed in place", async ({ page }) => {
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

  await expect(page.locator(".tools-cleanup-section").first()).toContainText("Krstna knjiga / Taufbuch - 04406 | Vodice");
  await page.getByRole("button", { name: "Select all" }).click();
  const apply = page.getByRole("button", { name: /Convert to sources/ });
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(page.locator(".tools-cleanup-status")).toContainText(/record/i);
  // Renamed once: the next scan has nothing left to offer for it.
  await expect(page.locator(".tools-cleanup-section").first().locator(".tools-tree-node")).toHaveCount(0);

  await page.getByRole("button", { name: /Back to Sources|Nazaj/ }).click();
  const tree = page.locator(".tools-tree").first();
  await expect(tree).toContainText("Krstna knjiga / Taufbuch - 04406 | Vodice", { timeout: 10000 });
  await expect(tree).not.toContainText("Matricula 04406 | Vodice");
  expect(errors).toEqual([]);
});
