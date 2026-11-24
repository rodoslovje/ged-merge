import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// A note written with formatting reads formatted in the Report, not only in
// the box that edits it: bold and underline as written, a list as a list.
const NOTE = "<p>A <b>farmer</b> and <u>miller</u></p><ul><li>first</li><li>second</li></ul>";
const FILE = path.join(tmpdir(), "report-note-formatting.ged");

writeFileSync(FILE, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Janez /Kos/", "1 SEX M",
  "1 BIRT", "2 DATE 4 MAY 1900", `2 NOTE ${NOTE}`,
  "1 DEAT", "2 DATE 1970",
  `1 NOTE ${NOTE}`,
  "1 NOTE A plain note.",
  "0 TRLR", "",
].join("\n"), "utf-8");

test("the report shows a note's formatting", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await expect(page.locator(".edit-name-input").first()).toHaveValue("Janez");
  await page.locator(".charts-open-btn").first().click();
  await page.keyboard.press("8");
  await page.locator(".report-entry").first().waitFor();
  await page.locator(".chart-settings-btn").first().click();
  await page.getByRole("button", { name: "Notes", exact: true }).click();

  const entry = page.locator(".report-entry").first();
  // The event's note under its fact line, and the person's own after the facts.
  await expect(entry.locator(".report-fact .report-note b").first()).toHaveText("farmer");
  await expect(entry.locator("> .report-note b, .report-entry-body > .report-note b").first()).toHaveText("farmer");
  await expect(entry.locator(".report-note u").first()).toHaveText("miller");
  await expect(entry.locator(".report-fact .report-note .note-item")).toHaveText(["first", "second"]);
  // A plain note stays as it was, and no markup reaches the page as text.
  await expect(entry).toContainText("A plain note.");
  await expect(entry).not.toContainText("<b>");
});
