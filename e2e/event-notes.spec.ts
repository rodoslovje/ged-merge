import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "fs";
import os from "os";
import path from "path";

/** A birth carrying two notes — the second is the one the editor used to hide. */
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
    "2 NOTE first note",
    "2 NOTE second note",
    "0 TRLR",
    "",
  ].join("\n");
  const filePath = path.join(os.tmpdir(), `event-notes-${Date.now()}.ged`);
  writeFileSync(filePath, ged, "utf-8");
  return filePath;
}

test("edit mode: every note on an event is shown, editable and saved", async ({ page }) => {
  const fixture = writeFixture();
  await page.goto("/");

  await page.locator("input.file-input").first().setInputFiles(fixture);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  // Both notes are on screen — the second used to be invisible here.
  const chips = page.locator(".edit-event .edit-note-chip textarea");
  await expect(chips).toHaveCount(2);
  await expect(chips.nth(0)).toHaveValue("first note");
  await expect(chips.nth(1)).toHaveValue("second note");

  // Each carries its own lock: flag the second, leave the first alone.
  await page.locator(".edit-event .edit-note-chip .note-chip-lock").nth(1).click();

  // Editing the first must not disturb the second.
  await chips.nth(0).fill("first note, corrected");
  await chips.nth(1).click(); // blur-commit

  await page.locator(".app-head-actions .export-btn").click();
  const downloadPromise = page.waitForEvent("download", (d) => d.suggestedFilename().endsWith(".ged"));
  await page.locator(".preview-actions .export-btn").click();
  const content = readFileSync((await (await downloadPromise).path())!, "utf-8");

  expect(content).toContain("2 NOTE first note, corrected");
  expect(content).toMatch(/2 NOTE second note\r?\n3 (RESN privacy|PRIV|_PRIV Y)/);
});
