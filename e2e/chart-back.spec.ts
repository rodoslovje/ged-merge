import { test, expect, type Page } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(__dirname, "../src/__fixtures__/corpus/reunion-5.5.1-utf8.ged");

async function openChartsFromEdit(page: Page) {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(SAMPLE);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();
  await page.locator(".charts-open-btn").click();
  await page.locator("svg.tree-svg").waitFor();
}

// Re-rooting a chart walks a trail of people inside the hub's one history
// entry: ‹ › and the ▾ list (and , / .) retrace it, while Back leaves the
// chart in one press for the page it was opened from — however many people
// the reader wandered through. Back used to step through every re-root
// first, so returning to Edit took one press per person.
test("the chart's trail retraces re-roots and Back leaves in one press", { tag: "@smoke" }, async ({ page }) => {
  await openChartsFromEdit(page);

  const title = page.locator(".tree-title-name");
  const firstRoot = (await title.textContent())!.trim();
  expect(firstRoot.length).toBeGreaterThan(0);
  // Back names the person Edit stood on.
  await expect(page.locator(".tree-toolbar .tree-back-btn")).toHaveAttribute("aria-label", new RegExp(`^Back to Edit — ${firstRoot}`));

  // A trail of one is just the chart: no arrows yet.
  await expect(page.locator(".chart-trail")).toHaveCount(0);

  // Re-root on another drawn person, twice, via the node panel's "Root".
  const roots: string[] = [firstRoot];
  for (let i = 0; i < 2; i++) {
    const other = page.locator("svg.tree-svg g.tree-node").nth(i + 1);
    await other.click();
    await page.getByRole("button", { name: "Root", exact: true }).click();
    await expect(title).not.toHaveText(roots[roots.length - 1]);
    roots.push((await title.textContent())!.trim());
  }

  // ‹ steps back one person, the , key another, the . key forward again.
  await page.getByRole("button", { name: /^Previous person/ }).click();
  await expect(title).toHaveText(roots[1]);
  await page.keyboard.press(",");
  await expect(title).toHaveText(roots[0]);
  await expect(page.getByRole("button", { name: /^Previous person/ })).toBeDisabled();
  await page.keyboard.press(".");
  await expect(title).toHaveText(roots[1]);

  // The ▾ list jumps straight to any of them.
  await page.getByRole("button", { name: "People this chart was drawn for" }).click();
  await page.getByRole("option", { name: new RegExp(`^${roots[2]}`) }).click();
  await expect(title).toHaveText(roots[2]);

  // The Back label still names Edit's person, not the previous root.
  await expect(page.locator(".tree-toolbar .tree-back-btn")).toHaveAttribute("aria-label", new RegExp(`^Back to Edit — ${firstRoot}`));

  // One browser Back leaves the chart for the Edit view it was opened from…
  await page.goBack();
  await expect(page.locator("svg.tree-svg")).toHaveCount(0);
  await expect(page.locator(".edit-person")).toBeVisible();
  // …and Forward returns to the chart on the person it was left on.
  await page.goForward();
  await expect(title).toHaveText(roots[2]);
});

// The mode letters work on a chart page too: each leaves the chart for its
// mode, pushed on top of the chart, so Back returns to it. E with nobody
// selected opens the chart's own person in Edit.
test("E / M / T leave a chart for their mode", async ({ page }) => {
  await openChartsFromEdit(page);
  const title = page.locator(".tree-title-name");

  await page.keyboard.press("t");
  await expect(page.locator(".tools-view")).toBeVisible();
  await expect(page.locator("svg.tree-svg")).toHaveCount(0);
  await page.goBack();
  await expect(page.locator("svg.tree-svg")).toBeVisible();

  await page.keyboard.press("m");
  await expect(page.locator("svg.tree-svg")).toHaveCount(0);
  await expect(page.locator(".tools-view")).toBeHidden();
  await expect(page.locator(".edit-person")).toBeHidden();
  await page.goBack();
  await expect(page.locator("svg.tree-svg")).toBeVisible();

  // Re-root first, so Edit opening on the chart's person is not a coincidence.
  await page.locator("svg.tree-svg g.tree-node").nth(1).click();
  const before = (await title.textContent())!.trim();
  await page.getByRole("button", { name: "Root", exact: true }).click();
  await expect(title).not.toHaveText(before);
  const root = (await title.textContent())!.trim();

  await page.keyboard.press("e");
  await expect(page.locator("svg.tree-svg")).toHaveCount(0);
  await expect
    .poll(async () => {
      const parts = await page
        .locator(".edit-person .edit-name-input")
        .evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value));
      return parts.map((p) => p.trim()).filter(Boolean).join(" ");
    })
    .toBe(root);
});

// A chart carries the app's own header: no mode tab is lit, the Charts button
// is, and a tab or a file pill leaves the chart (Back returns to it).
test("the chart's header leaves for a mode or the files", async ({ page }) => {
  await openChartsFromEdit(page);
  await expect(page.locator(".tree-shell .mode-tabs .seg-btn.active")).toHaveCount(0);
  await expect(page.locator(".tree-shell .charts-open-btn")).toHaveAttribute("aria-pressed", "true");

  await page.locator(".tree-shell .mode-tabs").getByRole("button", { name: "Tools", exact: true }).click();
  await expect(page.locator(".tools-view")).toBeVisible();
  await expect(page.locator("svg.tree-svg")).toHaveCount(0);
  await page.goBack();
  await expect(page.locator("svg.tree-svg")).toBeVisible();

  await page.locator(".tree-shell .header-file-btn.main").click();
  await expect(page.locator("svg.tree-svg")).toHaveCount(0);
  await expect(page.locator(".info-panel")).toBeVisible();
});

// The chart's ☰ (a narrower window) works: the app's own ☰, hidden under the
// chart, once shared its open state and closed this one before a click landed.
test("the chart's ☰ opens the files and adds a person", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 700 });
  await openChartsFromEdit(page);
  await page.locator(".tree-shell .app-menu-btn").click();
  await page.locator(".tree-shell .app-menu-files-more").click();
  await expect(page.locator("svg.tree-svg")).toHaveCount(0);
  await expect(page.locator(".info-panel")).toBeVisible();

  await page.goBack();
  await expect(page.locator("svg.tree-svg")).toBeVisible();
  await page.locator(".tree-shell .app-menu-btn").click();
  await page.locator(".tree-shell .app-menu-item", { hasText: "Add new person" }).click();
  await expect(page.locator("svg.tree-svg")).toHaveCount(0);
  await expect(page.locator(".edit-person .edit-name-input").first()).toHaveValue("");
  await expect(page.locator(".app-head-actions .export-btn").first()).toBeEnabled();
});

// On a phone the chart's toolbar is Back, the title and a ☰; the kind, the
// direction, Find and the settings/export pair live in the ☰'s panel.
test("a phone chart folds its controls into a ☰", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 760 });
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(SAMPLE);
  await page.locator(".edit-person").waitFor();
  await page.keyboard.press("v");
  await expect(page.locator("svg.tree-svg")).toBeVisible();
  await expect(page.locator(".tree-page > .tree-controls")).toHaveCount(0);
  await expect(page.locator(".chart-find-input, .tree-page input[type=search]")).toHaveCount(0);

  await page.locator(".chart-menu-btn").click();
  await page.locator(".chart-menu-panel .picker-menu-btn").click();
  await page.locator(".chart-menu-panel .picker-menu-item", { hasText: "Fan" }).click();
  await expect(page.locator(".chart-menu-panel .picker-menu-btn")).toContainText("Fan");
  await page.keyboard.press("Escape");
  await expect(page.locator(".chart-menu-panel")).toHaveCount(0);
  await expect(page.locator("svg.tree-svg")).toBeVisible();
});

// V opens the charts from any mode, as the header button does — in Tools,
// where no view answers it, on the start person.
test("V opens the charts from Tools", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(SAMPLE);
  await page.locator(".edit-person").waitFor();
  await page.keyboard.press("t");
  await expect(page.locator(".tools-view")).toBeVisible();
  await page.keyboard.press("v");
  await expect(page.locator("svg.tree-svg")).toBeVisible();
  await page.goBack();
  await expect(page.locator(".tools-view")).toBeVisible();
});
