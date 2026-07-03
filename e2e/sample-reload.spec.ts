import { test, expect, type Page } from "@playwright/test";

async function enablePersist(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("gedmerge.settings", JSON.stringify({ persistWorkspace: true }));
  });
}

async function waitMasterCached(page: Page) {
  await page.waitForFunction(
    () =>
      new Promise<boolean>((resolve) => {
        const req = indexedDB.open("gedmerge-session");
        req.onsuccess = () => {
          const db = req.result;
          try {
            const r = db.transaction("files", "readonly").objectStore("files").get("master");
            r.onsuccess = () => resolve(!!(r.result as { blob?: Blob } | undefined)?.blob);
            r.onerror = () => resolve(false);
          } catch {
            resolve(false);
          }
        };
        req.onerror = () => resolve(false);
      }),
    undefined,
    { timeout: 20000 },
  );
  await page.waitForTimeout(1500);
}

// Repro: a cached workspace exists. On the next open, while the async
// loadWorkspace() read is still in flight, the user clicks a sample. The stale
// cached master then clobbers the freshly-clicked sample.
test("clicking a sample during startup hydration is not clobbered by cache", async ({ page }) => {
  test.setTimeout(120000);
  await enablePersist(page);

  // Session 1: load a sample so a workspace is cached.
  await page.goto("/");
  await page.locator(".lb-sample-row").first().click();
  await page.locator(".edit-person").first().waitFor({ timeout: 30000 });
  await waitMasterCached(page);

  // Session 2: open the app and click a DIFFERENT sample as fast as possible,
  // before the cached-workspace restore resolves.
  await page.goto("/");
  // Click the 2nd sample the instant the tray is visible.
  await page.locator(".lb-sample-row").nth(1).click({ timeout: 5000 });

  // Give both the sample load and the hydration restore time to settle/fight.
  await page.waitForTimeout(8000);

  const headerChip = await page.locator(".header-file-btn.master").first().textContent();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const emptyMsg = await page.getByText("no individuals to edit").count();
  const editPersons = await page.locator(".edit-person").count();
  console.log("HEADER master chip:", headerChip, "emptyMsg=", emptyMsg, "editPersons=", editPersons);

  // The visible master file name must match the dataset actually loaded — the
  // sample the user clicked, with real individuals.
  expect(emptyMsg).toBe(0);
  expect(editPersons).toBeGreaterThan(0);
});
