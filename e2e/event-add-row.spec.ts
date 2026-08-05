import { test, expect } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(__dirname, "../src/__fixtures__/corpus/reunion-5.5.1-utf8.ged");

async function openEdit(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(SAMPLE);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();
}

// The buttons that add an event belong under the list they add to — and out of
// the tab path between the name and the first event field.
test("the event buttons sit below the event list, the menu last", async ({ page }) => {
  await openEdit(page);

  const row = page.locator(".edit-event-add-row");
  const labels = await row.locator("button").allInnerTexts();
  expect(labels[labels.length - 1]).toMatch(/Add Event/i);
  expect(labels.slice(0, -1).join(" ")).toContain("Birth");

  // Below the person's own event list (the family sections' events come later
  // still, in their own blocks).
  const rowTop = (await row.boundingBox())!.y;
  const list = (await page.locator(".edit-events").first().boundingBox())!;
  expect(rowTop).toBeGreaterThanOrEqual(list.y + list.height - 1);

  // And the names row above no longer carries them.
  await expect(page.locator(".edit-other-names")).not.toContainText("Add Event");
});

test("an event the person can only have one of leads to the one they have", async ({ page }) => {
  await openEdit(page);
  await page.getByRole("button", { name: /Search everyone/i }).click();
  await page.locator(".global-search-input").fill("Elizabeta");
  await page.locator(".global-search-open").first().click();
  await expect(page.locator(".edit-name-input").first()).toHaveValue(/Elizabeta/);

  // Birth and Death are recorded, so their buttons drop the "+" and lead there.
  const recorded = page.locator(".edit-name-chip--recorded");
  await expect(recorded).toHaveText(["Birth", "Death"]);
  await expect(recorded.first()).toHaveAttribute("title", /already recorded/i);

  // Clicking one puts the keyboard in that event rather than adding a second.
  await recorded.first().click();
  const focused = await page.evaluate(() => document.activeElement?.className ?? "");
  expect(focused).toContain("edit-event-date");
  expect(await page.locator(".edit-event").filter({ hasText: "Birth" }).count()).toBe(1);
});
