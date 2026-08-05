import { test, expect, type Locator, type Page } from "@playwright/test";
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

/** Open a menu by `act` (a click or a key), retrying while the app is still
 * settling: an edit commit remounts the card it lives on, and a remount landing
 * between the press and the render swallows the menu. Retried, not waited out —
 * the assertion still fails if the menu never opens or does not stay. */
async function openMenu(trigger: Locator, act: () => Promise<void>) {
  const menu = trigger.page().locator(".dd-menu");
  await expect(async () => {
    if ((await menu.count()) === 0) await act();
    await expect(menu).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await expect(trigger).toBeFocused();
}

/** Add an alternative name and return its open inline editor. */
async function addName(page: Page) {
  await page.getByRole("button", { name: /Add Name/i }).first().click();
  const editor = page.locator(".edit-name-chip-editing");
  await expect(editor).toBeVisible();
  return editor;
}

// The editor closes when focus leaves it, and the menu is portalled to <body>.
// Opening it must not read as leaving — in Safari, which focuses no button on
// click, the field used to blur to <body> on mousedown and take the editor
// (and the menu with it) down before the click landed.
test("a menu inside a blur-closing editor opens, survives and applies", async ({ page }) => {
  await openEdit(page);
  const editor = await addName(page);
  await editor.locator(".edit-name-variant-input").first().fill("Mina");

  const trigger = editor.locator(".edit-name-type-select");
  await openMenu(trigger, () => trigger.click());
  await page.locator('.dd-menu .dd-item[data-value="maiden"]').click();

  await expect(page.locator(".edit-name-chip-editing")).toBeVisible();
  await expect(editor.locator(".edit-name-type-select")).toContainText("name at birth");
  await expect(editor.locator(".edit-name-variant-input").first()).toHaveValue("Mina");
});

// Focus stays on the trigger while the menu is open, so the trigger drives the
// keyboard — arrows move the highlight, Enter picks it. Exercised on the sex
// picker: it is the same menu on a host that no commit remounts, so a press
// cannot be swallowed mid-sequence.
test("a menu opens from the keyboard and picks with Enter", async ({ page }) => {
  await openEdit(page);
  const trigger = page.locator(".sex-select").first();

  // Open once with the mouse, so the trigger demonstrably holds focus; Escape
  // then closes without giving that focus up, which is what lets the keyboard
  // reopen it.
  await openMenu(trigger, () => trigger.click());
  await page.keyboard.press("Escape");
  await expect(page.locator(".dd-menu")).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await openMenu(trigger, () => page.keyboard.press("ArrowDown"));

  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect(page.locator(".dd-menu")).toHaveCount(0);
  await expect(page.locator(".sex-select").first()).toContainText("Unknown");
});

test("Escape closes a menu without closing its host editor", async ({ page }) => {
  await openEdit(page);
  const editor = await addName(page);

  const trigger = editor.locator(".edit-name-type-select");
  await openMenu(trigger, () => trigger.click());
  await page.keyboard.press("Escape");

  await expect(page.locator(".dd-menu")).toHaveCount(0);
  await expect(page.locator(".edit-name-chip-editing")).toBeVisible();
});

// The date slot must hold a full "23 AUG 1868" plus the ~18px the input keeps
// clear for its × button, or the last digit is clipped.
test("a full event date fits its slot", async ({ page }) => {
  await openEdit(page);
  const date = page.locator(".edit-event-date").first();
  await date.fill("23 AUG 1868");
  await page.locator(".edit-person").first().click({ position: { x: 5, y: 5 } });

  const fits = await date.evaluate((el: HTMLInputElement) => el.scrollWidth <= el.clientWidth);
  expect(fits, "the date text must not overflow its input").toBe(true);
});
