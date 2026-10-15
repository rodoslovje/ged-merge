import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

/** A couple under xrefs no start-person default recognizes, so the file opens
 *  with no start person. */
function writeFixture(): string {
  const ged = [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    "0 @P1@ INDI", "1 NAME Jakob /Kalan/", "1 SEX M", "1 FAMS @F1@",
    "0 @P2@ INDI", "1 NAME Ana /Stare/", "1 SEX F", "1 FAMS @F1@",
    "0 @F1@ FAM", "1 HUSB @P1@", "1 WIFE @P2@",
    "0 TRLR", "",
  ].join("\n");
  const file = path.join(tmpdir(), `start-chip-${Date.now()}.ged`);
  writeFileSync(file, ged, "utf-8");
  return file;
}

// The start person is set from the kinship chip in Edit's name row — the
// place its effect shows — rather than from a field in the header.
test("the kinship chip sets, changes, follows and clears the start person", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(writeFixture());
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  const nameInput = page.locator(".edit-name-input").first();
  const shown = await nameInput.inputValue();
  const other = shown === "Jakob" ? "Ana" : "Jakob";
  const chip = page.locator(".edit-name-row .start-chip");
  const item = (v: string) => page.locator(`.dd-menu .dd-item[data-value="${v}"]`);

  // No start person: the chip offers to set one, and the header has no field.
  await expect(page.locator(".app-head .start-selector")).toHaveCount(0);
  await expect(chip).toHaveText("Set start person");

  // Make the person on screen the start person.
  await chip.click();
  await item("make").click();
  await expect(chip).toHaveText("Start Person");

  // Choose the other one instead: the chip now names this person's kinship.
  await chip.click();
  await item("choose").click();
  const input = page.locator(".edit-name-row .relative-picker-input");
  await expect(input).toBeFocused();
  await input.fill(other);
  await page.locator(".edit-name-row .relative-picker-option", { hasText: other }).first().click();
  await expect(chip).not.toHaveText("Start Person");
  await expect(chip).toHaveClass(/person-kinship/);

  // Go to the start person.
  await chip.click();
  await item("goto").click();
  await expect(nameInput).toHaveValue(other);
  await expect(chip).toHaveText("Start Person");

  // Clear it: the offer comes back.
  await chip.click();
  await item("clear").click();
  await expect(chip).toHaveText("Set start person");
});
