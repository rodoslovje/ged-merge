import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// Backspace is Back everywhere outside a field, so a field that loses the
// caret while it is being emptied sends the next Backspace to the page. An
// optional event field shows only while it has a value, and deleting its last
// character used to hide it under the caret. Every field of a person's events
// and a marriage is emptied here — as the file's own values, and as values a
// confirmed match proposes — with two presses to spare.

const MAIN = path.join(tmpdir(), "field-backspace-main.ged");
const RICH = path.join(tmpdir(), "field-backspace-rich.ged");

const file = (rich: boolean) => [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Jernej /Sedej/", "1 SEX M",
  "1 BIRT", "2 DATE 14 AUG 1757",
  ...(rich ? ["2 PLAC Vojsko, Idrija, Slovenia", "2 ADDR Vojsko 12", "2 AGNC Župnija Vojsko", "2 NOTE botri: Janez Troha"] : []),
  ...(rich ? ["1 OCCU kmet", "2 DATE 1790", "2 PLAC Vojsko", "1 DEAT", "2 DATE 1820", "2 CAUS jetika", "2 PLAC Vojsko"] : []),
  "1 FAMS @F1@",
  "0 @I2@ INDI", "1 NAME Neža /Logar/", "1 SEX F", "1 BIRT", "2 DATE 1764", "1 FAMS @F1@",
  "0 @F1@ FAM", "1 HUSB @I1@", "1 WIFE @I2@", "1 MARR", "2 DATE 27 JAN 1784",
  ...(rich ? ["2 PLAC Vojsko, Idrija, Slovenia", "2 NOTE priči Andreas Gnesda"] : []),
  "0 TRLR", "",
].join("\n");

writeFileSync(MAIN, file(false), "utf-8");
writeFileSync(RICH, file(true), "utf-8");

async function openMerged(page: Page) {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(MAIN);
  await page.locator(".edit-person").first().waitFor();
  await page.getByRole("button", { name: "Merge", exact: true }).click();
  await page.locator("input.file-input").last().setInputFiles(RICH);
  await page.locator(".candidate").first().waitFor();
  await page.locator(".candidate-main", { hasText: "Jernej" }).first().click();
  await page.locator(".decision-bar button").first().click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").first().waitFor();
}

async function openPlain(page: Page) {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(RICH);
  await page.locator(".edit-person").first().waitFor();
}

async function emptyEachField(page: Page, open: (p: Page) => Promise<void>, sel: string, expected: number) {
  await open(page);
  await expect(page.locator(sel)).toHaveCount(expected);
  for (let i = 0; i < expected; i++) {
    await open(page);
    await expect(page.locator(sel)).toHaveCount(expected);
    const field = page.locator(sel).nth(i);
    const len = await field.evaluate((el) => ((el as HTMLInputElement).value ?? el.textContent ?? "").length);
    await field.click();
    await field.evaluate((el) => {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.setSelectionRange(el.value.length, el.value.length);
      else {
        const r = document.createRange();
        r.selectNodeContents(el);
        r.collapse(false);
        getSelection()!.removeAllRanges();
        getSelection()!.addRange(r);
      }
    });
    const handle = await field.elementHandle();
    for (let k = 0; k < len + 2; k++) await page.keyboard.press("Backspace");
    expect(await handle!.evaluate((el) => document.activeElement === el), `field ${i} kept the caret`).toBe(true);
    await expect(page.locator(".edit-person .edit-name-input").first()).toHaveValue("Jernej");
  }
}

test("every merge-proposed event field keeps the caret while it is emptied", async ({ page }) => {
  test.setTimeout(240_000);
  await emptyEachField(page, openMerged, ".edit-event .edit-input--merge", 12);
});

test("every event field keeps the caret while it is emptied", async ({ page }) => {
  test.setTimeout(240_000);
  await emptyEachField(page, openPlain, ".edit-event input.edit-input:visible, .edit-event [contenteditable]:visible", 14);
});
