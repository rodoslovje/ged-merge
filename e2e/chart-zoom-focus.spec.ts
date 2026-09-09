import { test, expect } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(__dirname, "../src/__fixtures__/corpus/reunion-5.5.1-utf8.ged");

// A pinch (or ctrl+wheel run) is painted as a transform on the zoom layer and
// only handed over as a real zoom + scroll once the gesture goes idle. Two
// things have to hold for that to feel like one continuous movement: whatever
// sits under the fingers must stay under them while the scale changes, and the
// hand-over must land on exactly the picture the transform was showing. When
// either slips, the chart jumps — which is what the gesture used to do, its
// transform solved for a top-left origin while the layer scaled about its
// centre.

/** Two frames: long enough for the gesture's rAF paint to have landed. */
const painted = (page: import("@playwright/test").Page) =>
  page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

test("ctrl+wheel zoom keeps the point under the cursor, and the commit does not move it", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(SAMPLE);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  await page.locator(".charts-open-btn").click();
  await page.locator("svg.tree-svg").waitFor();

  const node = page.locator("svg.tree-svg g.tree-node").first();
  const before = (await node.boundingBox())!;
  const focus = { x: before.x + before.width / 2, y: before.y + before.height / 2 };

  const pct = page.locator(".tree-zoom-pct");
  const startPct = (await pct.textContent())!.trim();

  // A run of wheel ticks with ctrl held — how a browser reports a trackpad
  // pinch — aimed at the node's centre.
  for (let i = 0; i < 6; i++) {
    await page.locator(".tree-canvas").dispatchEvent("wheel", {
      deltaY: -60,
      deltaMode: 0,
      ctrlKey: true,
      clientX: focus.x,
      clientY: focus.y,
      bubbles: true,
      cancelable: true,
    });
  }
  await painted(page);

  // Mid-gesture: the chart is bigger and the node has not left the cursor.
  const during = (await node.boundingBox())!;
  expect(during.width).toBeGreaterThan(before.width * 1.1);
  expect(during.x + during.width / 2).toBeCloseTo(focus.x, 0);
  expect(during.y + during.height / 2).toBeCloseTo(focus.y, 0);

  // The gesture goes idle and hands over to the real zoom — the percentage
  // readout only changes on that commit.
  await expect(pct).not.toHaveText(startPct);
  await painted(page);

  // After the hand-over the node sits where the gesture had already put it.
  const after = (await node.boundingBox())!;
  expect(after.width).toBeCloseTo(during.width, 0);
  expect(after.x + after.width / 2).toBeCloseTo(focus.x, 0);
  expect(after.y + after.height / 2).toBeCloseTo(focus.y, 0);
});

test("a grab-pan moves the chart and still leaves nodes clickable", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(SAMPLE);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  await page.locator(".charts-open-btn").click();
  await page.locator("svg.tree-svg").waitFor();

  const canvas = page.locator(".tree-canvas");
  const box = (await canvas.boundingBox())!;
  const scrollOf = () => canvas.evaluate((el) => el.scrollLeft + el.scrollTop);
  const start = await scrollOf();

  // Drag from the middle of the canvas towards the top-left: the chart scrolls
  // the other way.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) {
    await page.mouse.move(box.x + box.width / 2 - i * 30, box.y + box.height / 2 - i * 20);
  }
  await page.mouse.up();

  await expect.poll(scrollOf).toBeGreaterThan(start);
  await expect(canvas).not.toHaveClass(/panning/);

  // The click the drag would have emitted is swallowed, but the next real one
  // still selects — a pan must not disarm the chart.
  await page.locator("svg.tree-svg g.tree-node").first().click();
  await expect(page.getByRole("button", { name: "Root", exact: true })).toBeVisible();
});
