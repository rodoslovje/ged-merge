import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

/**
 * `useVirtualList` must never crash-loop, however wrong its measurements are.
 *
 * A user on Windows/Chrome lost the whole Tools tab to React's "Maximum update
 * depth exceeded" (minified error #185) by scrolling a 175-row health-check
 * list. The loop is structural: the spacers stand in for the unmounted rows at
 * the model's common row height while the mounted rows contribute their real
 * height, so a model that disagrees with the layout makes the scroller's
 * content height depend on how many rows happen to be mounted — and at the end
 * of the list scrollTop is pinned to that content height. Measure, re-render,
 * measure, with no frame in between, until React gives up.
 *
 * These tests force the disagreement rather than wait for a platform to supply
 * it. The CSS `zoom` property reports `getBoundingClientRect()` in scaled units
 * while `scrollTop` / `clientHeight` stay in layout units, so the hook measures
 * a row height that is simply wrong — a cheap, deterministic stand-in for any
 * measurement mismatch, and the condition under which the loop actually fires.
 * (Note this is CSS `zoom`, not browser zoom, which scales both consistently.)
 *
 * So the assertion here is the backstop only: no crash-loop, whatever the
 * measurements say. That the window tracks the scroll position *correctly* is
 * asserted separately, on an unmanipulated list, at the bottom of this file.
 *
 * All four lists that use the hook are covered — every one of them loops
 * without the settle cap.
 */

const HEAD = ["0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8"];

/** N people with a birth and no death, and varied name lengths. */
function people(n: number, prefix: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const given = i % 3 === 0 ? `Ana${i}` : `Marija Ana Terezija Nepomucena${i}`;
    const sn = i % 2 === 0 ? `Kos${i}` : `Podgoriznadravskovasjadolinapribeljska${i}`;
    out.push(
      `0 @${prefix}${i}@ INDI`,
      `1 NAME ${given} /${sn}/`,
      i % 2 ? "1 SEX F" : "1 SEX M",
      "1 BIRT",
      `2 DATE ${1 + (i % 28)} JAN ${1800 + (i % 90)}`,
      "2 PLAC Kranj, Gorenjska, Slovenija",
    );
  }
  return out;
}

// Merge: two files holding the same 300 people, so every one is a candidate.
const MAIN = path.join(tmpdir(), "vloop-main.ged");
const COMPARE = path.join(tmpdir(), "vloop-compare.ged");
writeFileSync(MAIN, [...HEAD, ...people(300, "I"), "0 TRLR", ""].join("\n"), "utf-8");
writeFileSync(COMPARE, [...HEAD, ...people(300, "P"), "0 TRLR", ""].join("\n"), "utf-8");

// Duplicates: 220 self-contained same-person pairs → 220 pair rows.
const DUPS = path.join(tmpdir(), "vloop-dups.ged");
{
  const lines = [...HEAD];
  for (let f = 0; f < 220; f++) {
    const sn = f % 2 === 0 ? `Kla${f}` : `Podgoriznadravskovasjadolinapribeljska${f}`;
    lines.push(`0 @FA${f}@ INDI`, `1 NAME Ata${f} /${sn}/`, "1 SEX M");
    lines.push(`0 @MO${f}@ INDI`, `1 NAME Mama${f} /${sn}/`, "1 SEX F");
    for (let c = 0; c < 2; c++) {
      lines.push(
        `0 @C${f}_${c}@ INDI`, `1 NAME Janez Nepomuk${f} /${sn}/`, "1 SEX M",
        "1 BIRT", `2 DATE 12 JAN ${1700 + f}`, "2 PLAC Kranj, Gorenjska, Slovenija",
        `1 FAMC @F${f}@`,
      );
    }
    lines.push(`0 @F${f}@ FAM`, `1 HUSB @FA${f}@`, `1 WIFE @MO${f}@`, `1 CHIL @C${f}_0@`, `1 CHIL @C${f}_1@`);
  }
  lines.push("0 TRLR", "");
  writeFileSync(DUPS, lines.join("\n"), "utf-8");
}

function watch(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  return errors;
}

/** Wheel down over `rowSelector`, then assert the tab is still alive. */
async function wheelAndAssertNoLoop(page: Page, errors: string[], rowSelector: string) {
  // Wheel, not scrollTop: assigning scrollTop resets the browser's own scroll
  // bookkeeping and hides the feedback this is about.
  await page.locator(rowSelector).first().hover();
  for (let i = 0; i < 80; i++) {
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(20);
    if (await page.locator(".error-fallback").count()) break;
  }
  await expect(page.locator(".error-fallback"), "error boundary caught a crash").toHaveCount(0);
  const depthLoop = errors.filter((e) => /Maximum update depth|error #185/i.test(e));
  expect(depthLoop, `page errors:\n${errors.slice(0, 3).join("\n")}`).toHaveLength(0);
}

async function loadMain(page: Page, file: string, zoom: number) {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(file);
  await page.locator(".edit-person").first().waitFor({ timeout: 60000 });
  if (zoom !== 1) await page.addStyleTag({ content: `:root { zoom: ${zoom} }` });
}

for (const zoom of [0.9, 0.8]) {
  test(`merge match list does not crash-loop (zoom ${zoom})`, async ({ page }) => {
    test.setTimeout(180000);
    const errors = watch(page);
    await loadMain(page, MAIN, zoom);
    await page.getByRole("button", { name: "Merge", exact: true }).click();
    await page.locator("input.file-input").last().setInputFiles(COMPARE);
    await page.locator(".candidate").first().waitFor({ timeout: 60000 });
    await page.waitForTimeout(300);
    await wheelAndAssertNoLoop(page, errors, ".candidate");
  });

  test(`duplicate pair list does not crash-loop (zoom ${zoom})`, async ({ page }) => {
    test.setTimeout(180000);
    const errors = watch(page);
    await loadMain(page, DUPS, zoom);
    await page.getByRole("button", { name: "Tools", exact: true }).click();
    await page.getByText("Find duplicates", { exact: true }).first().click();
    await expect(page.locator(".tools-pair").first()).toBeVisible({ timeout: 120000 });
    await page.waitForTimeout(300);
    await wheelAndAssertNoLoop(page, errors, ".tools-pair");
  });

  test(`batch match list does not crash-loop (zoom ${zoom})`, async ({ page }) => {
    test.setTimeout(180000);
    const errors = watch(page);
    await loadMain(page, MAIN, zoom);
    await page.getByRole("button", { name: "Tools", exact: true }).click();
    await page.getByText("Normalize & batch", { exact: true }).first().click();
    // "Batch actions" is the panel's default section, and with no filters every
    // person matches — the whole 300-row file.
    await expect(page.locator(".batch-section-tab.active")).toHaveText("Batch actions");
    await expect(page.locator(".batch-row").first()).toBeVisible({ timeout: 120000 });
    await page.waitForTimeout(300);
    await wheelAndAssertNoLoop(page, errors, ".batch-row");
  });
}

// The other half of the contract: with measurements the hook can trust, the
// settle cap must not stop the window short. Capping re-renders would be a poor
// trade if it left the viewport parked over the spacers with nothing drawn.
test("the window keeps up with the scroll position on an unmanipulated list", async ({ page }) => {
  test.setTimeout(180000);
  const errors = watch(page);
  await loadMain(page, MAIN, 1);
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Health check", { exact: true }).first().click();
  await expect(page.locator(".tools-issues").first()).toBeVisible({ timeout: 120000 });
  await page.locator(".tools-chip", { hasText: "Living over 99" }).click();
  await page.waitForTimeout(300);

  await page.locator(".tools-view").hover();
  for (let i = 0; i < 60; i++) {
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(20);
  }
  await page.waitForTimeout(300);

  const covered = await page.evaluate(() => {
    const sc = document.querySelector(".tools-view") as HTMLElement;
    const port = sc.getBoundingClientRect();
    const rows = [...document.querySelectorAll<HTMLElement>(".tools-issue")];
    const visible = rows.filter((r) => {
      const b = r.getBoundingClientRect();
      return b.bottom > port.top && b.top < port.bottom;
    });
    // How much of the scrollport the drawn rows actually span.
    const spanned = visible.length
      ? Math.min(port.bottom, Math.max(...visible.map((r) => r.getBoundingClientRect().bottom))) -
        Math.max(port.top, Math.min(...visible.map((r) => r.getBoundingClientRect().top)))
      : 0;
    return { visible: visible.length, coverage: spanned / port.height };
  });
  expect(covered.visible, "no findings drawn inside the scrollport").toBeGreaterThan(0);
  expect(covered.coverage, "findings cover only part of the scrollport").toBeGreaterThan(0.9);
  expect(errors.filter((e) => /Maximum update depth/i.test(e))).toHaveLength(0);
});
