import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "./tmpdir";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(__dirname, "../src/__fixtures__/corpus/reunion-5.5.1-utf8.ged");

// The keys are said where they work: tooltips carry them for the platform,
// the lists show theirs as keycaps, the sheet opens from the header and
// leads with the keys that apply, and the decision letters do what they say.

const HEAD = ["0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8"];

async function openMerge(page: Page) {
  const main = path.join(tmpdir(), "kbd-disc-main.ged");
  const compare = path.join(tmpdir(), "kbd-disc-compare.ged");
  writeFileSync(main, [
    ...HEAD,
    "0 @I1@ INDI", "1 NAME Janez /Novak/", "1 SEX M", "1 BIRT", "2 DATE 12 JAN 1900", "2 PLAC Kranj",
    "0 @I2@ INDI", "1 NAME Marija /Kovač/", "1 SEX F", "1 BIRT", "2 DATE 3 MAR 1905", "2 PLAC Škofja Loka",
    "0 TRLR", "",
  ].join("\n"), "utf-8");
  writeFileSync(compare, [
    ...HEAD,
    "0 @P1@ INDI", "1 NAME Janez /Novak/", "1 SEX M", "1 BIRT", "2 DATE 12 JAN 1900", "2 PLAC Kranj",
    "0 @P2@ INDI", "1 NAME Marija /Kovač/", "1 SEX F", "1 BIRT", "2 DATE 3 MAR 1905", "2 PLAC Škofja Loka",
    "0 TRLR", "",
  ].join("\n"), "utf-8");
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(main);
  await page.getByRole("button", { name: "Merge", exact: true }).click();
  await page.locator("input.file-input").last().setInputFiles(compare);
  await expect(page.locator(".candidate")).toHaveCount(2);
}

async function openEdit(page: Page) {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(SAMPLE);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();
}

test("C and D decide the highlighted match, and the list shows its keys", async ({ page }) => {
  await openMerge(page);
  const first = page.locator(".candidate").first();
  await page.keyboard.press("c");
  await expect(first.locator(".status-chip.confirmed")).toBeVisible();
  await page.keyboard.press("d");
  await expect(first.locator(".status-chip.deferred")).toBeVisible();
  // The keycaps beside the filter button name these keys.
  const caps = page.locator(".matches-actions .key-hint kbd");
  await expect(caps).toHaveCount(5);
  await expect(caps.nth(2)).toHaveText("C");
});

test("? opens the sheet with the keys for Merge first, and the header button does too", async ({ page }) => {
  await openMerge(page);
  await page.keyboard.press("?");
  const modal = page.locator(".shortcuts-modal");
  await expect(modal).toBeVisible();
  const sections = modal.locator(".shortcuts-section");
  await expect(sections.first()).toHaveText(/Here — Merge/);
  await expect(sections.nth(1)).toHaveText(/Elsewhere/);
  // The decisions live under "Here"; the editing chords under "Elsewhere"
  // (the Editing group stays up here for N, which adds a person from Merge too).
  const here = modal.locator(".shortcuts-grid").first();
  const elsewhere = modal.locator(".shortcuts-grid").nth(1);
  await expect(here.getByRole("heading", { name: "Match decisions" })).toBeVisible();
  await expect(here.locator(".shortcuts-row").filter({ hasText: /Add a father/ })).toHaveCount(0);
  await expect(elsewhere.locator(".shortcuts-row").filter({ hasText: /Add a father/ })).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);

  await page.locator(".shortcuts-btn").click();
  await expect(modal).toBeVisible();
});

test("tooltips carry their key, spelled for the platform", async ({ page }) => {
  await openEdit(page);
  await expect(page.locator(".charts-open-btn")).toHaveAttribute("title", /\(V\)$/);
  // The undo button appears once there is something to undo.
  const given = page.locator(".edit-name-input").first();
  await given.click();
  await given.fill("Keycap");
  await page.keyboard.press("Escape");
  await expect(page.locator(".undo-btn").first()).toHaveAttribute("title", /\((⌘Z|Ctrl\+Z)\)$/);
  await expect(page.locator(".person-card-add").first()).toHaveAttribute("title", /\((⌥⇧|Alt\+Shift\+)[FMPC]\)$/);
});

test("⌥↑ opens the father from the person in Edit", async ({ page }) => {
  await openEdit(page);
  const name = page.locator(".edit-name-input").first();
  const before = await name.inputValue();
  // The start person of the sample has parents; the chord walks to one.
  await page.keyboard.press("Alt+ArrowUp");
  await expect(name).not.toHaveValue(before);
});

test("the relative picker's arrows pick a row", async ({ page }) => {
  await openEdit(page);
  await page.keyboard.press("Alt+Shift+KeyP");
  const picker = page.locator(".relative-picker");
  await picker.locator(".relative-picker-input").fill("a");
  const rows = picker.locator(".relative-picker-option:not(.relative-picker-new)");
  await expect(rows.first()).toBeVisible();
  const name = (await rows.first().locator(".person-name").textContent())!.trim();
  await page.keyboard.press("ArrowDown");
  await expect(rows.first()).toHaveClass(/highlighted/);
  await page.keyboard.press("Enter");
  await expect(picker).toHaveCount(0);
  await expect(page.locator(".edit-family .person-card").filter({ hasText: name }).first()).toBeVisible();
});
