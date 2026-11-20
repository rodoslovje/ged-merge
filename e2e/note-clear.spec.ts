import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

function writeFixture(): string {
  const ged = [
    "0 HEAD",
    "1 GEDC",
    "2 VERS 5.5.1",
    "1 CHAR UTF-8",
    "0 @I1@ INDI",
    "1 NAME Tatjana /Dolenc/",
    "1 SEX F",
    "1 NOTE first note",
    "1 NOTE second note",
    "0 TRLR",
    "",
  ].join("\n");
  const filePath = path.join(tmpdir(), `note-clear-${Date.now()}.ged`);
  writeFileSync(filePath, ged, "utf-8");
  return filePath;
}

// Note boxes are kept by position, and a box with the caret in it kept its own
// text: removing the note being edited left its box showing the removed text
// over the note that had moved up into its place, and the next keystroke wrote
// the removed note back over the one that stayed.
test("removing the note being edited leaves the next note in its box, and typing edits that one", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(writeFixture());
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  const chips = page.locator(".edit-note-chip [contenteditable]");
  await expect(chips).toHaveCount(2);
  await chips.nth(0).click();
  await page.locator(".edit-note-chip").nth(0).locator(".input-clear").click();

  await expect(chips).toHaveCount(1);
  await expect(chips.nth(0)).toHaveText("second note");

  // The caret is still in the box: what is typed goes into the note shown.
  await chips.nth(0).evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await page.keyboard.type(" kept");
  await page.locator(".edit-name-input").first().click(); // blur-commit

  await expect(chips).toHaveCount(1);
  await expect(chips.nth(0)).toHaveText("second note kept");
});
