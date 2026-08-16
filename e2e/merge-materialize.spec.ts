import { test, expect, type Page, type Locator } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

const MAIN = path.join(tmpdir(), "mm-main.ged");
const COMPARE = path.join(tmpdir(), "mm-compare.ged");

writeFileSync(MAIN, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Ana /Kukic/", "1 SEX F",
  "1 BIRT", "2 DATE 9 AUG 1982", "2 PLAC Kranj",
  "1 RESI", "2 PLAC Metlika,Metlika,Slovenia", "2 ADDR Mestni trg 9",
  "0 TRLR", "",
].join("\n"), "utf-8");

writeFileSync(COMPARE, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Ana /Kukic/", "1 SEX F",
  "1 BIRT", "2 DATE 9 AUG 1982", "2 PLAC Kranj", "2 ADDR Kidriceva 38/a",
  "1 BAPM", "2 DATE 6 OCT 1982", "2 PLAC Strazisce,Kranj,Slovenia",
  "1 RESI", "2 DATE 1982", "2 PLAC Radovljica,Radovljica,Slovenia",
  "2 ADDR Gorenjska Cesta 33/a", "2 AGNC zupnija Radovljica",
  "0 TRLR", "",
].join("\n"), "utf-8");

async function rowByPlace(page: Page, place: string): Promise<Locator> {
  const rows = page.locator(".edit-person .edit-event");
  const n = await rows.count();
  for (let i = 0; i < n; i++) {
    const pl = rows.nth(i).locator(".edit-event-place");
    if ((await pl.count()) === 0) continue;
    if ((await pl.first().inputValue()).includes(place)) return rows.nth(i);
  }
  throw new Error("no event row with place " + place);
}

// A residence event materialized from an incoming-only merge suggestion stays
// fully marked (bold/dirty) on every field — and editing one field (the date)
// must not strip the dirty marker off its siblings.
test("materialized merge event keeps all fields marked after a later edit", async ({ page }) => {
  await page.goto("/");
  await page.locator('input.file-input').first().setInputFiles(MAIN);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });

  await page.getByRole("button", { name: "Merge", exact: true }).click();
  await page.locator('input.file-input').last().setInputFiles(COMPARE);
  await page.locator(".candidate").first().waitFor({ timeout: 30000 });
  await page.locator(".candidate-main").first().click();
  await page.locator(".decision-bar button").first().click();

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").first().waitFor();

  // Materialize the incoming-only Radovljica residence by editing its address.
  let rad = await rowByPlace(page, "Radovljica");
  await rad.locator(".edit-event-addr").fill("Gorenjska cesta 33/a");
  await page.keyboard.press("Tab");
  await page.waitForTimeout(400);

  // All its fields should now be marked dirty.
  rad = await rowByPlace(page, "Radovljica");
  await expect(rad.locator(".edit-event-date")).toHaveClass(/edit-input--dirty/);
  await expect(rad.locator(".edit-event-place")).toHaveClass(/edit-input--dirty/);
  await expect(rad.locator(".edit-event-addr")).toHaveClass(/edit-input--dirty/);

  // Editing the date must not clear the marking on the other fields.
  await rad.locator(".edit-event-date").fill("9 AUG 1982");
  await page.keyboard.press("Tab");
  await page.waitForTimeout(400);

  rad = await rowByPlace(page, "Radovljica");
  await expect(rad.locator(".edit-event-date")).toHaveClass(/edit-input--dirty/);
  await expect(rad.locator(".edit-event-place")).toHaveClass(/edit-input--dirty/);
  await expect(rad.locator(".edit-event-addr")).toHaveClass(/edit-input--dirty/);
});
