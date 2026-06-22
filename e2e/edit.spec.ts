import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(__dirname, "../test-data/Senen.ged");

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
  const filePath = path.join(os.tmpdir(), `legacy-link-${Date.now()}.ged`);
  writeFileSync(filePath, ged, "utf-8");
  return filePath;
}

test("edit mode: name, sex and event fields are editable and exportable", async ({ page }) => {
  await page.goto("/");

  await page.locator('input[type="file"]').first().setInputFiles(SAMPLE);
  await page.getByRole("button", { name: "Edit" }).click();
  await page.locator(".edit-person").waitFor();

  const exportBtn = page.locator(".edit-toolbar button", { hasText: "Export" });
  await expect(exportBtn).toBeDisabled();

  const given = page.locator(".edit-name-input").first();
  const surname = page.locator(".edit-name-input").nth(1);
  const oldGiven = await given.inputValue();
  await given.fill(`${oldGiven} TEST`);
  await surname.click(); // blur

  await page.locator(".sex-toggle-btn", { hasText: "M" }).click();

  const birth = page.locator(".edit-event").first();
  await birth.locator(".edit-event-date").fill("1 JAN 1900");
  await birth.locator(".edit-event-place").fill("Ljubljana, Slovenija");
  await birth.locator(".edit-event-addr").fill("Glavni trg 1");
  await birth.locator(".edit-event-toggle").click();
  await birth.locator(".edit-link-add").click();
  const sourceDialog = page.locator(".add-source-dialog");
  await sourceDialog.locator(".add-source-textarea").fill("https://example.com/test");
  await sourceDialog.getByRole("button", { name: "Add", exact: true }).click();

  await expect(exportBtn).toBeEnabled();

  const downloadPromise = page.waitForEvent("download");
  await exportBtn.click();
  const download = await downloadPromise;
  const filePath = await download.path();
  const content = readFileSync(filePath!, "utf-8");

  expect(content).toContain(`${oldGiven} TEST`);
  expect(content).toContain("1 JAN 1900");
  expect(content).toContain("Ljubljana, Slovenija");
  expect(content).toContain("Glavni trg 1");
  expect(content).toContain("https://example.com/test");
});

test("edit mode: family marriage fields are editable and exportable", async ({ page }) => {
  await page.goto("/");

  await page.locator('input[type="file"]').first().setInputFiles(SAMPLE);
  await page.getByRole("button", { name: "Edit" }).click();
  await page.locator(".edit-person").waitFor();

  const marriage = page.locator(".edit-family .edit-event").first();
  await marriage.locator(".edit-event-date").fill("3 MAR 1999");
  await marriage.locator(".edit-event-place").fill("Maribor, Slovenija");
  await marriage.locator(".edit-event-addr").fill("Trg 5");
  await marriage.locator(".edit-event-toggle").click();
  await marriage.locator(".edit-event-extra-sources .edit-link-add").click();
  const sourceDialog = page.locator(".add-source-dialog");
  await sourceDialog.locator(".add-source-textarea").fill("https://example.com/marr");
  await sourceDialog.getByRole("button", { name: "Add", exact: true }).click();

  const exportBtn = page.locator(".edit-toolbar button", { hasText: "Export" });
  await expect(exportBtn).toBeEnabled();

  const downloadPromise = page.waitForEvent("download");
  await exportBtn.click();
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

  await page.locator('input[type="file"]').first().setInputFiles(SAMPLE);
  await page.getByRole("button", { name: "Edit" }).click();
  await page.locator(".edit-person").waitFor();

  // Add a titled source citation at the person level.
  await page.locator(".edit-name-chip-add", { hasText: "Add Source" }).first().click();
  const dialog = page.locator(".add-source-dialog");
  await dialog.locator(".add-source-textarea").fill(
    "Marta Rendla, »Jožef Celar«, Smrtne žrtve (Ljubljana: INZ, 2026), https://www.sistory.si/ww2/TEST-CASE",
  );
  await dialog.getByRole("button", { name: "Add", exact: true }).click();

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

  await page.locator('input[type="file"]').first().setInputFiles(SAMPLE);
  await page.getByRole("button", { name: "Edit" }).click();
  await page.locator(".edit-person").waitFor();

  await page.locator(".edit-name-chip-add", { hasText: "Add Source" }).first().click();
  const addDialog = page.locator(".add-source-dialog");
  await addDialog.locator(".add-source-textarea").fill(
    "Marta Rendla, »Jožef Celar«, Smrtne žrtve (Ljubljana: INZ, 2026), https://www.sistory.si/ww2/ORIGINAL",
  );
  await addDialog.getByRole("button", { name: "Add", exact: true }).click();

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
  await page.locator('input[type="file"]').first().setInputFiles(fixture);
  await page.getByRole("button", { name: "Edit" }).click();
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
  await page.locator('input[type="file"]').first().setInputFiles(fixture);
  await page.getByRole("button", { name: "Edit" }).click();
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
