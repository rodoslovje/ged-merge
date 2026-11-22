import { test, expect } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAMILY = path.resolve(__dirname, "../src/__fixtures__/calendar-family.ged");

// The Charts hub's Calendar: a wizard from the settings through the cover and
// the twelve months to a review of every page, seen from the hub's root.
test("the family calendar walks from settings to a review of every page", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FAMILY);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();
  await page.locator(".charts-open-btn").click();
  await page.getByRole("tab", { name: "Calendar" }).click();

  // Settings, with a month previewed beside them.
  await expect(page.locator(".cal-step-label")).toHaveText("Settings");
  await expect(page.locator(".cal-preview .cal-grid")).toHaveCount(1);

  // The cover draws the recipient's fan by default.
  const next = page.getByRole("button", { name: "Next", exact: true });
  await next.click();
  await expect(page.locator(".cal-preview .cal-fan svg")).toHaveCount(1);

  // March: the recipient's own birthday, and her mother's as a relative's line.
  for (let i = 0; i < 3; i++) await next.click();
  await expect(page.locator(".cal-step-label")).toHaveText(/^March/);
  await expect(page.locator(".cal-preview .cal-list")).toContainText("Marija Kos, mother (65)");

  // June offers the grandfather's birth, wedding and death; the centenary of
  // his death is picked, and the wedding can be added beside it.
  for (let i = 0; i < 3; i++) await next.click();
  await expect(page.locator(".cal-fact-list input")).toHaveCount(3);
  await expect(page.locator(".cal-preview .cal-fact")).toHaveCount(1);
  await expect(page.locator(".cal-preview .cal-fact")).toContainText("100 years ago");
  await page.getByRole("checkbox", { name: /were married/ }).check();
  await expect(page.locator(".cal-preview .cal-fact")).toHaveCount(2);

  // Review: the cover and twelve months, one page each in the default format.
  await page.getByRole("button", { name: "Skip to review and print" }).click();
  await expect(page.locator(".cal-review .cal-page")).toHaveCount(13);
  await expect(page.getByRole("button", { name: /Print/ })).toBeVisible();
});
