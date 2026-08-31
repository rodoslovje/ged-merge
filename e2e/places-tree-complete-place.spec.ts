import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// A place picked from the file's own list — or from a directory — is a complete
// place, and a complete place is never spliced into a value as though it were
// one of its levels: renaming the middle "Celje" of "Celje, Celje, Slovenija"
// to the whole chain used to write "Celje, Celje, Celje, Slovenija, Slovenija".

const FILE = path.join(tmpdir(), "places-tree-complete-place.ged");

writeFileSync(
  FILE,
  [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Mateja /Koder/",
    "1 RESI", "2 PLAC Celje, Celje, Slovenija",
    "0 @I2@ INDI", "1 NAME Ana /Kos/",
    "1 BIRT", "2 PLAC Ljubljana, Ljubljana, Slovenija",
    "0 TRLR", "",
  ].join("\n"),
  "utf-8",
);

test("a complete place replaces the row's value instead of being spliced into it", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor();

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Places", { exact: true }).click();

  // The town under the municipality of the same name — the row whose rename
  // doubled the chain. The country opens on load; the municipality is a click.
  await page.locator(".tools-tree-label").filter({ hasText: "Celje" }).first().click();
  const celje = page.locator(".tools-tree-row").filter({ hasText: "Celje" }).last();
  await expect(celje).toBeVisible();
  await celje.hover();
  await celje.locator(".tools-place-edit-btn").first().click();

  const field = page.locator(".tools-place-rename-input");
  // The place the row already reads as: nothing to write, so nothing to press.
  await field.fill("Celje, Celje, Slovenija");
  await expect(page.locator(".tools-place-rename-apply")).toBeDisabled();

  // Another complete place replaces the value outright — no level is repeated.
  await field.fill("Ljubljana, Ljubljana, Slovenija");
  await page.locator(".tools-place-rename-apply").click();

  await expect(page.locator(".tools-tree-row").filter({ hasText: "Celje" })).toHaveCount(0);
  const ljubljana = page.locator(".tools-tree > li").filter({ hasText: "Slovenija" }).first();
  await expect(ljubljana.locator(".tools-tree-label").filter({ hasText: "Ljubljana" })).toHaveCount(2);
  await expect(ljubljana.locator(".tools-chip-count").first()).toHaveText("2");
});
