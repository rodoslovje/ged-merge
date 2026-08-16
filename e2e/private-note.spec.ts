import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

/** A daughter and her father, so the test can walk to a relative's card and
 *  come back — which rebuilds the editor from the record. */
function writeFixture(): string {
  const ged = [
    "0 HEAD",
    "1 GEDC",
    "2 VERS 5.5.1",
    "1 CHAR UTF-8",
    "0 @I1@ INDI",
    "1 NAME Tatjana /Dolenc/",
    "1 SEX F",
    "1 BIRT",
    "2 DATE 21 AUG 1991",
    "1 FAMC @F1@",
    "0 @I2@ INDI",
    "1 NAME Janez /Dolenc/",
    "1 SEX M",
    "1 FAMS @F1@",
    "0 @F1@ FAM",
    "1 HUSB @I2@",
    "1 CHIL @I1@",
    "0 TRLR",
    "",
  ].join("\n");
  const filePath = path.join(tmpdir(), `private-note-${Date.now()}.ged`);
  writeFileSync(filePath, ged, "utf-8");
  return filePath;
}

/**
 * A note marked private kept its 🔒 only in the notes editor's own state: the
 * commit rebuilt an inline note as `{ text }`, so the flag never reached the
 * record. Leaving the person and coming back read the record again and the
 * lock was gone — and the saved file carried no privacy marker either.
 */
test("edit mode: a note marked private stays private across navigation and save", async ({ page }) => {
  const fixture = writeFixture();
  await page.goto("/");

  await page.locator("input.file-input").first().setInputFiles(fixture);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  // Add a note and mark it private.
  await page.getByRole("button", { name: "+ Add Note" }).first().click();
  const noteBox = page.locator(".edit-note-chip textarea").first();
  await noteBox.fill("https://web.facebook.com/tatjana.dolenc");
  const lock = page.locator(".edit-note-chip .note-chip-lock").first();
  await lock.click();
  await expect(lock).toHaveAttribute("aria-pressed", "true");

  // Leave the person and come back — the editor rebuilds from the record, so
  // anything not written to it is lost here.
  const shownName = page.locator(".edit-person .edit-name-input").first();
  await page.locator(".person-card").filter({ hasNot: page.locator(".person-card-add") }).first().click();
  await expect(shownName).toHaveValue("Janez");
  await page.goBack();
  await expect(shownName).toHaveValue("Tatjana");

  const lockAgain = page.locator(".edit-note-chip .note-chip-lock").first();
  await expect(lockAgain).toHaveAttribute("aria-pressed", "true");

  // And the marker reaches the file, in the dialect the file uses.
  await page.locator(".app-head-actions .export-btn").click();
  const downloadPromise = page.waitForEvent("download", (d) => d.suggestedFilename().endsWith(".ged"));
  await page.locator(".preview-actions .export-btn").click();
  const download = await downloadPromise;
  const content = readFileSync((await download.path())!, "utf-8");

  expect(content).toContain("1 NOTE https://web.facebook.com/tatjana.dolenc");
  expect(content).toMatch(/1 NOTE https:\/\/web\.facebook\.com\/tatjana\.dolenc\r?\n2 (RESN privacy|PRIV|_PRIV Y)/);
});
