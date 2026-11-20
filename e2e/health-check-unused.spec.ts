import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

/** One cited source, and a source, a note and a photo nothing points at. */
function writeFixture(): string {
  const ged = [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "2 FORM LINEAGE-LINKED", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Ana /Novak/", "1 SEX F", "1 BIRT", "2 DATE 1900", "2 SOUR @S1@",
    "0 @S1@ SOUR", "1 TITL Krstna knjiga Kranj",
    "0 @S2@ SOUR", "1 TITL Mrliška knjiga Naklo",
    "0 @N1@ NOTE Opomba brez lastnika",
    "0 @O1@ OBJE", "1 FILE slika.jpg", "2 FORM jpg",
    "0 TRLR", "",
  ].join("\n");
  const filePath = path.join(tmpdir(), `health-unused-${Date.now()}.ged`);
  writeFileSync(filePath, ged, "utf-8");
  return filePath;
}

// Removing an event or a citation leaves its note, photo or source in the
// file with nothing pointing at it. The health check says so.
test("the health check lists shared records nothing points at", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(writeFixture());
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Health check", { exact: true }).first().click();

  // No issue of the file's: neither the tab's count nor "All" includes them.
  await expect(page.getByRole("tab", { name: /Data issues/ })).toContainText("2");
  await expect(page.locator(".tools-chip", { hasText: "All" })).toContainText("2");
  await expect(page.locator(".tools-issues")).not.toContainText("Nothing in the file points at this record");

  await page.locator(".tools-chip", { hasText: "Unused records" }).click();
  await expect(page.locator(".tools-chip", { hasText: "Unused records" })).toContainText("3");
  const rows = page.locator(".tools-issues").getByText("Nothing in the file points at this record");
  await expect(rows).toHaveCount(3);
  await expect(page.locator(".tools-issues")).toContainText("Mrliška knjiga Naklo");
  await expect(page.locator(".tools-issues")).not.toContainText("Krstna knjiga Kranj");
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });
});
