import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

/**
 * What a save does to the file as GEDCOM rather than to any record: a file
 * missing its header and trailer leaves complete (HEAD, TRLR and the submitter
 * 5.5.1 requires), and a 5.5.1 file can be saved as GEDCOM 7.0 — from Tools →
 * Health check, with nothing in it changed.
 */

const HEADERLESS = [
  "0 @I1@ INDI",
  "1 NAME Ana /Novak/",
  "1 SEX F",
  "1 EMAIL ana@example.si",
  "",
].join("\n");

const V551 = [
  "0 HEAD",
  "1 GEDC",
  "2 VERS 5.5.1",
  "2 FORM LINEAGE-LINKED",
  "1 CHAR UTF-8",
  "0 @I1@ INDI",
  "1 NAME Ana /Novak/",
  "1 SEX F",
  "1 NOTE @N1@",
  "1 _UID 0123456789",
  "1 _UPD 1 JAN 2020",
  "1 BIRT",
  "2 DATE 12 JAN 1850",
  "0 @N1@ NOTE A note shared by the record",
  "0 TRLR",
  "",
].join("\n");

async function load(page: Page, name: string, text: string) {
  await page.goto("/");
  await page
    .locator("input.file-input")
    .first()
    .setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from(text, "utf-8") });
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Health check", { exact: true }).first().click();
}

/** Download from the open save preview and return the .ged's text. */
async function downloadGed(page: Page): Promise<string> {
  const ged = page.waitForEvent("download", (d) => d.suggestedFilename().endsWith(".ged"));
  await page.locator(".preview-actions .export-btn").click();
  return readFileSync((await (await ged).path())!, "utf-8");
}

test("a file without header or trailer saves complete: HEAD, TRLR and a submitter", async ({ page }) => {
  await load(page, "headerless.ged", HEADERLESS);
  // The health check says what the save will supply…
  await expect(page.locator(".tools-file-note").filter({ hasText: "no header" })).toBeVisible();
  await expect(page.locator(".tools-version")).toContainText("GEDCOM 5.5.1");

  // …and its button opens the save preview even though nothing was edited.
  await page.getByRole("button", { name: "Save as GEDCOM 7.0…" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // Back to the file's own version: only the repairs remain.
  await dialog.getByRole("tab", { name: "GEDCOM 5.5.1" }).click();
  await expect(dialog.locator(".preview-note").filter({ hasText: "no header" })).toBeVisible();
  await expect(dialog.locator(".preview-note").filter({ hasText: "submitter" })).toBeVisible();
  await expect(dialog.locator(".preview-actions .export-btn")).toBeEnabled();

  const text = await downloadGed(page);
  const lines = text.trimEnd().split("\n");
  expect(lines[0]).toBe("0 HEAD");
  expect(text).toContain("1 GEDC\n2 VERS 5.5.1\n2 FORM LINEAGE-LINKED\n1 CHAR UTF-8\n");
  expect(text).toContain("1 SUBM @U1@\n");
  expect(text).toContain("0 @U1@ SUBM\n1 NAME GED Merge\n0 TRLR\n");
  // An untouched line keeps the bare at-sign the file wrote.
  expect(text).toContain("1 EMAIL ana@example.si\n");
  expect(lines[lines.length - 1]).toBe("0 TRLR");
});

test("a 5.5.1 file saves as GEDCOM 7.0: version, UID, SCHMA, SNOTE", async ({ page }) => {
  await load(page, "v551.ged", V551);
  await page.getByRole("button", { name: "Save as GEDCOM 7.0…" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("tab", { name: "GEDCOM 7.0" })).toHaveAttribute("aria-selected", "true");
  await expect(dialog.locator(".preview-note").filter({ hasText: "converted from GEDCOM 5.5.1 to GEDCOM 7.0" })).toBeVisible();
  await dialog.locator(".preview-conversion summary").click();
  await expect(dialog.locator(".preview-conversion")).toContainText("SNOTE");

  const text = await downloadGed(page);
  // _UID has a 7.0 form and takes it; _UPD has none and is declared with its page.
  expect(text.startsWith("0 HEAD\n1 GEDC\n2 VERS 7.0\n1 SCHMA\n2 TAG _UPD https://gedmerge.com/terms/myheritage/_UPD\n")).toBe(true);
  expect(text).toContain("1 UID 0123456789\n");
  expect(text).not.toContain("FORM LINEAGE-LINKED");
  expect(text).not.toContain("1 CHAR");
  expect(text).toContain("1 SNOTE @N1@\n");
  expect(text).toContain("0 @N1@ SNOTE A note shared by the record\n");
  expect(text).not.toContain(" SUBM");

  // The open file now is the saved one: the health check reads 7.0.
  await expect(page.locator(".tools-version")).toContainText("GEDCOM 7.0");
});
