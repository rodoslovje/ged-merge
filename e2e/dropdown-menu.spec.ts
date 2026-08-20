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

// The menu is fixed-position, so it cannot ride along with its trigger: it
// re-places itself instead, and only a trigger that has left the view takes it
// down. Nothing about a page still settling under its own layout — the scroll
// a browser makes to anchor content, a scroll-into-view landing a frame after
// the click it belongs to — may shut a menu it never moved out of sight.
test("a menu follows its anchor, and goes when the anchor leaves", async ({ page }) => {
  await openEdit(page);
  await page.locator('button[title*="etting"]').first().click();
  await page.locator(".settings-quick-events").waitFor();

  const trigger = page.locator(".settings-quick-add");
  await openMenu(trigger, () => trigger.click());
  const menu = page.locator(".dd-menu");

  // A scroll event over the dialog that left it exactly where it was.
  await page.locator(".modal-body").evaluate((el) => el.dispatchEvent(new Event("scroll", { bubbles: true })));
  await expect(menu).toBeVisible();

  // A scroll that does move the anchor: the menu stays, and travels with it.
  const trigBefore = (await trigger.boundingBox())!;
  const menuBefore = (await menu.boundingBox())!;
  await page.locator(".modal-body").evaluate((el) => { el.scrollTop = Math.max(0, el.scrollTop - 40); });
  await expect(menu).toBeVisible();
  const trigAfter = (await trigger.boundingBox())!;
  const menuAfter = (await menu.boundingBox())!;
  const trigMoved = trigAfter.y - trigBefore.y;
  expect(Math.abs(trigMoved), "the scroll must actually move the trigger").toBeGreaterThan(5);
  expect(Math.abs(menuAfter.y - menuBefore.y - trigMoved), "the menu must travel with it").toBeLessThan(2);

  // Out of the dialog's view entirely — the picker sits low in the settings, so
  // scrolling the dialog back to its top clips the trigger away — and the menu
  // goes with it.
  await page.locator(".modal-body").evaluate((el) => { el.scrollTop = 0; });
  await expect(menu).toHaveCount(0);
});

// An open list owns the keyboard, as a native select's popup does. The Edit
// view answers ArrowDown by scrolling its person panel 96 smoothly-animated
// pixels — and that is the very key that opens this menu, so the panel used to
// slide out from under the list a moment after it appeared.
test("a key the menu answers does not also drive the view behind it", async ({ page }) => {
  await openEdit(page);
  const scroller = page.locator(".edit-view .section-body").first();
  await expect(scroller).toBeVisible();
  const trigger = page.locator(".sex-select").first();

  await openMenu(trigger, () => trigger.click());
  await page.keyboard.press("Escape");
  const before = await scroller.evaluate((el) => el.scrollTop);

  await openMenu(trigger, () => page.keyboard.press("ArrowDown"));
  await page.waitForTimeout(500); // long enough for a smooth scroll to have run
  expect(await scroller.evaluate((el) => el.scrollTop), "the panel behind must not have moved").toBe(before);
  await expect(page.locator(".dd-menu")).toBeVisible();
});

// The Edit view settles for a while after it appears — fonts and images land,
// and a scroll started elsewhere is still animating. Every pixel of that used
// to read as "the anchor moved", closing a menu that had only just opened;
// under a slow CPU it closed every time. Throttling makes the settling overlap
// the interaction on purpose.
test("a menu survives a panel still settling under it", async ({ page, context }) => {
  await openEdit(page);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 8 });

  const trigger = page.locator(".sex-select").first();
  await openMenu(trigger, () => trigger.click());
  await page.keyboard.press("Escape");
  await expect(page.locator(".dd-menu")).toHaveCount(0);

  await page.keyboard.press("ArrowDown");
  // The browser is throttled 8× on purpose here, so every wait in this test is
  // spending an eighth of its real budget — and whatever the machine is doing
  // besides comes off the same eighth. Hence the room.
  await expect(page.locator(".dd-menu")).toBeVisible({ timeout: 20_000 });
  // Still there once the settling has run its course.
  await expect(page.locator(".dd-menu")).toBeVisible({ timeout: 20_000 });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
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
