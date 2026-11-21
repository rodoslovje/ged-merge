import { test, expect, type Page } from "@playwright/test";
import { appendFileSync, copyFileSync, readdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PWA_DIST } from "../../playwright.pwa.config";

/**
 * The installed app, against the production build (playwright.pwa.config.ts):
 * once the service worker has precached the shell it must start, and load a
 * file, with no network at all; and a new deploy must be *offered* — the
 * "new version" toast — never applied behind the user's back, because an
 * unsaved Edit session would not survive a surprise reload.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const SAMPLE = path.join(ROOT, "src/__fixtures__/corpus/reunion-5.5.1-utf8.ged");
const SERVED_SW = path.join(PWA_DIST, "sw.js");

// The update spec rewrites the served service worker; every test starts from
// the build's own.
test.beforeEach(() => {
  copyFileSync(path.join(ROOT, "dist/sw.js"), SERVED_SW);
});

/** First visit installs the worker; it controls the page from the next load. */
async function openControlled(page: Page) {
  await page.goto("/");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
}

test("the installed app starts and loads a file with no network", async ({ page, context }) => {
  await openControlled(page);

  await context.setOffline(true);
  await page.reload();
  await expect(page.locator(".landing-b")).toBeVisible();

  // The parse runs in the worker chunk, which must have been precached too.
  await page.locator("input.file-input").first().setInputFiles(SAMPLE);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator(".edit-person").first()).toBeVisible();

  // The standalone guide is precached as its own page, not the app shell.
  await page.goto("guide/");
  await expect(page.locator("h1").first()).toBeVisible();
  await expect(page.locator(".landing-b")).toHaveCount(0);
});

test("what is fetched only on use is there with no network too", async ({ page, context }) => {
  // The sample trees, the landing page's pictures, and face detection's wasm
  // and model: none is asked for as the app starts, so only the precache can
  // have brought them.
  const dist = path.join(ROOT, "dist");
  const urls = (readdirSync(dist, { recursive: true }) as string[])
    .map((f) => f.split(path.sep).join("/"))
    .filter((f) => /\.(jpg|ged|wasm|tflite)$/.test(f));
  for (const ext of ["jpg", "ged", "wasm", "tflite"]) {
    expect(urls.filter((u) => u.endsWith(`.${ext}`)).length, ext).toBeGreaterThan(0);
  }

  await openControlled(page);
  await context.setOffline(true);
  const missing = await page.evaluate(async (list) => {
    const out: string[] = [];
    for (const url of list) {
      const ok = await fetch(url).then(
        (r) => r.ok,
        () => false,
      );
      if (!ok) out.push(url);
    }
    return out;
  }, urls);
  expect(missing).toEqual([]);
});

test("a new deploy is offered as a toast, and Reload switches to it", async ({ page }) => {
  await openControlled(page);
  await expect(page.locator(".pwa-toast")).toHaveCount(0);

  // A new deploy: the served service worker changes by a byte, and the page
  // checks for it (the browser also does this on its own schedule).
  appendFileSync(SERVED_SW, `\n// next deploy ${Date.now()}\n`);
  await page.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration())?.update();
  });

  const toast = page.locator(".pwa-toast");
  await expect(toast).toContainText("A new version is available.");
  // Waiting, not active: nothing has been swapped under the open page yet.
  await expect
    .poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting))
    .toBe(true);

  const reloaded = page.waitForEvent("load");
  await toast.getByRole("button", { name: "Reload", exact: true }).click();
  await reloaded;
  await expect(page.locator(".landing-b")).toBeVisible();
  await expect(toast).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting))
    .toBe(false);
});
