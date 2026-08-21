import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// Promoting a plain link into a source must write the same shape "+ Add
// source" does: in a file that keeps page links on its records, the cited
// page's image is linked beside the citation, not only under the source.
const FILE = path.join(tmpdir(), "source-promote-page-link.ged");

writeFileSync(
  FILE,
  [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Blaž /Kern/", "1 SEX M",
    // The birth states the file's habit — a cited page whose image is linked
    // beside the citation — so the page-link style reads "event" on its own,
    // with no Settings override.
    "1 BIRT", "2 DATE 3 MAR 1880", "2 SOUR @S1@", "3 PAGE 11", "2 OBJE @M1@",
    // The death carries the same book's page as a bare link: the chip to promote.
    "1 DEAT", "2 DATE 7 JUL 1915", "2 WWW https://example.com/knjiga/?pg=12",
    "0 @S1@ SOUR", "1 TITL Krstna knjiga | Preddvor", "1 OBJE @M1@",
    "0 @M1@ OBJE", "1 FILE https://example.com/knjiga/?pg=11", "2 FORM htm",
    "0 TRLR",
  ].join("\n"),
);

test("a promoted link takes its page image onto the event", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  // The date lives in an input value, so the row is found by its type label.
  const deathRow = page.locator(".edit-event", { hasText: /Death|Smrt/ }).first();
  const chips = deathRow.locator(".edit-event-extra--sources");
  await expect(chips.locator("button.edit-link-icon")).toHaveCount(1); // the plain link
  await expect(chips.locator(".source-ref")).toHaveCount(0); // nothing cited yet

  // The link chip opens the source dialog; a title is what makes it a real
  // source rather than a renamed link.
  await chips.locator("button.edit-link-icon").click();
  const dialog = page.locator(".add-source-dialog");
  await expect(dialog).toBeVisible();
  await dialog.locator(".add-source-field input").first().fill("Mrliška knjiga | Preddvor");
  await dialog.getByRole("button", { name: /Save|Shrani/ }).click();
  await expect(dialog).toBeHidden();

  // The citation, and the cited page's image linked beside it.
  await expect(chips.locator(".source-ref")).toHaveCount(1);
  await expect(chips.locator("button.edit-link-icon")).toHaveCount(1);

  // That remaining chip is the page media, not a leftover plain link: it opens
  // the media-link dialog, which a link chip never does.
  await chips.locator("button.edit-link-icon").click();
  await expect(page.locator(".media-link-dialog")).toBeVisible();
});
