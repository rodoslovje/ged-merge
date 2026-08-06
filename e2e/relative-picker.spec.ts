import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import os from "os";
import path from "path";

/** A married woman (maiden Stare, married Kalan) plus her husband, so the
 *  picker's rows have a sex, a lifespan and a married surname to show. */
function writeFixture(): string {
  const ged = [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Jakob /Kalan/", "1 SEX M", "1 FAMS @F1@",
    "1 BIRT", "2 DATE 20 JUL 1898", "1 DEAT", "2 DATE 29 OCT 1966",
    "0 @I2@ INDI", "1 NAME Ana /Stare/", "2 _MARNM Kalan", "1 SEX F", "1 FAMS @F1@",
    "1 BIRT", "2 DATE 1 MAR 1903", "1 DEAT", "2 DATE 4 JUN 1961",
    "0 @F1@ FAM", "1 HUSB @I1@", "1 WIFE @I2@",
    "0 TRLR", "",
  ].join("\n");
  const file = path.join(os.tmpdir(), `picker-${Date.now()}.ged`);
  writeFileSync(file, ged, "utf-8");
  return file;
}

/** Open the picker on the person's "Add Child" slot and search for `query`. */
async function search(page: import("@playwright/test").Page, query: string) {
  await page.locator(".person-card-add").filter({ hasText: /Add Child/i }).first().click();
  const picker = page.locator(".relative-picker");
  await picker.locator(".relative-picker-input").fill(query);
  return picker;
}

test("picker rows carry the person styling the cards use", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("gedmerge.settings", JSON.stringify({ showXref: true, showAge: true }));
  });
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(writeFixture());
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  const picker = await search(page, "Ana");
  const row = picker.locator(".relative-picker-option", { hasText: "Ana" }).first();

  // Sex colour, record id and the lifespan with its age — as on a person card.
  await expect(row.locator(".person-label")).toHaveClass(/sex-f/);
  await expect(row.locator(".person-xref")).toHaveText("I2");
  await expect(row.locator(".person-years")).toHaveText("1903–1961 (58)");
});

test("the start-person lookup carries it too", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("gedmerge.settings", JSON.stringify({ showXref: true, showAge: true }));
  });
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(writeFixture());
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  const input = page.locator(".start-selector input, .start-wrap input").first();
  await input.click();
  await input.fill("Ana");
  const row = page.locator(".start-option", { hasText: "Ana" }).first();
  await expect(row.locator(".person-label")).toHaveClass(/sex-f/);
  await expect(row.locator(".person-xref")).toHaveText("I2");
  await expect(row.locator(".person-years")).toHaveText("1903–1961 (58)");
});

test("picker finds a person by a name it is not showing", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("gedmerge.settings", JSON.stringify({ marriedSurname: true }));
  });
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(writeFixture());
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  // Shown with her married surname, per the setting…
  const picker = await search(page, "Ana");
  await expect(picker.locator(".relative-picker-option", { hasText: "Ana" }).first()).toContainText("(Kalan)");

  // …and still found by the maiden name that is no longer the one on show.
  await picker.locator(".relative-picker-input").fill("Stare");
  await expect(picker.locator(".relative-picker-option", { hasText: "Ana" })).toHaveCount(1);
});

test("picker finds a person by the opening letters of each name", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(writeFixture());
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  // "an sta" is not a run of letters anywhere in "Ana Stare" — each word of the
  // query has to be matched on its own for this to find her.
  const picker = await search(page, "an sta");
  await expect(picker.locator(".relative-picker-option", { hasText: "Ana" })).toHaveCount(1);

  // And the order of the two doesn't matter.
  await picker.locator(".relative-picker-input").fill("sta an");
  await expect(picker.locator(".relative-picker-option", { hasText: "Ana" })).toHaveCount(1);
});
