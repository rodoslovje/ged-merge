import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(__dirname, "../src/__fixtures__/corpus/reunion-5.5.1-utf8.ged");

/** Class of the field the keyboard is in. */
function focusedField(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    return a?.className.split(/\s+/).find((c) => c.startsWith("edit-event-")) ?? a?.tagName ?? "none";
  });
}

async function openEdit(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(SAMPLE);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();
}

// A typical event is a date and a place. Both used to need the "+ Add" menu
// after the first field, because an empty place is hidden and the tab order
// skips it — so Enter now walks the fields an event is actually filled in.
test("Enter walks a date event from its date to its place", async ({ page }) => {
  await openEdit(page);
  await page.getByRole("button", { name: /^\+ Residence$/ }).click();
  expect(await focusedField(page)).toBe("edit-event-date");

  await page.keyboard.type("1 JAN 1900");
  await page.keyboard.press("Enter");
  expect(await focusedField(page)).toBe("edit-event-place");

  await page.keyboard.type("Ljubljana, Slovenija");
  // The place is the last of them, so Enter means what it does anywhere else:
  // commit, and hand the keyboard back to the app.
  await page.keyboard.press("Enter");
  expect(await focusedField(page)).toBe("BODY");
});

test("an event that leads with a value starts there, then date, then place", async ({ page }) => {
  await openEdit(page);
  await page.getByRole("button", { name: /^\+ Occupation$/ }).click();
  expect(await focusedField(page)).toBe("edit-event-value");

  await page.keyboard.type("Kmet");
  await page.keyboard.press("Enter");
  expect(await focusedField(page)).toBe("edit-event-date");

  await page.keyboard.type("1 JAN 1900");
  await page.keyboard.press("Enter");
  expect(await focusedField(page)).toBe("edit-event-place");
});

test("everything typed along the way is written", async ({ page }) => {
  await openEdit(page);
  await page.getByRole("button", { name: /^\+ Occupation$/ }).click();
  await page.keyboard.type("Kmet");
  await page.keyboard.press("Enter");
  await page.keyboard.type("1 JAN 1900");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Ljubljana, Slovenija");
  await page.keyboard.press("Enter");

  await page.locator(".app-head-actions .export-btn").click();
  const download = page.waitForEvent("download", (d) => d.suggestedFilename().endsWith(".ged"));
  await page.locator(".preview-actions .export-btn").click();
  const ged = readFileSync((await (await download).path())!, "utf-8");

  // The file keeps its own line endings, so read it back the way it was written.
  const lines = ged.split(/\r\n|\r|\n/);
  const occu = lines.findIndex((l) => l === "1 OCCU Kmet");
  expect(occu).toBeGreaterThan(-1);
  expect(lines.slice(occu + 1, occu + 3)).toEqual(["2 DATE 1 JAN 1900", "2 PLAC Ljubljana, Slovenija"]);
});
