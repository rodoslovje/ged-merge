import { test, expect, type Page } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

/**
 * The narrow layouts, at the CSS breakpoints themselves (index.css: 880 and
 * 560 max-width). At each width the main screens must fit the viewport — no
 * sideways page scroll — and what the header gives up must still be reachable
 * through the ☰ menu: the files from 880 px down, everything but the mode tabs
 * on a phone, and the chart's own controls behind the chart's ☰.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(__dirname, "../src/__fixtures__/corpus/reunion-5.5.1-utf8.ged");
// The file merged into itself: every person is a candidate, so the review has rows.
const COMPARE = SAMPLE;

/** Retried, so a layout still settling after a click cannot pass or fail it. */
async function expectNoSidewaysScroll(page: Page, where: string) {
  await expect
    .poll(
      () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
      { message: `the page scrolls sideways on ${where}` },
    )
    .toBeLessThanOrEqual(0);
}

for (const width of [880, 560]) {
  const phone = width <= 720; // usePhone's PHONE_QUERY

  test(`the main screens fit a ${width} px window and the ☰ reaches what the header gives up`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expectNoSidewaysScroll(page, "the landing page");

    await page.locator("input.file-input").first().setInputFiles(SAMPLE);
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.locator(".edit-person").first().waitFor();
    await expectNoSidewaysScroll(page, "Edit");

    // The mode tabs stay in the header at every width.
    for (const mode of ["Edit", "Merge", "Tools"]) {
      await expect(page.getByRole("button", { name: mode, exact: true })).toBeVisible();
    }

    // The header's ☰: the loaded file (below 880 px), Settings and Charts.
    const menuBtn = page.locator(".app-menu-btn");
    await expect(menuBtn).toBeVisible();
    await menuBtn.click();
    const menu = page.getByRole("menu", { name: "Menu" });
    await expect(menu).toBeVisible();
    await expect(menu.locator(".app-menu-file")).toHaveCount(1);
    await expect(menu.getByRole("menuitem", { name: "Settings" })).toBeVisible();
    if (phone) {
      await expect(menu.getByRole("menuitem", { name: "Search everyone" })).toBeVisible();
      await menu.getByRole("menuitem", { name: "Charts" }).click();
    } else {
      // A narrow desktop keeps Charts in the row.
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      await page.locator(".charts-open-btn").click();
    }

    // A chart.
    await page.locator("svg.tree-svg").waitFor();
    await expectNoSidewaysScroll(page, "the chart");
    if (phone) {
      // On a phone the toolbar is one row; the chart kinds and controls fold
      // into the chart's ☰.
      const chartMenu = page.getByRole("button", { name: "Chart options" });
      await expect(chartMenu).toBeVisible();
      await chartMenu.click();
      await expect(page.locator(".chart-menu-panel")).toBeVisible();
      await expect(page.locator(".chart-menu-panel .charts-kind-picker")).toBeVisible();
      await chartMenu.click();
      await expect(page.locator(".chart-menu-panel")).toHaveCount(0);
    } else {
      await expect(page.getByRole("tablist", { name: "Chart kind" })).toBeVisible();
    }
    await page.locator(".tree-toolbar .tree-back-btn").click();
    await page.locator(".edit-person").first().waitFor();

    // Tools, and a whole-file tool's result.
    await page.getByRole("button", { name: "Tools", exact: true }).first().click();
    if (phone) {
      // A phone lists the tools in a dropdown that names the current one.
      await page.locator(".tools-subtabs-picker .picker-menu-btn").click();
      await page.getByRole("menuitemradio", { name: "Health check" }).click();
    } else {
      await page.getByText("Health check", { exact: true }).first().click();
    }
    await expect(page.locator(".tools-issues, .tools-clean").first()).toBeVisible();
    await expectNoSidewaysScroll(page, "Tools");

    // Merge, with an incoming file and its candidates.
    await page.getByRole("button", { name: "Merge", exact: true }).click();
    await page.locator("input.file-input").last().setInputFiles(COMPARE);
    await page.locator(".candidate").first().waitFor();
    await expectNoSidewaysScroll(page, "Merge");
    await page.locator(".candidate-main").first().click();
    await expect(page.locator(".decision-bar").first()).toBeVisible();
    await expectNoSidewaysScroll(page, "the merge review");

    // Both files now show in the ☰.
    await menuBtn.click();
    await expect(menu.locator(".app-menu-file")).toHaveCount(2);
  });
}
