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

// The persistence writer is debounced, and under parallel load the debounce
// callback can be starved past any fixed delay — so wait for the actual write
// by polling the IndexedDB session record, rather than a timeout. `need` narrows
// what must be present: the merge decisions, the edit-state, or just anything.
async function waitForCache(page: Page, need: "any" | "decisions" | "editState" = "any") {
  await page.waitForFunction(
    (need) =>
      new Promise<boolean>((resolve) => {
        const req = indexedDB.open("gedmerge-session");
        req.onsuccess = () => {
          try {
            const store = req.result.transaction("session", "readonly").objectStore("session");
            const r = store.get("current");
            r.onsuccess = () => {
              const s = r.result as { decisions?: unknown[]; editState?: unknown } | undefined;
              if (!s) return resolve(false);
              if (need === "decisions") return resolve(Array.isArray(s.decisions) && s.decisions.length > 0);
              if (need === "editState") return resolve(!!s.editState);
              resolve(true);
            };
            r.onerror = () => resolve(false);
          } catch {
            resolve(false); // stores not created yet
          }
        };
        req.onerror = () => resolve(false);
      }),
    need,
    { timeout: 10000 },
  );
}

// Workspace caching is opt-in (off by default). Seed the settings blob before
// the app boots so it starts enabled — this also runs on reload. Seeding avoids
// the persistent-storage prompt path (only the in-app toggle requests it).
async function enablePersist(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("gedmerge.settings", JSON.stringify({ persistWorkspace: true }));
  });
}

test("reload restores a confirmed merge decision", async ({ page }) => {
  await enablePersist(page);
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

  await waitForCache(page, "decisions");
  await page.reload();

  // Merge mode is restored from localStorage; the files + match recompute, and
  // the confirmed decision comes back — so the Save button reappears.
  await page.locator(".candidate").first().waitFor({ timeout: 30000 });
  await expect(saveBtn(page)).toBeVisible({ timeout: 15000 });

  // Re-selecting the candidate shows its decision is still "confirmed".
  await page.locator(".candidate-main").first().click();
  await expect(page.locator(".decision-bar .decision.confirmed.active").first()).toBeVisible();
});

test("reload restores unsaved edits", async ({ page }) => {
  await enablePersist(page);
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

  await waitForCache(page, "editState");
  await page.reload();

  // Edit mode + the same (start) person are restored, with the edit intact and
  // still marked as a pending change.
  await page.locator(".edit-person").waitFor();
  await expect(page.locator(".edit-name-input").first()).toHaveValue(`${original} TEST`, { timeout: 15000 });
  await expect(saveBtn(page)).toBeVisible();
});

test("reload restores undo history, so an edit can be undone after reloading", async ({ page }) => {
  await enablePersist(page);
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(SAMPLE);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  const given = page.locator(".edit-name-input").first();
  const original = await given.inputValue();
  await given.fill(`${original} TEST`);
  await page.locator(".edit-name-input").nth(1).click(); // blur to commit

  await waitForCache(page, "editState");
  await page.reload();

  await page.locator(".edit-person").waitFor();
  await expect(page.locator(".edit-name-input").first()).toHaveValue(`${original} TEST`, { timeout: 15000 });

  // Undo history survived the reload — undoing reverts the edit.
  const undo = page.getByRole("button", { name: "Undo" });
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(page.locator(".edit-name-input").first()).toHaveValue(original);
});

test("clearing cached data drops the workspace, so a reload returns to the landing page", async ({ page }) => {
  await enablePersist(page);
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(SAMPLE);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();
  await waitForCache(page, "any"); // let the workspace get cached

  // Settings → Advanced tab → Clear cached data → confirm.
  await page.getByRole("button", { name: "Settings" }).first().click();
  await page.getByRole("tab", { name: "Advanced" }).click();
  await page.getByRole("button", { name: "Clear cached data" }).click();
  await page.locator(".confirm-dialog-confirm").click();

  await page.reload();

  // Nothing cached → landing page, no loaded person.
  await expect(page.locator(".landing-b")).toBeVisible();
  await expect(page.locator(".edit-person")).toHaveCount(0);
});

test("with caching disabled (default), a reload does not restore the workspace", async ({ page }) => {
  // No enablePersist — default off. Load a file, edit it, reload.
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(SAMPLE);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  const given = page.locator(".edit-name-input").first();
  await given.fill(`${await given.inputValue()} TEST`);
  await page.locator(".edit-name-input").nth(1).click();
  // Give the debounce more than enough time; with caching off nothing is written.
  await page.waitForTimeout(1500);

  await page.reload();

  // Nothing was cached → back to the landing page.
  await expect(page.locator(".landing-b")).toBeVisible();
  await expect(page.locator(".edit-person")).toHaveCount(0);
});
