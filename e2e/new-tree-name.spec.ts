import { test, expect } from "@playwright/test";

// A tree started from nothing is created as `new-tree.ged`, because the browser
// cannot see the account name its user is logged in under. It names itself from
// the first person added — in the download and on the open file.
test("a new tree names itself after its first person", async ({ page }) => {
  await page.goto("/");
  await page.locator(".lb-sample-row").first().click(); // "Start a new tree"

  // Nobody in the file yet: there is no start person to pick, and the one thing
  // to do holds the focus.
  await expect(page.locator(".start-selector")).toHaveCount(0);
  await expect(page.locator(".edit-empty-add")).toBeFocused();

  await page.keyboard.press("Enter"); // adds the first person
  // The new person opens on the given-name field; Tab moves to the surname.
  await page.keyboard.type("Janez");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Novak");
  await page.keyboard.press("Tab");

  // The first person becomes the start person without being asked for.
  await expect(page.locator(".start-selector")).toHaveCount(1);
  // The chosen person shows as the field's placeholder, not its value.
  await expect(page.locator(".start-selector input")).toHaveAttribute("placeholder", /Janez Novak/);

  await page.keyboard.press("ControlOrMeta+s");
  const files = page.locator(".preview-files code");
  await expect(files.first()).toHaveText(/^Novak\.\d{4}-\d{2}-\d{2}\.gedmerge\.ged$/);
  // The change report is opt-in; ticking it names it after the same person.
  await page.locator(".preview-report-toggle input").check();
  await expect(files.nth(1)).toHaveText(/^Novak\..*\.report\.txt$/);

  // Confirming carries the name onto the open file — undated, so a second save
  // renames nothing.
  await page.getByRole("button", { name: /Download GEDCOM/ }).click();
  await expect(page.locator(".header-file-btn").first()).toContainText("Novak.ged");
});
