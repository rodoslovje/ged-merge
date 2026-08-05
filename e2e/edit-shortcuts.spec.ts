import { test, expect, type Page } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(__dirname, "../src/__fixtures__/corpus/reunion-5.5.1-utf8.ged");

async function openEdit(page: Page) {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(SAMPLE);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();
}

/** Press ⌥⇧ plus a physical key, the way the shortcuts are matched. */
function altShift(page: Page, key: string) {
  return page.keyboard.press(`Alt+Shift+${key}`);
}

test("the shortcuts fire while a field is being typed in", async ({ page }) => {
  await openEdit(page);
  const given = page.locator(".edit-name-input").first();
  await given.click();

  await altShift(page, "Digit2"); // Residence, the second quick event
  const rows = page.locator(".edit-event");
  await expect(rows.filter({ hasText: "Residence" })).toHaveCount(1);
  // The typing did not leak into the field it was fired from.
  await expect(given).not.toHaveValue(/[2™]/);
});

test("a note goes to the event the keyboard is in, not the person", async ({ page }) => {
  await openEdit(page);
  const birth = page.locator(".edit-event").first();
  await birth.locator(".edit-event-date").click();

  await altShift(page, "KeyN");
  await expect(birth.locator(".edit-event-note")).toBeVisible();
  await expect(birth.locator(".edit-event-note")).toBeFocused();
  // The person's own note stayed shut.
  await expect(page.locator(".edit-person > .edit-notes, .edit-person-notes")).toHaveCount(0);
});

test("a note goes to the person when the keyboard is not in an event", async ({ page }) => {
  await openEdit(page);
  await page.locator(".edit-name-input").first().click();

  await altShift(page, "KeyN");
  // Every event keeps a note field in the DOM, hidden until it has something
  // to show — so this asks whether it was revealed, not whether it exists.
  await expect(page.locator(".edit-event").first().locator(".edit-event-note")).toBeHidden();
  await expect(page.locator("textarea").first()).toBeVisible();
});

test("a source opens the dialog for the event the keyboard is in", async ({ page }) => {
  await openEdit(page);
  await page.locator(".edit-event").first().locator(".edit-event-date").click();

  await altShift(page, "KeyS");
  await expect(page.locator(".add-source-dialog")).toBeVisible();
});

test("the letters reach the person's own actions", async ({ page }) => {
  await openEdit(page);
  await page.locator(".edit-name-input").first().click();

  // A — an alternative name, opened for editing.
  await altShift(page, "KeyA");
  await expect(page.locator(".edit-name-chip-editing")).toBeVisible();
  await page.keyboard.press("Escape");

  // E — the add-event menu.
  await page.locator(".edit-name-input").first().click();
  await altShift(page, "KeyE");
  await expect(page.locator(".dd-menu")).toBeVisible();
  await page.keyboard.press("Escape");

  // P — the privacy flag.
  await page.locator(".edit-name-input").first().click();
  await altShift(page, "KeyP");
  await expect(page.locator(".edit-person .private-toggle, .edit-person [title*='rivate']").first()).toBeVisible();
});
