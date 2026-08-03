import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import os from "os";
import path from "path";

// The geocode page for a file that keeps its addresses in the place value —
// the shape a Slovenian file most often has. Three things this guards:
//
//  - a place value that is really a house ("Črni vrh 35") is reviewed under its
//    settlement in the address list, and is *not* also a row of the place list;
//  - one house written two ways (the same number under two parishes) is a
//    single row;
//  - the page's filter narrows both lists at once, ignoring diacritics.

const FILE = path.join(os.tmpdir(), "geocode-addresses.ged");

writeFileSync(
  FILE,
  [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Ana /Kos/",
    "1 BIRT", "2 PLAC Črni vrh 35",
    "1 RESI", "2 PLAC Črni vrh 46",
    "1 DEAT", "2 PLAC Črni vrh",
    "0 @I2@ INDI", "1 NAME Bo /Kos/",
    // One house, two spellings — the parish differs, the building does not.
    "1 BIRT", "2 PLAC Kranj (Slovenija), Stražišče 114 - župnija Šmartin",
    "1 DEAT", "2 PLAC Kranj (Slovenija), Stražišče 114 - župnija Kranj",
    "0 TRLR", "",
  ].join("\n"),
  "utf-8",
);

test("houses in the place value are grouped under their settlement, and the filter reaches both lists", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Places", { exact: true }).click();
  await page.getByRole("button", { name: /Geocoding/ }).click();

  // The list renders through the virtual-list spacers — count real rows only.
  const places = page.locator(".tools-geocode .tools-tree > li:not(.v-spacer)");
  const groups = page.locator(".tools-geo-addr-group");

  // The place list holds the settlements only: "Črni vrh" (the place-only
  // death) and "Kranj, Slovenija" is not one of the file's values, so the one
  // place row left is Črni vrh. The houses are not listed here at all.
  await expect(places).toHaveCount(1);
  await expect(places.first()).toContainText("Črni vrh");
  await expect(places.first()).not.toContainText("35");

  // Two groups: Črni vrh with its two houses, Kranj with the merged one.
  await expect(groups).toHaveCount(2);
  await expect(groups.filter({ hasText: "Kranj, Slovenija" })).toContainText("1 addresses");

  // Both are marked as keeping the address inside the place value, so neither
  // offers the move.
  await expect(page.getByRole("button", { name: /Move to another place/ })).toHaveCount(0);

  // The filter narrows both lists at once — and without the diacritics.
  await page.locator(".tools-geocode .tools-search-input").fill("crni");
  await expect(places).toHaveCount(1);
  await expect(groups).toHaveCount(1);
  await expect(groups.first()).toContainText("Črni vrh");

  // A house number reaches into the groups: the place list has nothing to show,
  // and says so rather than looking empty.
  await page.locator(".tools-geocode .tools-search-input").fill("114");
  await expect(places).toHaveCount(0);
  await expect(page.getByText("No matches.")).toBeVisible();
  await expect(groups).toHaveCount(1);
  // The addresses sit behind their own tab; the filter kept the group and
  // opened it, so switching over shows the address searched for.
  await page.getByRole("tab", { name: /Addresses/ }).click();
  // A filter landing on one place opens it, so the address searched for shows.
  await expect(page.getByText("Stražišče 114")).toBeVisible();
});

test("one coordinate can be given to a whole place's addresses at once", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Places", { exact: true }).click();
  await page.getByRole("button", { name: /Geocoding/ }).click();
  await page.getByRole("tab", { name: /Addresses/ }).click();

  // Črni vrh keeps its two houses in the place values; neither is in any
  // register, which is the case this flow exists for.
  const group = page.locator(".tools-geo-addr-group").filter({ hasText: "Črni vrh" });
  await group.locator(".tools-pair-toggle").first().click();
  await group.getByRole("button", { name: /Place several at one coordinate/ }).click();

  // Both addresses are ticked to begin with, and nothing can be taken until a
  // position is chosen — the file gives this place none.
  const take = group.getByRole("button", { name: /Take this for/ });
  await expect(take).toBeDisabled();

  // The panel's own picker, not the per-row ones below it.
  await group.locator(".tools-geo-addr-move .edit-event-coord").click();
  await page.locator(".edit-coord-manual input").fill("46.10101, 14.20202");
  await page.getByRole("button", { name: "Set", exact: true }).click();
  await expect(take).toBeEnabled();

  // A prefix narrows the ticks to the houses that start with it — folded, so
  // "crni vrh 4" reaches "Črni vrh 46" — and clearing it ticks the place again.
  await group.locator(".tools-geo-addr-chip-input").fill("crni vrh 4");
  await expect(group.getByRole("button", { name: /Take this for 1 address/ })).toBeEnabled();
  await group.locator(".tools-geo-addr-chip-clear").click();
  await expect(take).toBeEnabled();
  await take.click();

  // Staged for both houses, then written in one step.
  const write = page.getByRole("button", { name: /Write address coordinates \(2\)/ });
  await expect(write).toBeEnabled();
  await write.click();
  await expect(page.getByText(/Written to \d+ records?\./)).toBeVisible();
});
