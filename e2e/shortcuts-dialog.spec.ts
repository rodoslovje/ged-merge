import { test, expect } from "@playwright/test";

// The dialog is the only place the shortcuts are written down, so it has to
// keep up with them — it went on listing bare digits after they moved to ⌥⇧.
test("the dialog lists the editing shortcuts as they are bound", async ({ page }) => {
  await page.goto("/");
  await page.locator(".app-footer button").filter({ hasText: /Keyboard|Shortcut/i }).first().click();

  const rows = page.locator(".shortcuts-row");
  await expect(rows.first()).toBeVisible();
  const text = (await rows.allInnerTexts()).map((r) => r.replace(/\s+/g, " ").trim());

  // Every editing shortcut, and no leftover bare digits.
  expect(text.some((r) => /⌥ ⇧ 1 – 9|Alt Shift 1 – 9/.test(r))).toBe(true);
  expect(text.some((r) => /(⌥ ⇧|Alt Shift) E\b/.test(r))).toBe(true);
  expect(text.some((r) => /(⌥ ⇧|Alt Shift) N \/ S/.test(r))).toBe(true);
  expect(text.some((r) => /(⌥ ⇧|Alt Shift) A \/ I \/ L/.test(r))).toBe(true);
  expect(text.some((r) => /(⌥ ⇧|Alt Shift) F \/ M/.test(r))).toBe(true);
  expect(text.some((r) => /(⌥ ⇧|Alt Shift) P \/ C/.test(r))).toBe(true);
  // The digits used to be listed on their own, without a modifier.
  expect(text.some((r) => /^1 – 9|^1 \/ 9/.test(r))).toBe(false);
});

test("modifiers shared by several keys sit on their own line", async ({ page }) => {
  await page.goto("/");
  await page.locator(".app-footer button").filter({ hasText: /Keyboard|Shortcut/i }).first().click();
  await expect(page.locator(".shortcuts-row").first()).toBeVisible();

  const laidOut = await page.locator(".kbd-combo").evaluateAll((els) =>
    els.map((el) => {
      const mods = el.querySelector(".kbd-mods");
      const chord = el.querySelector(".kbd-chord");
      if (!mods || !chord) return { stacked: false, above: true };
      return { stacked: true, above: mods.getBoundingClientRect().bottom <= chord.getBoundingClientRect().top + 1 };
    }));

  // Whenever they are hoisted, they are above — never beside, which is what
  // made the column wide.
  expect(laidOut.every((c) => c.above)).toBe(true);
  expect(laidOut.some((c) => c.stacked)).toBe(true);
});
