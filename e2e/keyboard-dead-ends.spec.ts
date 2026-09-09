import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "./tmpdir";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(__dirname, "../src/__fixtures__/corpus/reunion-5.5.1-utf8.ged");

// The keyboard-only pass of 2026-09-09: the places a keyboard user used to
// hit a wall — a menu whose Escape leaked to the page, a picker whose rows
// only answered the mouse, a sheet that could not be opened from a field, a
// save dialog that opened on its × — each answer the key now.

async function openEdit(page: Page) {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(SAMPLE);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();
}

test("F1 opens the shortcut sheet from inside a field", async ({ page }) => {
  await openEdit(page);
  const given = page.locator(".edit-name-input").first();
  await given.click();
  await page.keyboard.press("F1");
  await expect(page.locator(".shortcuts-modal")).toBeVisible();
  // Escape is the sheet's, and only the sheet's: the person stays open.
  await page.keyboard.press("Escape");
  await expect(page.locator(".shortcuts-modal")).toHaveCount(0);
  await expect(page.locator(".edit-person")).toBeVisible();
});

test("a relative-picker row reached with Tab picks on Enter", async ({ page }) => {
  await openEdit(page);
  // A partner, not a child: a child who already has parents is asked about
  // first, and the question is not what this test is about.
  await page.keyboard.press("Alt+Shift+KeyP");
  const picker = page.locator(".relative-picker");
  await picker.locator(".relative-picker-input").fill("a");
  const rows = picker.locator(".relative-picker-option:not(.relative-picker-new)");
  await expect(rows.first()).toBeVisible();
  const name = (await rows.first().locator(".person-name").textContent())!.trim();

  // Past the "+ Add new person" row, onto the first person, and take it.
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(rows.first()).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(picker).toHaveCount(0);
  await expect(page.locator(".edit-family .person-card").filter({ hasText: name }).first()).toBeVisible();
});

test("Escape closes the Export menu and stays on the chart", async ({ page }) => {
  await openEdit(page);
  await page.locator(".charts-open-btn").click();
  await page.locator("svg.tree-svg").waitFor();

  const trigger = page.locator(".tree-export-btn");
  await trigger.click();
  const popover = page.locator(".export-menu-popover");
  await expect(popover).toBeVisible();
  // The first item took focus, so the arrows and Enter have somewhere to act.
  await expect(popover.locator(".export-menu-item").first()).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await expect(trigger).toBeFocused();
  // One press, one layer: the chart underneath is still there.
  await expect(page.locator("svg.tree-svg")).toBeVisible();
});

test("the save dialog opens on Download and ⌘/Ctrl+Enter is its answer", async ({ page }) => {
  await openEdit(page);
  const given = page.locator(".edit-name-input").first();
  await given.click();
  await given.fill("Keyboard");
  await page.keyboard.press("Escape");

  await page.keyboard.press("ControlOrMeta+KeyS");
  const download = page.locator(".preview-actions .export-btn");
  await expect(download).toBeFocused();

  const saved = page.waitForEvent("download");
  await page.keyboard.press("ControlOrMeta+Enter");
  await saved;
  await expect(page.locator(".preview-actions")).toHaveCount(0);
});

test("F shows and hides the match filters", async ({ page }) => {
  const HEAD = ["0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8"];
  const main = path.join(tmpdir(), "kbd-main.ged");
  const compare = path.join(tmpdir(), "kbd-compare.ged");
  writeFileSync(main, [
    ...HEAD,
    "0 @I1@ INDI", "1 NAME Janez /Novak/", "1 SEX M", "1 BIRT", "2 DATE 12 JAN 1900", "2 PLAC Kranj",
    "0 TRLR", "",
  ].join("\n"), "utf-8");
  writeFileSync(compare, [
    ...HEAD,
    "0 @P1@ INDI", "1 NAME Janez /Novak/", "1 SEX M", "1 BIRT", "2 DATE 12 JAN 1900", "2 PLAC Kranj",
    "0 TRLR", "",
  ].join("\n"), "utf-8");

  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(main);
  await page.getByRole("button", { name: "Merge", exact: true }).click();
  await page.locator("input.file-input").last().setInputFiles(compare);
  await page.locator(".candidate").first().waitFor();

  // The row is shown to begin with; F hides it and shows it again.
  const filters = page.locator(".filters");
  await expect(filters).toBeVisible();
  await page.keyboard.press("f");
  await expect(filters).toHaveCount(0);
  await page.keyboard.press("f");
  await expect(filters).toBeVisible();
});
