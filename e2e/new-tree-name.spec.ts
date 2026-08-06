import { test, expect } from "@playwright/test";

// A tree started from nothing is created as `new-tree.ged`, because the browser
// cannot see the account name its user is logged in under. The download takes
// the surname of the person in it instead.
test("a new tree downloads under its first person's surname", async ({ page }) => {
  await page.goto("/");
  await page.locator(".lb-sample-row").first().click(); // "Start a new tree"
  await page.locator(".edit-empty-add").click();

  // The new person opens on the given-name field; Tab moves to the surname.
  await page.keyboard.type("Janez");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Novak");
  await page.keyboard.press("Tab");

  await page.keyboard.press("ControlOrMeta+s");
  const files = page.locator(".preview-files code");
  await expect(files.first()).toHaveText(/^Novak\.\d{4}-\d{2}-\d{2}\.gedmerge\.ged$/);
  await expect(files.nth(1)).toHaveText(/^Novak\..*\.report\.txt$/);
});
