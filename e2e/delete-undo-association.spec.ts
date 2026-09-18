import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

/**
 * Deleting a person strips every association that names them — a godparent
 * the file no longer holds cannot stay pointed at from a baptism. Undo has to
 * put those lines back too: they sit on *other* people's records, outside the
 * families the delete snapshots, and once were lost for good.
 */
function writeFixture(): string {
  const ged = [
    "0 HEAD", "1 GEDC", "2 VERS 7.0", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Janez /Renko/", "1 SEX M",
    "1 BAPM", "2 DATE 31 AUG 1958", "2 ASSO @I2@", "3 ROLE GODP",
    "0 @I2@ INDI", "1 NAME Jozefa /Pezdirc/", "1 SEX F",
    "1 BIRT", "2 DATE 1900",
    "0 TRLR", "",
  ].join("\n");
  const filePath = path.join(tmpdir(), `delete-undo-assoc-${Date.now()}.ged`);
  writeFileSync(filePath, ged, "utf-8");
  return filePath;
}

test("undoing a delete brings the godparent back onto the baptism", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(writeFixture());
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  // Janez's only association: the godmother on his baptism.
  const chips = page.locator(".edit-event-assoc");
  await expect(chips).toHaveCount(1);
  await expect(chips.first()).toContainText("Jozefa");

  // Over to the godmother, and delete her.
  await page.getByRole("button", { name: /Search everyone/i }).click();
  await page.locator(".global-search-input").fill("Jozefa");
  await page.locator(".global-search-open").first().click();
  await expect(page.locator(".edit-name-input").first()).toHaveValue("Jozefa");
  await page.locator(".edit-delete-btn").click();
  await page.locator(".confirm-dialog .confirm-dialog-confirm").click();

  // The view lands on the person left; the baptism no longer names her. Two
  // records changed — hers, and his for the association taken off it — which
  // is also the moment the delete is fully on the books.
  await expect(page.locator(".edit-name-input").first()).toHaveValue("Janez");
  await expect(chips).toHaveCount(0);
  await expect(page.locator(".app-head-actions .export-btn")).toContainText("(2)");

  // One undo — landed once Redo lights up — and she is a person of the file
  // again … (By the shortcut: a click on the head bar's Undo button in the
  // first moments after the confirm dialog closes was lost in 4 of 4 runs,
  // while the same click a fraction of a second later, and this key, always
  // land — a test-speed artefact of the dialog's closing, not of undo.)
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByRole("button", { name: "Redo" }).filter({ visible: true }).first()).toBeEnabled();
  await page.getByRole("button", { name: /Search everyone/i }).click();
  const search = page.locator(".global-search-input");
  await search.fill("Jozefa");
  await expect(page.locator(".global-search-open")).toHaveCount(1);
  // … and so is her place on his baptism.
  await search.fill("Janez");
  await page.locator(".global-search-open").first().click();
  await expect(page.locator(".edit-name-input").first()).toHaveValue("Janez");
  await expect(chips).toHaveCount(1);
  await expect(chips.first()).toContainText("Jozefa");
});
