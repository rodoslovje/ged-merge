import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

/** One person in a file that writes its dates numerically — another
 *  program's habit, which a strict target format would rewrite. */
function writeFixture(): string {
  const ged = [
    "0 HEAD",
    "1 GEDC",
    "2 VERS 5.5.1",
    "0 @I1@ INDI",
    "1 NAME Janez /Novak/",
    "1 SEX M",
    "1 BIRT",
    "2 DATE 05.03.1850",
    "1 DEAT",
    "2 DATE 07.06.1910",
    "0 TRLR",
    "",
  ].join("\n");
  const filePath = path.join(tmpdir(), `target-format-${Date.now()}.ged`);
  writeFileSync(filePath, ged, "utf-8");
  return filePath;
}

test("a file with another program's habits keeps its own format until GEDCOM 7.0 is chosen", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(writeFixture());
  // Proposed on first open, and said once.
  await expect(page.locator(".save-toast")).toContainText("This file keeps its own format");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  // In its own format a typed date follows the file's numeric habit.
  const death = page.locator(".edit-event").nth(1).locator(".edit-event-date");
  await death.fill("8 jun 1910");
  await death.press("Tab");
  await expect(death).toHaveValue("08.06.1910");

  await page.locator('button[title*="etting"]').first().click();
  await page.getByRole("tab", { name: "GEDCOM" }).click();
  const own = page.getByRole("radio", { name: /The file's own format/ });
  await expect(own).toBeChecked();
  const dateRow = page.locator(".settings-format-row").filter({ hasText: "Format" }).first();
  await expect(dateRow.locator("button").first()).toBeEnabled();

  // A strict target offers Normalize; the date row is then the standard's.
  await page.getByRole("radio", { name: /GEDCOM 7\.0/ }).check();
  const dialog = page.locator(".confirm-dialog");
  await expect(dialog).toContainText("Your edits now follow GEDCOM 7.0");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("radio", { name: /GEDCOM 7\.0/ })).toBeChecked();
  await expect(dateRow.locator("button").first()).toBeDisabled();
  await page.locator(".settings-modal .modal-close").click();

  // Typed dates are now written in the GEDCOM grammar.
  await death.fill("9.6.1910");
  await death.press("Tab");
  await expect(death).toHaveValue("9 JUN 1910");
});
