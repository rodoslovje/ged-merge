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
  await expect(page.locator(".edit-note-chip [contenteditable]").first()).toBeVisible();
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

  // L — the privacy flag (the lock it shows; P belongs to Partner).
  await page.locator(".edit-name-input").first().click();
  await altShift(page, "KeyL");
  await expect(page.locator(".edit-person .private-toggle, .edit-person [title*='rivate']").first()).toBeVisible();
});

// F, M, P and C open the picker on the "+ Add …" slot they name.
test("the relative letters open the picker on their own empty slot", async ({ page }) => {
  await openEdit(page);
  // A person made from the search bar is attached to nobody, so every slot the
  // letters name stands empty.
  await page.getByRole("button", { name: /Search everyone/i }).click();
  await page.locator(".global-search-input").fill("xylo zorn");
  await page.locator(".global-search-create").click();
  await page.locator(".edit-parents .person-card-add").first().waitFor();

  await page.locator(".edit-name-input").first().click();
  await altShift(page, "KeyF");
  const picker = page.locator(".edit-parents .relative-picker");
  await expect(picker).toHaveCount(1);
  await expect(picker.locator(".relative-picker-input")).toBeFocused();
  await page.keyboard.press("Escape");

  await page.locator(".edit-name-input").first().click();
  await altShift(page, "KeyM");
  await expect(page.locator(".edit-parents .relative-picker")).toHaveCount(1);
  await page.keyboard.press("Escape");

  // C — a child, in the person's only family.
  await page.locator(".edit-name-input").first().click();
  await altShift(page, "KeyC");
  await expect(page.locator(".edit-families .relative-picker")).toHaveCount(1);
});

test("undo, redo and save answer to the capital letter Shift or Caps Lock sends", async ({ page }) => {
  await openEdit(page);
  const residence = page.locator(".edit-event").filter({ hasText: "Residence" });
  const before = await residence.count();
  await altShift(page, "Digit2");
  await expect(residence).toHaveCount(before + 1);
  // Out of the new event's date field: the chords below are the page's own.
  await page.keyboard.press("Escape");

  // Caps Lock on: Ctrl+Z arrives as "Z".
  await page.keyboard.press("Control+Z");
  await expect(residence).toHaveCount(before);
  // With Shift held a real keyboard reports "Z" too — Ctrl+Shift+Z is redo.
  await page.keyboard.press("Control+Shift+Z");
  await expect(residence).toHaveCount(before + 1);

  await page.keyboard.press("Control+S");
  await expect(page.locator(".modal-overlay")).toBeVisible();
});

test("⌥ + arrow walks the family from a menu button left focused by Esc", async ({ page }) => {
  await openEdit(page);
  await altShift(page, "KeyE");
  await expect(page.locator(".dd-menu")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.locator(".dd-menu")).toHaveCount(0);

  // The trigger still has focus; a bare arrow would open its list again.
  await page.keyboard.press("Alt+ArrowDown");
  await page.keyboard.press("Alt+ArrowUp");
  await expect(page.locator(".dd-menu")).toHaveCount(0);
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".dd-menu")).toHaveCount(1);
});
