import { test, expect } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(__dirname, "../src/__fixtures__/corpus/reunion-5.5.1-utf8.ged");

// Re-rooting a chart is a navigation, so the browser Back button has to undo it:
// every person the user re-roots on (a node's "Set as root", a "+N" cut marker,
// the find box's off-chart offer) is its own history entry, and only the first
// one closes the hub. Before this, the hub kept the root in its own state and
// Back jumped straight out of the chart, losing the whole trail.
test("Back walks back through the people a chart was re-rooted on", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(SAMPLE);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  await page.locator(".charts-open-btn").click();
  await page.locator("svg.tree-svg").waitFor();

  const title = page.locator(".tree-title-name");
  const firstRoot = (await title.textContent())!.trim();
  expect(firstRoot.length).toBeGreaterThan(0);

  // Re-root on another drawn person, twice, via the node panel's "Set as root".
  const roots: string[] = [firstRoot];
  for (let i = 0; i < 2; i++) {
    const other = page.locator("svg.tree-svg g.tree-node").nth(i + 1);
    await other.click();
    await page.getByRole("button", { name: "Set as root" }).click();
    await expect(title).not.toHaveText(roots[roots.length - 1]);
    roots.push((await title.textContent())!.trim());
  }

  // Back retraces the trail one person at a time…
  await page.goBack();
  await expect(title).toHaveText(roots[1]);
  await page.goBack();
  await expect(title).toHaveText(roots[0]);

  // …and only then leaves the chart for the Edit view it was opened from.
  await page.goBack();
  await expect(page.locator("svg.tree-svg")).toHaveCount(0);
  await expect(page.locator(".edit-person")).toBeVisible();
});
