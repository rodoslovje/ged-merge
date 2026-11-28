import { test, expect } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAMILY = path.resolve(__dirname, "../src/__fixtures__/calendar-family.ged");

// The Charts hub's Calendar: a wizard from the settings through the cover and
// the twelve months to a review of every page, seen from the hub's root.
test("the family calendar walks from settings to a review of every page", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FAMILY);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();
  await page.locator(".charts-open-btn").click();
  await page.getByRole("tab", { name: "Calendar" }).click();

  // Settings, with a month previewed beside them. The list of the month's
  // people under the month is off until asked for.
  await expect(page.locator(".cal-step-label .select-menu-value")).toHaveText("Settings");
  await expect(page.locator(".cal-preview .cal-list")).toHaveCount(0);
  await page.getByLabel("List of the month's people under the month").check();
  await expect(page.locator(".cal-preview .cal-grid")).toHaveCount(1);
  // Name days are asked for: the relatives' own, and the saints of every day.
  await expect(page.locator(".cal-preview .cal-saint")).toHaveCount(0);
  await page.getByLabel("Relatives' name days").check();
  await page.getByLabel("Saints' names on every day").check();

  // The cover draws the recipient's fan by default.
  const next = page.getByRole("button", { name: "Next page", exact: true });
  await next.click();
  await expect(page.locator(".cal-preview .cal-chart svg")).toHaveCount(1);
  await page.getByLabel("Dedication").fill("For Ana, with love");
  await expect(page.locator(".cal-preview .cal-dedication")).toHaveText("For Ana, with love");
  // The cover carries the calendar's own name until the givers type theirs.
  await expect(page.locator(".cal-preview .cal-cover-title")).toHaveText("Family calendar");
  await page.getByLabel("Title", { exact: true }).fill("The Novak year");
  await expect(page.locator(".cal-preview .cal-cover-title")).toHaveText("The Novak year");

  // March: the recipient's own birthday, and her mother's as a relative's line.
  for (let i = 0; i < 3; i++) await next.click();
  await expect(page.locator(".cal-step-label .select-menu-value")).toHaveText(/^March/);
  await expect(page.locator(".cal-preview .cal-list")).toContainText("Marija K., mother (65)"); // the living by the default "Given name and surname initial"
  // St Joseph's stands beside the 19th.
  await expect(page.locator('.cal-preview .cal-cell[data-day="19"] .cal-saint')).toHaveText("Jožef");
  // Every week is as tall as the others, however busy its days.
  const heights = await page.locator(".cal-preview .cal-grid tbody tr").evaluateAll((rows) => rows.map((r) => r.getBoundingClientRect().height));
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);

  // June offers the grandfather's birth, wedding and death; the centenary of
  // his death is picked, and the wedding can be added beside it.
  for (let i = 0; i < 3; i++) await next.click();
  await expect(page.locator(".cal-fact-list input")).toHaveCount(3);
  // Uncle Peter keeps his name day on Sts Peter and Paul's.
  await expect(page.locator('.cal-preview .cal-cell[data-day="29"] .cal-nameday')).toContainText("Peter");
  await expect(page.locator(".cal-preview .cal-fact")).toHaveCount(1);
  await expect(page.locator(".cal-preview .cal-fact")).toContainText("100 years ago");
  await page.getByRole("checkbox", { name: /were married/ }).check();
  await expect(page.locator(".cal-preview .cal-fact")).toHaveCount(2);

  // Review: the cover, twelve months and the back page — the year at a glance
  // with its signature — one page each in the default format.
  await page.getByRole("button", { name: "Skip to review and print" }).click();
  await expect(page.locator(".cal-review .cal-page")).toHaveCount(14);
  // The paper is picked here, beside the pages — the format only fixed their
  // shape. A wall calendar hung by its top edge starts on A3; a smaller paper
  // can be picked instead.
  const paper = page.locator(".cal-print-panel");
  await expect(paper.locator(".sheet-dialog-count")).toContainText("297 × 420 mm");
  await paper.getByRole("button", { name: "A4", exact: true }).click();
  await expect(paper.locator(".sheet-dialog-count")).toContainText("210 × 297 mm · at 100% size");
  // Printing spins on the button while the document is built, and stops.
  const print = page.locator(".cal-print-btn");
  await print.click();
  await expect(print).toBeEnabled();
  await expect(print.locator(".spinner")).toHaveCount(0);
  await page.getByRole("button", { name: "Previous page", exact: true }).click();
  await expect(page.locator(".cal-step-label .select-menu-value")).toHaveText("Back page");
  await expect(page.locator(".cal-preview .cal-overview")).toContainText("Marija");
  await page.getByLabel("Signature").fill("From all of us");
  await expect(page.locator(".cal-preview .cal-signature")).toHaveText("From all of us");
  // A chart on the back page is titled by its name.
  const backKind = page.locator(".cal-field", { hasText: "What the back page shows" }).locator(".select-menu");
  await backKind.click();
  await page.locator('.dd-menu .dd-item[data-value="fanDesc"]').click();
  await expect(page.locator(".cal-preview .cal-back-title")).toHaveText("Fan of descendants");
  // No back page: the review has the cover and the months alone.
  await backKind.click();
  await page.locator('.dd-menu .dd-item[data-value="none"]').click();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.locator(".cal-review .cal-page")).toHaveCount(13);
  // The page name is a menu of every page: one step back to the settings.
  await page.locator(".cal-step-label .select-menu").click();
  await page.locator('.dd-menu .dd-item[data-value="0"]').click();
  await expect(page.locator(".cal-step-label .select-menu-value")).toHaveText("Settings");
});

// With the workspace kept in the browser, the calendar's work comes back after
// leaving the kind; without it, the wizard says how to keep it.
test("the calendar's work is kept while the workspace is", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("gedmerge.settings", JSON.stringify({ persistWorkspace: true })));
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FAMILY);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();
  await page.locator(".charts-open-btn").click();
  await page.getByRole("tab", { name: "Calendar" }).click();
  await expect(page.locator(".cal-panel")).not.toContainText("Remember my work");
  await page.getByRole("radio", { name: /Sea/ }).click();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await page.getByLabel("Dedication").fill("For Ana");

  await page.getByRole("tab", { name: "Tree" }).click();
  await page.getByRole("tab", { name: "Calendar" }).click();
  await expect(page.getByRole("radio", { name: /Sea/ })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.getByLabel("Dedication")).toHaveValue("For Ana");
});

test("without a kept workspace the wizard says how to keep the work", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FAMILY);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();
  await page.locator(".charts-open-btn").click();
  await page.getByRole("tab", { name: "Calendar" }).click();
  await expect(page.locator(".cal-panel")).toContainText("Remember my work in this browser");
});

// A day with more names than its cell holds says how many it leaves out, and
// the wizard says so beside the page: nothing is cut off unseen.
test("a day too busy for its cell marks what it leaves out", async ({ page }) => {
  const lines = ["0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8", "0 @I1@ INDI", "1 NAME Ana /Novak/", "1 SEX F", "1 BIRT", "2 DATE 14 MAR 1950", "1 FAMS @F1@"];
  const children = Array.from({ length: 30 }, (_, i) => `@I${i + 2}@`);
  children.forEach((id, i) => lines.push(`0 ${id} INDI`, `1 NAME Maksimilijan${i} /Novak/`, "1 SEX M", "1 BIRT", `2 DATE 14 MAR ${1975 + i}`, "1 FAMC @F1@"));
  lines.push("0 @F1@ FAM", "1 WIFE @I1@", ...children.map((id) => `1 CHIL ${id}`), "0 TRLR");
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles({ name: "busy.ged", mimeType: "text/plain", buffer: Buffer.from(lines.join("\n") + "\n") });
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();
  await page.locator(".charts-open-btn").click();
  await page.getByRole("tab", { name: "Calendar" }).click();
  await page.getByRole("button", { name: "Skip to review and print" }).click();

  const march = page.locator(".cal-review .cal-review-month").nth(2);
  await expect(march.locator(".cal-more")).toHaveCount(1);
  await expect(page.locator(".cal-tight")).toContainText("more names than fit");
  // Its birthdays run together as one list of names before any is left out
  // — a birthday carries no mark anywhere, a round one its star. What is
  // drawn fits its cell, the "+N" included.
  const day = march.locator(".cal-cell[data-day='14']");
  await expect(day.locator(".cal-compact")).toContainText(/Ana N\. \d+, Maksimilijan0 N\. \d+/);
  await expect(day).not.toContainText("*");
  await expect(day.locator(".cal-round-name").first()).toContainText("★");
  await expect(async () => {
    const over = await march.locator(".cal-cell").evaluateAll((cells) => cells.filter((c) => c.scrollHeight > c.clientHeight + 1).length);
    expect(over).toBe(0);
    const drawn = await day.locator(".cal-compact > span").count();
    expect(drawn).toBeGreaterThan(1);
    expect(await march.locator(".cal-more").textContent()).toBe(`+${31 - drawn}`);
  }).toPass();
});

// The preview zooms with the charts' buttons and keys: the page grows past
// the pane, which scrolls by itself while the panel stays put.
test("the calendar's preview zooms in and out", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FAMILY);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();
  await page.locator(".charts-open-btn").click();
  await page.getByRole("tab", { name: "Calendar" }).click();

  const sheet = page.locator(".cal-preview > .cal-sheet");
  const pct = page.locator(".cal-preview-wrap .tree-zoom-pct");
  await expect(pct).toHaveValue("100%");
  const width = () => sheet.evaluate((el) => el.getBoundingClientRect().width);
  const base = await width();

  await page.getByRole("button", { name: "Zoom in (+)" }).click();
  await expect(pct).toHaveValue("125%");
  await expect.poll(width).toBeCloseTo(base * 1.25, 0);
  await page.keyboard.press("-");
  await page.keyboard.press("-");
  await expect(pct).toHaveValue("80%");
  await expect.poll(width).toBeCloseTo(base * 0.8, 0);

  await pct.fill("200");
  await pct.press("Enter");
  await expect.poll(width).toBeCloseTo(base * 2, 0);
  await expect.poll(() => page.locator(".cal-preview").evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await page.keyboard.press("0");
  await expect(pct).toHaveValue("100%");
});
