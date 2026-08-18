import { test, expect } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(__dirname, "../src/__fixtures__/corpus/reunion-5.5.1-utf8.ged");

// "Open in Edit" on a chart node must open exactly that person. The hub used
// to close itself with history.back() and then navigate — but the popstate
// landed a tick later on the entry underneath, which names the person Edit
// showed *before* the chart opened, and restoring it won the race over the
// person just clicked.
test("Open in Edit from a chart opens the clicked person", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(SAMPLE);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  const shownName = page.locator(".edit-person .edit-name-input").first();
  const before = (await shownName.inputValue()).trim();

  await page.locator(".charts-open-btn").click();
  await page.locator("svg.tree-svg").waitFor();

  // Click a person other than the root and read the panel's name for them.
  await page.locator("svg.tree-svg g.tree-node").nth(1).click();
  const clicked = (await page.locator(".tree-compare-name").first().textContent())!.trim();
  expect(clicked).not.toBe(before);

  await page.getByRole("button", { name: "Open in Edit" }).click();
  await expect(page.locator("svg.tree-svg")).toHaveCount(0);
  // The name inputs split the panel's display name (given, surname).
  await expect
    .poll(async () => {
      const parts = await page
        .locator(".edit-person .edit-name-input")
        .evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value));
      return parts.map((p) => p.trim()).filter(Boolean).join(" ");
    })
    .toBe(clicked);

  // The chart's history entry became the person's own, so Back returns to the
  // person Edit stood on before the chart — not to the chart overlay.
  await page.goBack();
  await expect(shownName).toHaveValue(before);
});
