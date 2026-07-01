import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "fs";
import os from "os";
import path from "path";

// IndexedDB workspace persistence: a reload should restore the loaded files,
// the pending merge session, and unsaved edits (with undo history) — instead of
// dropping back to the landing page. Each Playwright test gets a fresh browser
// context, so IndexedDB + localStorage start empty and are isolated per test.

// Unique per worker process: parallel workers each evaluate this module, and
// sharing fixed temp paths lets one worker's write truncate a file another is
// reading (a NotReadableError, and flaky loads). pid is unique per worker.
const uid = `${process.pid}`;
const MASTER = path.join(os.tmpdir(), `persist-master-${uid}.ged`);
const COMPARE = path.join(os.tmpdir(), `persist-compare-${uid}.ged`);
// A small single-person master for the edit/clear tests — a real sample file is
// megabytes, and re-serializing it on the persist debounce + re-parsing it on
// reload makes restore timing-sensitive; a tiny file keeps the tests fast and
// deterministic. (The merge test uses MASTER/COMPARE above.)
const EDIT_MASTER = path.join(os.tmpdir(), `persist-edit-master-${uid}.ged`);
writeFileSync(EDIT_MASTER, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Janez /Novak/", "1 SEX M", "1 BIRT", "2 DATE 1 JAN 1900",
  "0 TRLR", "",
].join("\n"), "utf-8");

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

// The persistence writer is debounced and its writes span two IndexedDB stores,
// so a fixed delay is unreliable. Wait for the exact artifacts a reload restore
// depends on to be durably readable: for edits, the master blob must actually
// contain the edited text; for merges, the session must hold decisions and the
// compare file must be cached. Polling those directly avoids the race where the
// session record appears before the (separately written) master blob is visible.
async function waitForCache(
  page: Page,
  opts: { masterContains?: string; decisions?: boolean; compare?: boolean },
) {
  await page.waitForFunction(
    (opts) =>
      new Promise<boolean>((resolve) => {
        const req = indexedDB.open("gedmerge-session");
        req.onsuccess = () => {
          const db = req.result;
          const get = (store: string, key: string) =>
            new Promise<unknown>((res) => {
              try {
                const r = db.transaction(store, "readonly").objectStore(store).get(key);
                r.onsuccess = () => res(r.result);
                r.onerror = () => res(undefined);
              } catch {
                res(undefined); // stores not created yet
              }
            });
          void (async () => {
            const session = (await get("session", "current")) as { decisions?: unknown[] } | undefined;
            const master = (await get("files", "master")) as { blob?: Blob } | undefined;
            const compare = await get("files", "compare");
            if (opts.decisions && !(session && Array.isArray(session.decisions) && session.decisions.length > 0)) return resolve(false);
            if (opts.compare && !compare) return resolve(false);
            if (opts.masterContains) {
              if (!master?.blob) return resolve(false);
              const text = await master.blob.text();
              if (!text.includes(opts.masterContains)) return resolve(false);
            }
            resolve(true);
          })();
        };
        req.onerror = () => resolve(false);
      }),
    opts,
    { timeout: 15000 },
  );
  // Chromium defers flushing IndexedDB to disk briefly; a reload within ~1s of
  // the write can lose it (a real user never reloads that fast, and the
  // unsaved-changes prompt guards them). Give the flush a margin before reload.
  await page.waitForTimeout(1500);
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

  await waitForCache(page, { masterContains: "Kukic", decisions: true, compare: true });
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
  await page.locator("input.file-input").first().setInputFiles(EDIT_MASTER);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  // No pending changes yet → no Save button.
  await expect(saveBtn(page)).toHaveCount(0);

  const given = page.locator(".edit-name-input").first();
  const original = await given.inputValue();
  await given.fill(`${original} TEST`);
  await page.locator(".edit-name-input").nth(1).click(); // blur to commit
  await expect(saveBtn(page)).toBeVisible();

  await waitForCache(page, { masterContains: `${original} TEST` });
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
  await page.locator("input.file-input").first().setInputFiles(EDIT_MASTER);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  const given = page.locator(".edit-name-input").first();
  const original = await given.inputValue();
  await given.fill(`${original} TEST`);
  await page.locator(".edit-name-input").nth(1).click(); // blur to commit

  await waitForCache(page, { masterContains: `${original} TEST` });
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
  await page.locator("input.file-input").first().setInputFiles(EDIT_MASTER);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();
  await waitForCache(page, { masterContains: "Janez" }); // ensure the workspace is cached

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
  await page.locator("input.file-input").first().setInputFiles(EDIT_MASTER);
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
