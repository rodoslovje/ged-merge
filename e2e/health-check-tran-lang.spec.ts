import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// Tools → Health check, translations without a language: MacFamilyTree's
// place TRANs with no LANG are listed once per name, each part with a
// suggested language; a changed pick and the batch write settle them all.
const FILE = path.join(tmpdir(), "health-check-tran-lang.ged");

writeFileSync(FILE, [
  "0 HEAD", "1 SOUR TEST", "1 GEDC", "2 VERS 7.0.3", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Jurij /Mladič/", "1 SEX M",
  "1 BIRT", "2 DATE 1840", "2 PLAC Srednje Bitnje,Kranj", "3 TRAN M.Feichting",
  "1 DEAT", "2 DATE 1900", "2 PLAC Hotemaže,Šenčur", "3 TRAN M.Vellach, Media Wella",
  "0 @I2@ INDI", "1 NAME Ana /Kos/", "1 SEX F",
  "1 BIRT", "2 DATE 1845", "2 PLAC Srednje Bitnje,Kranj", "3 TRAN M.Feichting",
  "0 TRLR", "",
].join("\n"), "utf-8");

test("translations without a language: suggested, re-picked and written", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor();

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Health check", { exact: true }).first().click();
  await page.getByRole("tab", { name: /GEDCOM .* issues/ }).click();
  // One row for all three, which takes the reader to the chip of its own.
  const row = page.locator(".tools-issue", { hasText: "have no LANG line" });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("(3×)");
  await row.getByRole("button", { name: "Choose languages" }).click();
  await expect(page.locator(".tools-chip.active", { hasText: "Translations without a language" })).toBeVisible();
  const section = page.locator(".tools-tran-list");
  await expect(section).toBeVisible();
  const vellach = section.locator(".tools-issue", { hasText: "Media Wella" });
  await expect(vellach.getByRole("button", { name: "Language of Media Wella" })).toContainText("(la)");
  await expect(vellach).toContainText("→ 2 lines");

  // Both parts German: the line is no longer split.
  await vellach.getByRole("button", { name: "Language of Media Wella" }).click();
  await vellach.getByRole("menuitemradio", { name: /\(de\)/ }).click();
  await expect(vellach).not.toContainText("→ 2 lines");

  await page.locator(".tools-fix-item").getByRole("button", { name: "Write the chosen languages (3)" }).click();
  await page.getByRole("button", { name: "Apply fix" }).click();
  await expect(page.locator(".tools-clean--ok", { hasText: "Languages written on 2 records." })).toBeVisible();
  await expect(page.locator(".tools-issue", { hasText: "no LANG line" })).toHaveCount(0);

  expect(errors).toEqual([]);
});
