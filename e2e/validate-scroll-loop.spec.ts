import { test, expect } from "@playwright/test";
import { writeFileSync, existsSync } from "fs";
import os from "os";
import path from "path";
import { tmpdir } from "./tmpdir";

/**
 * The reported case: Tools → Health check → "Living over 99" (175 findings) →
 * scroll down → on Windows/Chrome the tab died with React's "Maximum update
 * depth exceeded" (minified error #185).
 *
 * The list is past the virtualization threshold, so its spacers stand in for
 * the unmounted rows at the model's common row height while the mounted rows
 * contribute their real height. A model that disagrees with the layout makes
 * the scroller's content height depend on how many rows happen to be mounted,
 * and at the end of the list scrollTop is pinned to that content height — so
 * the window flips between two neighbouring positions, each flip a synchronous
 * layout-effect re-render, until React aborts the tree.
 *
 * The CSS `zoom` below is the forcing function, not a claim about the user's
 * setup: it reports `getBoundingClientRect()` in scaled units while `scrollTop`
 * stays in layout units, so the hook measures a row height that is wrong. See
 * `virtual-scroll-loop.spec.ts` for the full rationale and for the same check
 * on the app's three other virtualized lists.
 */

// The user's real file, when present; otherwise the synthetic stand-in below.
const REAL = path.join(os.homedir(), "rodoslovje/ged-merge/test-data/Osrajnik.ged");

const BIG = path.join(tmpdir(), "validate-living-too-old.ged");
{
  // Enough people with a birth and no death to clear the 150-row
  // virtualization threshold, with names varied enough that the rows are not
  // all pixel-identical.
  const lines = ["0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8"];
  for (let i = 0; i < 260; i++) {
    const given = i % 3 === 0 ? `Ana${i}` : `Marija Ana Terezija Nepomucena${i}`;
    const sn = i % 2 === 0 ? `Kos${i}` : `Podgoriznadravskovasjadolinapribeljska${i}`;
    lines.push(
      `0 @I${i}@ INDI`,
      `1 NAME ${given} /${sn}/`,
      i % 2 ? "1 SEX F" : "1 SEX M",
      "1 BIRT",
      `2 DATE ${1 + (i % 28)} JAN ${1700 + (i % 120)}`,
      "2 PLAC Kranj, Gorenjska, Slovenija",
    );
  }
  lines.push("0 TRLR", "");
  writeFileSync(BIG, lines.join("\n"), "utf-8");
}

for (const zoom of [0.9, 0.8]) {
  test(`health-check category list survives scrolling (zoom ${zoom})`, async ({ page }) => {
    test.setTimeout(180000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/");
    const useReal = existsSync(REAL) && !process.env.SYNTH;
    await page.locator("input.file-input").first().setInputFiles(useReal ? REAL : BIG);
    await page.locator(".edit-person").first().waitFor({ timeout: 60000 });
    // The real file references local media → a "select the media folder?" prompt.
    const later = page.getByRole("button", { name: "Later" });
    if (await later.count()) await later.click();

    await page.addStyleTag({ content: `:root { zoom: ${zoom} }` });
    await page.getByRole("button", { name: "Tools", exact: true }).click();
    await page.getByText("Health check", { exact: true }).first().click();
    await expect(page.locator(".tools-issues").first()).toBeVisible({ timeout: 120000 });
    await page.locator(".tools-chip", { hasText: "Living over 99" }).click();
    await page.waitForTimeout(300);

    // Wheel, not scrollTop: a programmatic scroll resets the browser's own
    // scroll bookkeeping and hides the feedback this test is about.
    await page.locator(".tools-view").hover();
    for (let i = 0; i < 80; i++) {
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(20);
      if (await page.locator(".error-fallback").count()) break;
    }

    await expect(page.locator(".error-fallback"), "error boundary caught a crash").toHaveCount(0);
    const depthLoop = errors.filter((e) => /Maximum update depth|error #185/i.test(e));
    expect(depthLoop, `page errors:\n${errors.slice(0, 3).join("\n")}`).toHaveLength(0);
    // Under a deliberately wrong row height the window cannot also be expected
    // to land precisely; that half of the contract is asserted on an
    // unmanipulated list in `virtual-scroll-loop.spec.ts`.
    expect(await page.locator(".tools-issue").count()).toBeGreaterThan(0);
  });
}
