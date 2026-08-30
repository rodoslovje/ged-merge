import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// The places tree's rename box completes from the file's own places, not only
// from the names standing beside the one being renamed. A value that names no
// country at all — the case the box exists for — has siblings that are every
// bit as unplaced as it is, so the list has to reach the places the file writes
// properly, and picking one moves the record under them.

const FILE = path.join(tmpdir(), "places-tree-rename.ged");

writeFileSync(
  FILE,
  [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Ana /Kos/",
    "1 BIRT", "2 PLAC Kokrica",
    "0 @I2@ INDI", "1 NAME Ivan /Kos/",
    "1 BIRT", "2 PLAC Kranj, Slovenija",
    "0 TRLR", "",
  ].join("\n"),
  "utf-8",
);

test("the tree's rename box offers the places the file already writes", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor();

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Places", { exact: true }).click();

  // "Kokrica" names no country, so it sits in the unspecified bucket beside
  // nothing that could help it — a bucket the tree keeps folded, since the file
  // has a second root of its own.
  await page.locator(".tools-tree-label").filter({ hasText: "Unspecified country" }).click();

  // Its ✎ is drawn on the row under the pointer.
  const row = page.locator(".tools-tree-row").filter({ hasText: "Kokrica" }).first();
  await expect(row).toBeVisible();
  await row.hover();
  await row.locator(".tools-place-edit-btn").first().click();

  const field = page.locator(".tools-place-rename-input");
  await expect(field).toBeVisible();
  await field.fill("Kranj");

  // The file's own other place — a whole value, from another branch of the
  // tree entirely — is offered, and picking it is what places this record.
  const offer = page.locator(".place-suggestions .place-suggestion").filter({ hasText: "Kranj, Slovenija" }).first();
  await expect(offer).toBeVisible();
  await offer.click();
  await expect(field).toHaveValue("Kranj, Slovenija");

  await page.locator(".tools-place-rename-apply").click();

  // Both people are now under Slovenia — the country counts two mentions and
  // the unspecified bucket is gone entirely — and the record that moved sits in
  // the same Kranj as the one that was already there.
  await expect(page.locator(".tools-tree-row").filter({ hasText: "Unspecified country" })).toHaveCount(0);
  const slovenia = page.locator(".tools-tree > li").filter({ hasText: "Slovenija" }).first();
  await expect(slovenia.locator(".tools-chip-count").first()).toHaveText("2");
  await slovenia.locator(".tools-tree-label").first().click();
  await expect(slovenia.locator(".tools-tree-label").filter({ hasText: "Kranj" })).toHaveCount(1);
});
