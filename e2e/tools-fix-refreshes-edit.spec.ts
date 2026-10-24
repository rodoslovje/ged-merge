import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

/** A 7.0 person whose birth and death lines carry text, which 7.0 allows only
 *  as Y — the health check moves each into a note on its own event. */
function writeFixture(): string {
  const ged = [
    "0 HEAD", "1 GEDC", "2 VERS 7.0",
    "0 @I1@ INDI", "1 NAME Ana /Novak/",
    "1 BIRT Kranj", "2 DATE 1900",
    "1 DEAT Ljubljana", "2 DATE 1950",
    "0 TRLR", "",
  ].join("\n");
  const filePath = path.join(tmpdir(), `tools-fix-edit-${Date.now()}.ged`);
  writeFileSync(filePath, ged, "utf-8");
  return filePath;
}

// Edit stays mounted behind Tools: a fix made there must show in Edit at once,
// each note on its own event — not the rows Edit painted before the fix.
test("a health-check fix shows in Edit on the events it changed", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(writeFixture());
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();
  const notes = page.locator(".edit-event .edit-note-chip [contenteditable]");
  await expect(notes).toHaveCount(0);

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByRole("tab", { name: /Health check/ }).click();
  await page.getByRole("button", { name: /Move event text into notes/ }).click();
  await page.getByRole("button", { name: "Apply fix" }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();

  const birth = page.locator(".edit-event").filter({ hasText: "Birth" }).first();
  const death = page.locator(".edit-event").filter({ hasText: "Death" }).first();
  await expect(birth.locator(".edit-note-chip [contenteditable]")).toHaveText(["Kranj"]);
  await expect(death.locator(".edit-note-chip [contenteditable]")).toHaveText(["Ljubljana"]);
  // The text left the death line: a value field still holding it would show
  // it twice, and write it back on the row's next edit.
  await expect(death.locator("input.edit-event-value")).toHaveValue("");
});
