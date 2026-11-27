import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// GEDCOM has no type for a house or farm name: 7.0 writes TYPE OTHER, and the
// PHRASE under it is the only thing that says what kind of other name it is.
// The editor asks for that word when "other name" is picked.
const FILE = path.join(tmpdir(), "edit-other-name-phrase.ged");

writeFileSync(FILE, [
  "0 HEAD", "1 GEDC", "2 VERS 7.0",
  "0 @I1@ INDI", "1 NAME Janez /Novak/", "1 SEX M",
  "0 TRLR", "",
].join("\n"), "utf-8");

test("an 'other' name takes a word for what it is, written as its PHRASE", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor();

  await page.getByRole("button", { name: /Add Name/i }).first().click();
  const editor = page.locator(".edit-name-chip-editing");
  const inputs = editor.locator(".edit-name-variant-input");
  await inputs.nth(1).fill("Mlinar");
  // No word to ask for while the name is of a type the standard defines.
  await expect(inputs).toHaveCount(2);

  const trigger = editor.locator(".edit-name-type-select");
  const menu = page.locator(".dd-menu");
  await expect(async () => {
    if ((await menu.count()) === 0) await trigger.click();
    await expect(menu).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await page.locator('.dd-menu .dd-item[data-value="other"]').click();

  await expect(inputs).toHaveCount(3);
  await inputs.nth(2).fill("hišno ime");
  // Focus moves on inside the editor (leaving it closes it): the field commits.
  await page.keyboard.press("Tab");

  const saveBtn = page.locator(".app-head-actions .export-btn");
  await expect(saveBtn).toBeEnabled();
  await saveBtn.click();
  await page.getByRole("tab", { name: "GEDCOM lines" }).click();
  const diff = page.locator(".preview-diff");
  await expect(diff.locator(".diff-line.is-add", { hasText: "2 TYPE OTHER" })).toBeVisible();
  await expect(diff.locator(".diff-line.is-add", { hasText: "3 PHRASE hišno ime" })).toBeVisible();
});
