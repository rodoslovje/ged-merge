import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

// IndexedDB workspace persistence: a reload should restore the loaded files,
// the pending merge session, and unsaved edits (with undo history) — instead of
// dropping back to the landing page. Each Playwright test gets a fresh browser
// context, so IndexedDB + localStorage start empty and are isolated per test.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(__dirname, "../test-data/Senen.ged");

const MASTER = path.join(os.tmpdir(), "persist-master.ged");
const COMPARE = path.join(os.tmpdir(), "persist-compare.ged");

// One individual that matches across both files, so loading them yields exactly
// one merge candidate to confirm.
writeFileSync(MASTER, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Ana /Kukic/", "1 SEX F",
  "1 BIRT", "2 DATE 9 AUG 1982", "2 PLAC Kranj",
  "0 TRLR", "",
].join("\n"), "utf-8");

writeFileSync(COMPARE, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Ana /Kukic/", "1 SEX F",
  "1 BIRT", "2 DATE 9 AUG 1982", "2 PLAC Kranj",
  "1 BAPM", "2 DATE 6 OCT 1982", "2 PLAC Strazisce,Kranj,Slovenia",
  "0 TRLR", "",
].join("\n"), "utf-8");

const saveBtn = (page: Page) => page.locator(".app-head-actions .export-btn");

// The persistence writer is debounced (800 ms); wait past it before reloading.
async function waitForPersist(page: Page) {
  await page.waitForTimeout(1200);
}

test("reload restores a confirmed merge decision", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(MASTER);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });

  await page.getByRole("button", { name: "Merge", exact: true }).click();
  await page.locator("input.file-input").last().setInputFiles(COMPARE);
  await page.locator(".candidate").first().waitFor({ timeout: 30000 });

  // Confirm the single candidate (first button in the decision bar = "confirm").
  await page.locator(".candidate-main").first().click();
  await page.locator(".decision-bar button").first().click();
  await expect(saveBtn(page)).toBeVisible();

  await waitForPersist(page);
  await page.reload();

  // Merge mode is restored from localStorage; the files + match recompute, and
  // the confirmed decision comes back — so the Save button reappears.
  await page.locator(".candidate").first().waitFor({ timeout: 30000 });
  await expect(saveBtn(page)).toBeVisible();

  // Re-selecting the candidate shows its decision is still "confirmed".
  await page.locator(".candidate-main").first().click();
  await expect(page.locator(".decision-bar .decision.confirmed.active").first()).toBeVisible();
});

test("reload restores unsaved edits", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(SAMPLE);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  // No pending changes yet → no Save button.
  await expect(saveBtn(page)).toHaveCount(0);

  const given = page.locator(".edit-name-input").first();
  const original = await given.inputValue();
  await given.fill(`${original} TEST`);
  await page.locator(".edit-name-input").nth(1).click(); // blur to commit
  await expect(saveBtn(page)).toBeVisible();

  await waitForPersist(page);
  await page.reload();

  // Edit mode + the same (start) person are restored, with the edit intact and
  // still marked as a pending change.
  await page.locator(".edit-person").waitFor();
  await expect(page.locator(".edit-name-input").first()).toHaveValue(`${original} TEST`);
  await expect(saveBtn(page)).toBeVisible();
});

test("reload restores undo history, so an edit can be undone after reloading", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(SAMPLE);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  const given = page.locator(".edit-name-input").first();
  const original = await given.inputValue();
  await given.fill(`${original} TEST`);
  await page.locator(".edit-name-input").nth(1).click(); // blur to commit

  await waitForPersist(page);
  await page.reload();

  await page.locator(".edit-person").waitFor();
  await expect(page.locator(".edit-name-input").first()).toHaveValue(`${original} TEST`);

  // Undo history survived the reload — undoing reverts the edit.
  const undo = page.getByRole("button", { name: "Undo" });
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(page.locator(".edit-name-input").first()).toHaveValue(original);
});

test("clearing cached data drops the workspace, so a reload returns to the landing page", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(SAMPLE);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();
  await waitForPersist(page); // let the workspace get cached

  // Settings → Clear cached data → confirm.
  await page.getByRole("button", { name: "Settings" }).first().click();
  await page.getByRole("button", { name: "Clear cached data" }).click();
  await page.locator(".confirm-dialog-confirm").click();

  await page.reload();

  // Nothing cached → landing page, no loaded person.
  await expect(page.locator(".landing-b")).toBeVisible();
  await expect(page.locator(".edit-person")).toHaveCount(0);
});
