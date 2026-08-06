import { test, expect } from "@playwright/test";

// The landing page exists to open a file, so its drop zone holds focus from the
// start — Enter and Space open the picker without tabbing to it first.
test("the landing drop zone opens focused", async ({ page }) => {
  await page.goto("/");
  const drop = page.locator(".lb-drop");
  await expect(drop).toBeFocused();
  // Focusing must not scroll the hero out of view on a small screen.
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});
