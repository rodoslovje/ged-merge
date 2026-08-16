import { test, expect, type Locator } from "@playwright/test";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "./tmpdir";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(__dirname, "../src/__fixtures__/corpus/reunion-5.5.1-utf8.ged");

/** A minimal GEDCOM with a legacy `WWW` link (pre-dating the "Add Source"
 * feature) on @I1@'s BIRT event, for tests of editing such links. */
function writeLegacyLinkFixture(url: string): string {
  const ged = [
    "0 HEAD",
    "1 GEDC",
    "2 VERS 5.5.1",
    "0 @I1@ INDI",
    "1 NAME Janez /Novak/",
    "1 SEX M",
    "1 BIRT",
    "2 DATE 1 JAN 1900",
    `2 WWW ${url}`,
    "0 TRLR",
    "",
  ].join("\n");
  const filePath = path.join(tmpdir(), `legacy-link-${Date.now()}.ged`);
  writeFileSync(filePath, ged, "utf-8");
  return filePath;
}

/** Pick an entry from an app-styled DropdownMenu: click the trigger, then the
 * portalled menu item carrying the wanted value. Any in-progress field edit is
 * blurred first — its blur-commit remounts the event row, which would unmount
 * a menu opened in the same click. */
async function pickMenu(trigger: Locator, value: string) {
  const page = trigger.page();
  await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) el.blur();
  });
  await trigger.click();
  await page.locator(`.dd-menu .dd-item[data-value="${value}"]`).click();
}

/** Open an event row's "+ Add" menu and pick a detail. The pointer parks on
 * the row's label cell first: the collapsed chip expands on row hover, and
 * hovering the chip's own (moving) spot makes it flicker under the cursor. */
async function addEventDetail(row: Locator, key: string) {
  await row.locator(".edit-event-type-row").hover();
  await pickMenu(row.locator(".edit-event-addfield"), key);
}

/** Fill an event field, first adding it via the event's "+ Add" menu when it
 * isn't already shown (place/address/etc. only render once they have a value). */
async function setEventField(row: Locator, cls: string, key: string, value: string) {
  const input = row.locator(`.${cls}`).first();
  if (!(await input.isVisible())) {
    await addEventDetail(row, key);
  }
  await input.fill(value);
}

test("edit mode: name, sex and event fields are editable and exportable", async ({ page }) => {
  await page.goto("/");

  await page.locator('input.file-input').first().setInputFiles(SAMPLE);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  const saveBtn = page.locator(".app-head-actions .export-btn");
  await expect(saveBtn).toHaveCount(0);

  const given = page.locator(".edit-name-input").first();
  const surname = page.locator(".edit-name-input").nth(1);
  const oldGiven = await given.inputValue();
  await given.fill(`${oldGiven} TEST`);
  await surname.click(); // blur

  await pickMenu(page.locator(".sex-select"), "M");

  const birth = page.locator(".edit-event").first();
  await birth.locator(".edit-event-date").fill("1 JAN 1900");
  // Place, address and sources are added on demand from the event's "+ Add"
  // menu when the event doesn't already have them.
  await setEventField(birth, "edit-event-place", "place", "Ljubljana, Slovenija");
  await setEventField(birth, "edit-event-addr", "addr", "Glavni trg 1");
  await addEventDetail(birth, "source");
  const sourceDialog = page.locator(".add-source-dialog");
  await sourceDialog.locator(".add-source-textarea").fill("https://example.com/test");
  await sourceDialog.getByRole("button", { name: "Add source", exact: true }).click();

  await expect(saveBtn).toBeEnabled();
  await saveBtn.click();

  const confirmBtn = page.locator(".preview-actions .export-btn");
  // Save downloads both the .ged and a .report.txt; only the .ged matters here.
  const downloadPromise = page.waitForEvent("download", (d) => d.suggestedFilename().endsWith(".ged"));
  await confirmBtn.click();
  const download = await downloadPromise;
  const filePath = await download.path();
  const content = readFileSync(filePath!, "utf-8");

  expect(content).toContain(`${oldGiven} TEST`);
  expect(content).toContain("1 JAN 1900");
  expect(content).toContain("Ljubljana, Slovenija");
  expect(content).toContain("Glavni trg 1");
  expect(content).toContain("https://example.com/test");
});

test("edit mode: the event-type ▾ and the + Add menu are keyboard-operable", async ({ page }) => {
  await page.goto("/");

  await page.locator('input.file-input').first().setInputFiles(SAMPLE);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  // Use the first event that actually has a type dropdown (not every event is
  // reassignable/removable, e.g. a bare birth).
  const ev = page.locator(".edit-event", { has: page.locator(".edit-event-label--select") }).first();

  // The event-type menu (a DropdownMenu on the label) can be focused and
  // opened from the keyboard — this is what drives changing the type /
  // removing the event without a mouse.
  const typeBtn = ev.locator(".edit-event-label--select");
  await typeBtn.focus();
  await expect(typeBtn).toBeFocused();
  await typeBtn.press("Enter");
  // Its menu includes the "Remove this event" entry.
  await expect(page.locator(".dd-menu .dd-item", { hasText: "Remove this event" })).toHaveCount(1);
  await page.keyboard.press("Escape");

  // The + Add menu is reachable and operable from the keyboard, and the field
  // it adds receives focus so editing continues on the keyboard.
  const addBtn = ev.locator(".edit-event-addfield");
  await addBtn.focus();
  await expect(addBtn).toBeFocused();
  await addBtn.press("Enter");
  await page.locator('.dd-menu .dd-item[data-value="cause"]').click();
  await expect(ev.locator('[data-detail="cause"] input')).toBeFocused();
});

test("edit mode: family marriage fields are editable and exportable", async ({ page }) => {
  await page.goto("/");

  await page.locator('input.file-input').first().setInputFiles(SAMPLE);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  const marriage = page.locator(".edit-family .edit-event").first();
  await marriage.locator(".edit-event-date").fill("3 MAR 1999");
  await setEventField(marriage, "edit-event-place", "place", "Maribor, Slovenija");
  await setEventField(marriage, "edit-event-addr", "addr", "Trg 5");
  await addEventDetail(marriage, "source");
  const sourceDialog = page.locator(".add-source-dialog");
  await sourceDialog.locator(".add-source-textarea").fill("https://example.com/marr");
  await sourceDialog.getByRole("button", { name: "Add source", exact: true }).click();

  const saveBtn = page.locator(".app-head-actions .export-btn");
  await expect(saveBtn).toBeEnabled();
  await saveBtn.click();

  const confirmBtn = page.locator(".preview-actions .export-btn");
  // Save downloads both the .ged and a .report.txt; only the .ged matters here.
  const downloadPromise = page.waitForEvent("download", (d) => d.suggestedFilename().endsWith(".ged"));
  await confirmBtn.click();
  const download = await downloadPromise;
  const filePath = await download.path();
  const content = readFileSync(filePath!, "utf-8");

  expect(content).toContain("3 MAR 1999");
  expect(content).toContain("Maribor, Slovenija");
  expect(content).toContain("Trg 5");
  expect(content).toContain("https://example.com/marr");
});

test("edit mode: undoing a removed source citation restores its title, not just a bare link", async ({ page }) => {
  await page.goto("/");

  await page.locator('input.file-input').first().setInputFiles(SAMPLE);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  // Add a titled source citation at the person level.
  await page.locator(".edit-name-chip-add", { hasText: "Add Source" }).first().click();
  const dialog = page.locator(".add-source-dialog");
  await dialog.locator(".add-source-textarea").fill(
    "Marta Rendla, »Jožef Celar«, Smrtne žrtve (Ljubljana: INZ, 2026), https://www.sistory.si/ww2/TEST-CASE",
  );
  await dialog.getByRole("button", { name: "Add source", exact: true }).click();

  await expect(page.locator(".source-ref").first()).toHaveClass(/source-ref--book/);

  // Remove it (via the Edit Source dialog), then undo — the citation (and
  // its title) should come back, not a dangling pointer rendered as a bare 🔗.
  await page.locator(".source-ref").first().click();
  const editDialog = page.locator(".add-source-dialog");
  await editDialog.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.locator(".source-ref")).toHaveCount(0);

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(".source-ref").first()).toHaveClass(/source-ref--book/);
});

test("edit mode: clicking a source citation opens an editable dialog, prefilled, and Save updates it", async ({ page }) => {
  await page.goto("/");

  await page.locator('input.file-input').first().setInputFiles(SAMPLE);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  await page.locator(".edit-name-chip-add", { hasText: "Add Source" }).first().click();
  const addDialog = page.locator(".add-source-dialog");
  await addDialog.locator(".add-source-textarea").fill(
    "Marta Rendla, »Jožef Celar«, Smrtne žrtve (Ljubljana: INZ, 2026), https://www.sistory.si/ww2/ORIGINAL",
  );
  await addDialog.getByRole("button", { name: "Add source", exact: true }).click();

  // Clicking the icon opens an edit dialog instead of navigating away.
  await page.locator(".source-ref").first().click();
  const editDialog = page.locator(".add-source-dialog");
  await expect(editDialog.getByRole("heading", { name: "Edit Source" })).toBeVisible();
  await expect(editDialog.getByLabel("Title")).toHaveValue(/Jožef Celar/);
  await expect(editDialog.getByLabel("URL")).toHaveValue("https://www.sistory.si/ww2/ORIGINAL");

  await editDialog.getByLabel("Title").fill("Updated Title");
  await editDialog.getByLabel("URL").fill("https://www.sistory.si/ww2/UPDATED");
  await editDialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editDialog).toHaveCount(0);

  await expect(page.locator(".source-ref").first()).toHaveAttribute("title", /Updated Title/);

  // Re-opening confirms the save actually persisted to the dataset, not just the icon's tooltip.
  await page.locator(".source-ref").first().click();
  await expect(page.locator(".add-source-dialog").getByLabel("Title")).toHaveValue("Updated Title");
  await expect(page.locator(".add-source-dialog").getByLabel("URL")).toHaveValue("https://www.sistory.si/ww2/UPDATED");
});

test("edit mode: a legacy link opens the Edit Source dialog prefilled with just the URL; saving without other fields keeps it a plain link", async ({ page }) => {
  const fixture = writeLegacyLinkFixture("https://example.com/legacy-original");
  await page.goto("/");
  await page.locator('input.file-input').first().setInputFiles(fixture);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  const linkIcon = page.locator(".edit-link-icon").first();
  await linkIcon.click();
  const dialog = page.locator(".add-source-dialog");
  await expect(dialog.getByRole("heading", { name: "Edit Source" })).toBeVisible();
  await expect(dialog.getByLabel("URL")).toHaveValue("https://example.com/legacy-original");
  await expect(dialog.getByLabel("Title")).toHaveValue("");

  await dialog.getByLabel("URL").fill("https://example.com/legacy-renamed");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  // Still a plain link icon, not promoted to a source citation.
  await expect(page.locator(".source-ref")).toHaveCount(0);
  await expect(page.locator(".edit-link-icon").first()).toHaveAttribute("title", "https://example.com/legacy-renamed");

  // Remove it via the same dialog.
  await page.locator(".edit-link-icon").first().click();
  await page.locator(".add-source-dialog").getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.locator(".edit-link-icon")).toHaveCount(0);
});

test("edit mode: filling in a title while editing a legacy link promotes it to a real Source citation", async ({ page }) => {
  const fixture = writeLegacyLinkFixture("https://example.com/legacy-promote");
  await page.goto("/");
  await page.locator('input.file-input').first().setInputFiles(fixture);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  await page.locator(".edit-link-icon").first().click();
  const dialog = page.locator(".add-source-dialog");
  await dialog.getByLabel("Title").fill("Promoted Source");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  await expect(page.locator(".edit-link-icon")).toHaveCount(0);
  const sourceRef = page.locator(".source-ref").first();
  await expect(sourceRef).toHaveClass(/source-ref--book/);

  await sourceRef.click();
  await expect(page.locator(".add-source-dialog").getByLabel("Title")).toHaveValue("Promoted Source");
  await expect(page.locator(".add-source-dialog").getByLabel("URL")).toHaveValue("https://example.com/legacy-promote");
});
