import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

/** MyHeritage's note shape: a styled paragraph with HTML character codes. */
const HTML_NOTE = '<p style="text-align: left;" dir="ltr">Rodil se je v porodni&scaron;nici.</p>';
const LINK_NOTE = '<p style="text-align: left;" dir="ltr">Glej <a href="https://www.dlib.si/x">dLib</a>.</p>';

/** Two HTML notes and a plain one on a person. */
function writeFixture(): string {
  const ged = [
    "0 HEAD",
    "1 GEDC",
    "2 VERS 5.5.1",
    "1 CHAR UTF-8",
    "0 @I1@ INDI",
    "1 NAME Tatjana /Dolenc/",
    "1 SEX F",
    `1 NOTE ${HTML_NOTE}`,
    `1 NOTE ${LINK_NOTE}`,
    "1 NOTE plain note",
    "0 TRLR",
    "",
  ].join("\n");
  const filePath = path.join(tmpdir(), `rich-notes-${Date.now()}.ged`);
  writeFileSync(filePath, ged, "utf-8");
  return filePath;
}

test("edit mode: an HTML note reads as text, is rewritten clean once edited and kept verbatim otherwise", async ({ page }) => {
  const fixture = writeFixture();
  await page.goto("/");

  await page.locator("input.file-input").first().setInputFiles(fixture);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  // The markup is gone from view: the text reads decoded, the link is a link.
  const chips = page.locator(".edit-note-chip [contenteditable]");
  await expect(chips).toHaveCount(3);
  await expect(chips.nth(0)).toHaveText("Rodil se je v porodnišnici.");
  await expect(chips.nth(1).locator("a")).toHaveAttribute("href", "https://www.dlib.si/x");
  await expect(chips.nth(2)).toHaveText("plain note");

  // Append to the first note; leave the second alone.
  await chips.nth(0).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Doma.");

  // Make the plain note bold with the toolbar: it becomes an HTML note.
  await chips.nth(2).click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
  await page.locator(".edit-note-chip").nth(2).locator(".note-tool--b").click();
  await expect(chips.nth(2).locator("b")).toHaveText("plain note");
  await page.locator(".edit-name-input").first().click(); // blur-commit

  await page.locator(".app-head-actions .export-btn").click();
  const downloadPromise = page.waitForEvent("download", (d) => d.suggestedFilename().endsWith(".ged"));
  await page.locator(".preview-actions .export-btn").click();
  const content = readFileSync((await (await downloadPromise).path())!, "utf-8");

  expect(content).toContain("1 NOTE <p>Rodil se je v porodnišnici. Doma.</p>");
  expect(content).toContain(`1 NOTE ${LINK_NOTE}`);
  expect(content).toContain("1 NOTE <p><b>plain note</b></p>");
});
