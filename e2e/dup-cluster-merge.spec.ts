import { test, expect, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "fs";
import os from "os";
import path from "path";

// "Merge all" on a duplicate cluster: one person entered three times, each copy
// married to her own copy of the same husband. The whole group has to collapse
// into one record — husbands too, when their group is ticked — as a single
// undoable step.

/** Three copies of a couple, so the cluster carries a relative group. */
function writeClusterFixture(): string {
  const lines = ["0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8"];
  for (const n of [1, 2, 3]) {
    lines.push(
      `0 @W${n}@ INDI`, "1 NAME Frančiška /Stopar/", "1 SEX F",
      "1 BIRT", "2 DATE 22 FEB 1888", "2 PLAC Poljane, Gorenjska, Slovenija",
      `1 FAMS @FT${n}@`,
    );
    lines.push(
      `0 @H${n}@ INDI`, "1 NAME Franc /Stopar/", "1 SEX M",
      "1 BIRT", "2 DATE 8 AUG 1886", "2 PLAC Poljane, Gorenjska, Slovenija",
      `1 FAMS @FT${n}@`,
    );
    lines.push(`0 @FT${n}@ FAM`, `1 HUSB @H${n}@`, `1 WIFE @W${n}@`);
  }
  lines.push("0 TRLR", "");
  const file = path.join(os.tmpdir(), `dup-cluster-${Date.now()}.ged`);
  writeFileSync(file, lines.join("\n"), "utf-8");
  return file;
}

/** Save the file and return what was written. */
async function saveAndRead(page: Page): Promise<string> {
  await page.locator(".app-head-actions .export-btn").click();
  const download = page.waitForEvent("download", (d) => d.suggestedFilename().endsWith(".ged"));
  await page.locator(".preview-actions .export-btn").click();
  const file = await (await download).path();
  return readFileSync(file!, "utf-8");
}

/** The file's top-level records, without the leading "0 ". */
function records(ged: string): string[] {
  return ged.split(/\n0 /).map((r) => (r.startsWith("0 ") ? r.slice(2) : r));
}

/** How many `INDI` records carry the given name. */
function countNamed(ged: string, name: string): number {
  return records(ged).filter((r) => r.includes(" INDI") && r.includes(`1 NAME ${name} /Stopar/`)).length;
}

/** How many `FAM` records there are — matched on the record line, since every
 *  individual's `FAMS`/`FAMC` line contains "FAM" too. */
function countFamilies(ged: string): number {
  return records(ged).filter((r) => /^@[^@]+@ FAM\b/.test(r)).length;
}

/** Open Tools → Find duplicates and click Merge all on the cluster. */
async function openMergeAll(page: Page, file: string) {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(file);
  await page.locator(".edit-person").first().waitFor({ timeout: 60000 });

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Find duplicates").click();
  // The husbands are a cluster of their own — take the wives' one.
  const head = page.locator(".tools-dup-cluster-head", { hasText: "Frančiška" });
  await expect(head).toHaveCount(1, { timeout: 120000 });
  await expect(head).toContainText("3 records");

  await head.getByRole("button", { name: "Merge all" }).click();
  await expect(page.locator(".cluster-dialog")).toBeVisible();
}

test("merge all collapses the cluster and the ticked relatives into one record each", async ({ page }) => {
  const file = writeClusterFixture();
  await openMergeAll(page, file);

  // The survivor is pre-picked, and the husbands are offered as one group of
  // three — untouched unless the user ticks it.
  const dialog = page.locator(".cluster-dialog");
  await expect(dialog.locator('input[type="radio"]:checked')).toHaveCount(1);
  const group = dialog.locator("li", { hasText: "Franc" }).first();
  await expect(group).toContainText("3 records");
  await group.locator('input[type="checkbox"]').check();

  await dialog.getByRole("button", { name: /Merge and remove/ }).click();
  // The blob is gone from the list — nothing left to pair off.
  await expect(page.locator(".tools-dup-cluster-head")).toHaveCount(0);

  const ged = await saveAndRead(page);
  expect(countNamed(ged, "Frančiška")).toBe(1);
  expect(countNamed(ged, "Franc")).toBe(1);
  // One marriage left, not three.
  expect(countFamilies(ged)).toBe(1);
});

test("one undo puts the whole cluster back", async ({ page }) => {
  const file = writeClusterFixture();
  await openMergeAll(page, file);

  const dialog = page.locator(".cluster-dialog");
  await dialog.locator("li", { hasText: "Franc" }).first().locator('input[type="checkbox"]').check();
  await dialog.getByRole("button", { name: /Merge and remove/ }).click();
  await expect(page.locator(".tools-dup-cluster-head")).toHaveCount(0);

  // The whole-file search sees the live dataset: one of each is left.
  const search = async (name: string) => {
    await page.getByRole("button", { name: "Search everyone" }).click();
    const modal = page.locator(".global-search-modal");
    await modal.locator(".global-search-input").fill(name);
    const rows = modal.locator(".global-search-row");
    await expect(rows.first()).toBeVisible();
    const count = await rows.count();
    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);
    return count;
  };
  expect(await search("Frančiška Stopar")).toBe(1);

  // Four merges ran (two wives, two husbands) as one entry, so a single undo
  // answers for all of them — and leaves nothing further to undo.
  await page.keyboard.press("Control+z");
  await expect(page.getByRole("button", { name: "Undo" })).toBeDisabled();

  expect(await search("Frančiška Stopar")).toBe(3);
  expect(await search("Franc Stopar")).toBe(6); // three of each, all matching both words
});
