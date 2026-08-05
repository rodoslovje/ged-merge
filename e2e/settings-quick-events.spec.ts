import { test, expect } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(__dirname, "../src/__fixtures__/corpus/reunion-5.5.1-utf8.ged");

async function openQuickEvents(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(SAMPLE);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();
  await page.locator('button[title*="etting"]').first().click();
  await page.locator(".settings-quick-events").waitFor();
}

/** The look of a chip, for comparing one place against another. */
const look = (el: Element) => {
  const cs = getComputedStyle(el);
  return {
    h: Math.round(el.getBoundingClientRect().height),
    font: cs.fontSize,
    pad: cs.padding,
    border: `${cs.borderWidth} ${cs.borderStyle} ${cs.borderColor}`,
    radius: cs.borderRadius,
  };
};

// The list configures the buttons under the event list in Edit, so it should
// look like them — it used to carry chips of its own, a size and a border apart.
test("the settings chips match the ones they configure", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(SAMPLE);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();
  const inEdit = await page.locator(".edit-event-add-row .edit-name-chip-add").nth(1).evaluate(look);

  await page.locator('button[title*="etting"]').first().click();
  await page.locator(".settings-quick-events").waitFor();
  const inSettings = await page.locator(".settings-quick-add").evaluate(look);

  expect(inSettings).toEqual(inEdit);
});

test("an event can still be added to the list and taken off it", async ({ page }) => {
  await openQuickEvents(page);
  const chips = page.locator(".settings-quick-chip");
  const before = await chips.count();

  await page.locator(".settings-quick-add").click();
  await page.locator(".dd-menu .dd-item").first().click();
  await expect(chips).toHaveCount(before + 1);

  await page.locator(".settings-quick-events .edit-link-remove").last().click();
  await expect(chips).toHaveCount(before);
});
