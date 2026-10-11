import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// A note a confirmed match brings to the marriage is a proposal in a field of
// its own. Typing into it used to swap that field for the note list on the
// first keystroke, taking the caret along — so the next Backspace landed on the
// page, where it is Back, and the person was left mid-edit.

const MAIN = path.join(tmpdir(), "merge-note-main.ged");
const COMPARE = path.join(tmpdir(), "merge-note-compare.ged");
const NOTE = "priči Andreas Gnesda, Blasius Liker, oba z Vojskega";

const couple = (marrNote?: string) => [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Jernej /Sedej/", "1 SEX M", "1 BIRT", "2 DATE 14 AUG 1757", "1 FAMS @F1@",
  "0 @I2@ INDI", "1 NAME Neža /Logar/", "1 SEX F", "1 BIRT", "2 DATE 1764", "1 FAMS @F1@",
  "0 @F1@ FAM", "1 HUSB @I1@", "1 WIFE @I2@", "1 MARR", "2 DATE 27 JAN 1784", "2 PLAC Vojsko",
  ...(marrNote ? ["2 NOTE " + marrNote] : []),
  "0 TRLR", "",
].join("\n");

writeFileSync(MAIN, couple(), "utf-8");
writeFileSync(COMPARE, couple(NOTE), "utf-8");

test("a merge-proposed marriage note keeps the caret while it is edited", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(MAIN);
  await page.locator(".edit-person").first().waitFor();

  await page.getByRole("button", { name: "Merge", exact: true }).click();
  await page.locator("input.file-input").last().setInputFiles(COMPARE);
  await page.locator(".candidate").first().waitFor();
  await page.locator(".candidate-main").first().click();
  await page.locator(".decision-bar button").first().click();

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const person = page.locator(".edit-person").first();
  await person.waitFor();
  const name = await person.locator(".edit-name-input").first().inputValue();

  const note = page.locator(".edit-families .edit-event textarea.edit-event-note").first();
  await expect(note).toHaveValue(NOTE);
  await note.click();
  await note.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length, el.value.length));
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");

  await expect(note).toBeFocused();
  await expect(note).toHaveValue(NOTE.slice(0, -3));
  // Still on the same person: no Backspace was taken for Back.
  await expect(person.locator(".edit-name-input").first()).toHaveValue(name);

  // Leaving the field commits the edited note, and the save writes it.
  await page.keyboard.press("Escape");
  await page.locator(".app-head-actions .export-btn").click();
  const download = page.waitForEvent("download", (d) => d.suggestedFilename().endsWith(".ged"));
  await page.locator(".preview-actions .export-btn").click();
  const content = readFileSync((await (await download).path())!, "utf-8");
  expect(content).toContain("2 NOTE " + NOTE.slice(0, -3) + "\n");
});
