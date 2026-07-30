import { test, expect } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

// ⌘/Ctrl+F must reach the search box of whatever view is on screen — and stay
// out of the way (so the browser's own find runs) where there is none.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(__dirname, "../src/__fixtures__/corpus/reunion-5.5.1-utf8.ged");

/** Does anything in the page claim ⌘/Ctrl+F? Dispatched synthetically: a real
 *  chord in a view that doesn't claim it opens the browser's own find bar,
 *  which the test can neither see nor dismiss. */
async function findChordPrevented(page: import("@playwright/test").Page): Promise<boolean> {
  return page.evaluate(() => {
    const e = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  });
}

test("Ctrl+F focuses the search box of the current view", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(SAMPLE);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });

  // Edit mode has no find box of its own: the chord is left to the browser.
  expect(await findChordPrevented(page)).toBe(false);

  // Tools: the visible panel's filter box takes it.
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.locator(".tools-tab", { hasText: "Places" }).first().click();
  await page.locator(".tools-search-input").first().waitFor({ timeout: 30000 });
  await page.keyboard.press("ControlOrMeta+f");
  await expect(page.locator(".tools-search-input").first()).toBeFocused();

  // A chart opened over a view takes the chord from the view behind it.
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".charts-open-btn").first().click();
  await page.locator(".chart-find input").first().waitFor({ timeout: 15000 });
  await page.keyboard.press("ControlOrMeta+f");
  await expect(page.locator(".chart-find input").first()).toBeFocused();
});

test("Ctrl+F reveals and focuses the match-list filter in Merge mode", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(SAMPLE);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });

  await page.getByRole("button", { name: "Merge", exact: true }).click();
  await page.locator("input.file-input").last().setInputFiles(SAMPLE);
  await page.locator(".candidate").first().waitFor({ timeout: 30000 });

  await page.keyboard.press("ControlOrMeta+f");
  await expect(page.locator("input.name-search")).toBeFocused();
});
