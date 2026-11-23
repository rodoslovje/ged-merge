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
  await expect(page.locator(".cal-preview .cal-chart svg")).toHaveCount(1);
  await page.getByLabel("Dedication").fill("For Ana, with love");
  await expect(page.locator(".cal-preview .cal-dedication")).toHaveText("For Ana, with love");

  // March: the recipient's own birthday, and her mother's as a relative's line.
  for (let i = 0; i < 3; i++) await next.click();
  await expect(page.locator(".cal-step-label")).toHaveText(/^March/);
  await expect(page.locator(".cal-preview .cal-list")).toContainText("Marija K., mother (65)"); // the living by the default "Given name and surname initial"
  // Every week is as tall as the others, however busy its days.
  const heights = await page.locator(".cal-preview .cal-grid tbody tr").evaluateAll((rows) => rows.map((r) => r.getBoundingClientRect().height));
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);

  // June offers the grandfather's birth, wedding and death; the centenary of
  // his death is picked, and the wedding can be added beside it.
  for (let i = 0; i < 3; i++) await next.click();
  await expect(page.locator(".cal-fact-list input")).toHaveCount(3);
  await expect(page.locator(".cal-preview .cal-fact")).toHaveCount(1);
  await expect(page.locator(".cal-preview .cal-fact")).toContainText("100 years ago");
  await page.getByRole("checkbox", { name: /were married/ }).check();
  await expect(page.locator(".cal-preview .cal-fact")).toHaveCount(2);

  // Review: the cover, twelve months and the back page — the year at a glance
  // with its signature — one page each in the default format.
  await page.getByRole("button", { name: "Skip to review and print" }).click();
  await expect(page.locator(".cal-review .cal-page")).toHaveCount(14);
  // Printing spins on the button while the document is built, and stops.
  const print = page.getByRole("button", { name: /Print/ });
  await print.click();
  await expect(print).toBeEnabled();
  await expect(print.locator(".spinner")).toHaveCount(0);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.locator(".cal-step-label")).toHaveText("Back page");
  await expect(page.locator(".cal-preview .cal-overview")).toContainText("Marija");
  await page.getByLabel("Signature").fill("From all of us");
  await expect(page.locator(".cal-preview .cal-signature")).toHaveText("From all of us");
  // A chart on the back page is titled by its name.
  const backKind = page.locator(".cal-field", { hasText: "What the back page shows" }).locator(".select-menu");
  await backKind.click();
  await page.locator('.dd-menu .dd-item[data-value="fanDesc"]').click();
  await expect(page.locator(".cal-preview .cal-back-title")).toHaveText("Fan of descendants");
  // No back page: the review has the cover and the months alone.
  await backKind.click();
  await page.locator('.dd-menu .dd-item[data-value="none"]').click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.locator(".cal-review .cal-page")).toHaveCount(13);
});

// With the workspace kept in the browser, the calendar's work comes back after
// leaving the kind; without it, the wizard says how to keep it.
test("the calendar's work is kept while the workspace is", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("gedmerge.settings", JSON.stringify({ persistWorkspace: true })));
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FAMILY);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();
  await page.locator(".charts-open-btn").click();
  await page.getByRole("tab", { name: "Calendar" }).click();
  await expect(page.locator(".cal-panel")).not.toContainText("Remember my work");
  await page.getByRole("radio", { name: /Sea/ }).click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByLabel("Dedication").fill("For Ana");

  await page.getByRole("tab", { name: "Tree" }).click();
  await page.getByRole("tab", { name: "Calendar" }).click();
  await expect(page.getByRole("radio", { name: /Sea/ })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByLabel("Dedication")).toHaveValue("For Ana");
});

test("without a kept workspace the wizard says how to keep the work", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FAMILY);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();
  await page.locator(".charts-open-btn").click();
  await page.getByRole("tab", { name: "Calendar" }).click();
  await expect(page.locator(".cal-panel")).toContainText("Remember my work in this browser");
});
