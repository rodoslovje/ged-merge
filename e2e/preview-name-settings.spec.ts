import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

/**
 * The save preview's card heads took the name the change report wrote, which is
 * built by the merge (and in the worker) and so knows nothing of the Name
 * display settings. A woman recorded under her given name with a married
 * surname beside it came up as "Frances" alone — the surname the rest of the
 * app shows her by simply missing from the last screen before the file is
 * written.
 */
function writeFixture(): string {
  const ged = [
    "0 HEAD",
    "1 GEDC",
    "2 VERS 5.5.1",
    "1 CHAR UTF-8",
    "0 @I1@ INDI",
    "1 NAME Frances //",
    "2 _MARNM Simonitsch",
    "1 SEX F",
    "1 BIRT",
    "2 DATE 10 MAR 1889",
    "0 TRLR",
    "",
  ].join("\n");
  const filePath = path.join(tmpdir(), `preview-name-${Date.now()}.ged`);
  writeFileSync(filePath, ged, "utf-8");
  return filePath;
}

test("the save preview names a person the way the Name settings do", async ({ page }) => {
  const fixture = writeFixture();
  await page.addInitScript(() => {
    localStorage.setItem("gedmerge.settings", JSON.stringify({ marriedSurname: true }));
  });
  await page.goto("/");

  await page.locator("input.file-input").first().setInputFiles(fixture);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  // Any change at all puts her card in the preview.
  await page.getByRole("button", { name: "+ Add Note" }).first().click();
  const note = page.locator(".edit-note-chip [contenteditable]").first();
  await note.fill("Buried at Holy Hope Cemetery");
  await note.blur(); // the chip writes to the record when it loses focus

  const save = page.locator(".app-head-actions .export-btn");
  await expect(save).toBeVisible();
  await save.click();
  const head = page.locator(".preview-card-head").first();
  await expect(head).toContainText("Frances (Simonitsch)");
});
