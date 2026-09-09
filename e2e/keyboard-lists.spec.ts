import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "./tmpdir";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(__dirname, "../src/__fixtures__/corpus/reunion-5.5.1-utf8.ged");

// One keyboard for every list (↑/↓ step, Enter opens), the comparison's own
// keys, a row of tabs as one Tab stop, and the chart's people as buttons the
// family walk starts from.

const HEAD = ["0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8"];

/** Two candidates that differ in a birth place, so the comparison has a row
 *  that offers a choice. */
function writeMergeFixture(): { main: string; compare: string } {
  const main = path.join(tmpdir(), "kbd-list-main.ged");
  const compare = path.join(tmpdir(), "kbd-list-compare.ged");
  writeFileSync(main, [
    ...HEAD,
    "0 @I1@ INDI", "1 NAME Janez /Novak/", "1 SEX M", "1 BIRT", "2 DATE 12 JAN 1900", "2 PLAC Kranj",
    "0 @I2@ INDI", "1 NAME Marija /Kovač/", "1 SEX F", "1 BIRT", "2 DATE 3 MAR 1905", "2 PLAC Škofja Loka",
    "0 TRLR", "",
  ].join("\n"), "utf-8");
  writeFileSync(compare, [
    ...HEAD,
    "0 @P1@ INDI", "1 NAME Janez /Novak/", "1 SEX M", "1 BIRT", "2 DATE 12 JAN 1900", "2 PLAC Kranj, Slovenija",
    "0 @P2@ INDI", "1 NAME Marija /Kovač/", "1 SEX F", "1 BIRT", "2 DATE 3 MAR 1905", "2 PLAC Škofja Loka",
    "0 TRLR", "",
  ].join("\n"), "utf-8");
  return { main, compare };
}

async function openMerge(page: Page) {
  const { main, compare } = writeMergeFixture();
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(main);
  await page.getByRole("button", { name: "Merge", exact: true }).click();
  await page.locator("input.file-input").last().setInputFiles(compare);
  await expect(page.locator(".candidate")).toHaveCount(2);
}

test("↓ and ↑ step the match list, Home and End go to its ends", async ({ page }) => {
  await openMerge(page);
  const rows = page.locator(".candidate");
  await expect(rows.nth(0)).toHaveClass(/selected/);
  await page.keyboard.press("ArrowDown");
  await expect(rows.nth(1)).toHaveClass(/selected/);
  await expect(rows.nth(1)).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("ArrowUp");
  await expect(rows.nth(0)).toHaveClass(/selected/);
  await page.keyboard.press("End");
  await expect(rows.nth(1)).toHaveClass(/selected/);
  await page.keyboard.press("Home");
  await expect(rows.nth(0)).toHaveClass(/selected/);
});

test("Enter enters the comparison, 2 takes the incoming value, Esc returns", async ({ page }) => {
  await openMerge(page);
  // Janez is the highlighted match; confirm him so the field choices unlock.
  await page.keyboard.press("c");
  await page.keyboard.press("Enter");
  const panel = page.locator(".compare-panel");
  await expect(panel).toBeFocused();

  // Walk down to the birth-place row, the one with a choice to make.
  const placeRow = panel.locator("tr.field").filter({ hasText: "Kranj, Slovenija" }).first();
  // One step per try, checked briefly: the row is a few steps down, and a
  // full-budget wait on every miss would turn the walk into a minute.
  await expect(async () => {
    await page.keyboard.press("ArrowDown");
    await expect(placeRow).toHaveClass(/kbd-active/, { timeout: 250 });
  }).toPass({ timeout: 15000 });

  await page.keyboard.press("2");
  await expect(placeRow.locator("button.choice.incoming")).toHaveClass(/active/);

  await page.keyboard.press("Escape");
  await expect(page.locator(".candidate-list")).toBeFocused();
  // Esc was the panel's alone: Merge is still on screen.
  await expect(page.locator(".candidate")).toHaveCount(2);
});

test("a row of tabs is one Tab stop and the arrows switch it", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(SAMPLE);
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  const tabs = page.locator(".tools-subtabs [role=tab]");
  await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
  await expect(tabs.first()).toHaveAttribute("tabindex", "0");
  await expect(tabs.nth(1)).toHaveAttribute("tabindex", "-1");

  await tabs.first().focus();
  await page.keyboard.press("ArrowRight");
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(tabs.nth(1)).toBeFocused();
  await page.keyboard.press("End");
  await expect(tabs.last()).toHaveAttribute("aria-selected", "true");
});

test("a chart's person is a button, and ⌥↑ walks to a parent", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(SAMPLE);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();
  await page.locator(".charts-open-btn").click();
  await page.locator("svg.tree-svg").waitFor();

  // The root is drawn; Tab reaches it, Enter selects it and the panel opens.
  const nodes = page.locator("svg.tree-svg g.tree-node");
  await expect(nodes.first()).toHaveAttribute("role", "button");
  const rootName = (await page.locator(".tree-title-name").textContent())!.trim();
  const root = nodes.filter({ hasText: rootName }).first();
  await root.focus();
  await page.keyboard.press("Enter");
  await expect(root).toHaveClass(/selected/);
  await expect(page.getByRole("button", { name: "Root", exact: true })).toBeVisible();

  // ⌥↑ moves the selection and the focus to the father.
  await page.keyboard.press("Alt+ArrowUp");
  await expect(root).not.toHaveClass(/selected/);
  const focused = page.locator("svg.tree-svg g.tree-node:focus");
  await expect(focused).toHaveCount(1);
  await expect(focused).toHaveClass(/selected/);
});
