import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// The save preview's second reading: the GEDCOM lines the file is about to
// receive, each under the tags that own it. What the spec pins down is the
// part a reader trusts it for — that the changed line is shown against the
// line it replaces, under its own event, with the person's other events left
// out — and that the choice of reading survives the dialog being closed.

const FILE = path.join(tmpdir(), "preview-diff-view.ged");

writeFileSync(
  FILE,
  [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Jurij /Vidmar/", "1 SEX M",
    "1 BIRT", "2 DATE 12 MAR 1880", "2 PLAC Kranj",
    "1 DEAT", "2 DATE 1945",
    "0 TRLR", "",
  ].join("\n"),
  "utf-8",
);

test("the save preview reads the pending change as GEDCOM lines", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor();

  const birthDate = page.locator(".edit-event").first().locator(".edit-event-date");
  await birthDate.fill("13 MAR 1880");
  await birthDate.blur(); // the field commits when it is left
  const saveBtn = page.locator(".app-head-actions .export-btn");
  await expect(saveBtn).toBeEnabled();
  await saveBtn.click();

  // Opens on the field rows, as it always has.
  await expect(page.locator(".preview-card .preview-fields").first()).toBeVisible();
  await expect(page.locator(".preview-diff")).toHaveCount(0);

  await page.getByRole("tab", { name: "GEDCOM lines" }).click();

  const lines = page.locator(".preview-diff .diff-line");
  await expect(lines).toHaveCount(4);
  await expect(lines.nth(0)).toHaveText("0 @I1@ INDI");
  await expect(lines.nth(1)).toHaveText("1 BIRT");
  // The sign sits against its line, as in any unified diff, so a block copied
  // out of here pastes as one.
  await expect(lines.nth(2)).toHaveText("-2 DATE 12 MAR 1880");
  await expect(lines.nth(3)).toHaveText("+2 DATE 13 MAR 1880");
  await expect(lines.nth(2)).toHaveClass(/is-del/);
  await expect(lines.nth(3)).toHaveClass(/is-add/);
  // The death and the unchanged birth place are another part of the record,
  // and the view is about the change.
  await expect(page.locator(".preview-diff")).not.toContainText("DEAT");
  await expect(page.locator(".preview-diff")).not.toContainText("PLAC");

  // The stamps the save writes after this dialog is confirmed are deliberately
  // not here: the reader is checking their own change, not the bookkeeping.
  await expect(page.locator(".preview-diff")).not.toContainText("CHAN");

  // The reading is a habit, so it is remembered: reopening comes back to it.
  await page.locator(".preview-actions .btn-secondary").click();
  await expect(page.locator(".preview-diff")).toHaveCount(0);
  await saveBtn.click();
  await expect(page.locator(".preview-diff .diff-line").first()).toBeVisible();
  await expect(page.getByRole("tab", { name: "GEDCOM lines" })).toHaveAttribute("aria-selected", "true");
});
