import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// A value that names a street and no country at all — "?/Grosova ulica 18" —
// is not a place spelt wrong: it is a house in a place the file never named.
// Correcting it takes both halves, so the tree's rename box carries the address
// field the geocoding rows have, and the row it offers it on is the place level
// above the house (which is where the ✎ is).

const FILE = path.join(tmpdir(), "places-tree-split.ged");

writeFileSync(
  FILE,
  [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Ana /Kos/",
    "1 BIRT", "2 PLAC ?/Grosova ulica 18",
    "0 @I2@ INDI", "1 NAME Ivan /Kos/",
    "1 BIRT", "2 PLAC Kokrica, Kranj, Slovenija",
    "0 TRLR", "",
  ].join("\n"),
  "utf-8",
);

test("the tree splits a street value into a place and an address", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor();

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Places", { exact: true }).click();
  await page.locator(".tools-tree-label").filter({ hasText: "Unspecified country" }).click();

  // The place level above the house: the value carries a number, so the tree
  // hangs the house off it as a level of its own.
  const row = page.locator(".tools-tree-row").filter({ hasText: "?/Grosova ulica" }).first();
  await expect(row).toBeVisible();
  await row.hover();
  await row.locator(".tools-place-edit-btn").first().click();

  // Both halves: the place the file already writes, and the street as the
  // event's own address.
  await page.locator(".tools-place-rename-input").fill("Kokrica, Kranj, Slovenija");
  const addr = page.locator(".tools-geo-addr-chip-input");
  await expect(addr).toBeVisible();
  await addr.fill("Grosova ulica 18");
  await page.locator(".tools-place-rename-apply").click();

  // The record now stands under Slovenia with the other one, and its street is
  // an address under Kokrica rather than a country of its own.
  await expect(page.locator(".tools-tree-row").filter({ hasText: "Unspecified country" })).toHaveCount(0);
  const slovenia = page.locator(".tools-tree > li").filter({ hasText: "Slovenija" }).first();
  await expect(slovenia.locator(".tools-chip-count").first()).toHaveText("2");
  // The rename opens the branch the record landed in, so the place it now sits
  // in is on screen without hunting for it.
  await expect(slovenia.locator(".tools-tree-label").filter({ hasText: "Kranj" })).toHaveCount(1);
  await expect(slovenia.locator(".tools-tree-label").filter({ hasText: "Kokrica" })).toHaveCount(1);

  // …and the street really did land on the event's own ADDR line: the tree
  // hangs an address level off the place, which is drawn as an address row.
  await expect(slovenia.locator(".tools-tree-addr").filter({ hasText: "Grosova ulica 18" })).toHaveCount(1);
});
