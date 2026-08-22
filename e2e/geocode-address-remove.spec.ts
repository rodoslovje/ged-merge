import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// The ✎ beside a house on the geocoding Addresses tab renames it — and, with
// its field emptied, takes the address off the house's events altogether. The
// case is the address that repeats its own settlement ("Pivka" on every event
// in Pivka), which until now had to be cleared one person at a time.

const FILE = path.join(tmpdir(), "geocode-address-remove.ged");

writeFileSync(
  FILE,
  [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Ana /Kos/",
    // The settlement's own position, on an event with no address at all.
    "1 BIRT", "2 PLAC Pivka, Naklo, Slovenija", "3 MAP", "4 LATI N46.27004", "4 LONG E14.31892",
    // The address that says nothing the place does not — on two events.
    "1 RESI", "2 PLAC Pivka, Naklo, Slovenija", "2 ADDR Pivka",
    "1 DEAT", "2 PLAC Pivka, Naklo, Slovenija", "2 ADDR Pivka",
    "0 @I2@ INDI", "1 NAME Bo /Kos/",
    "1 BIRT", "2 PLAC Pivka, Naklo, Slovenija", "2 ADDR Pivka 27",
    "0 TRLR", "",
  ].join("\n"),
  "utf-8",
);

test("emptying the rename field removes the address from every event at the house", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor();

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Places", { exact: true }).click();
  await page.getByRole("button", { name: /Geocoding/ }).click();
  await page.locator(".tools-geo-tabs").getByRole("tab", { name: /Addresses/ }).click();

  await page.getByRole("button", { name: "Expand all" }).click();
  const rows = page.locator(".tools-geo-addr-row");
  await expect(rows).toHaveCount(2);

  // The redundant house, opened for rename from its own ✎ (drawn on hover, as
  // every ✎ on these lists is).
  const row = rows.filter({ hasText: "Pivka" }).first();
  await row.locator(".tools-geo-addr-head").hover();
  await row.locator(".tools-place-edit-btn").click();
  const field = page.locator(".tools-geo-addr-row .tools-place-rename-input");
  await expect(field).toHaveValue("Pivka");

  // Emptied, the button stops offering a rename and offers the removal.
  await expect(page.getByRole("button", { name: "Rename", exact: true })).toBeVisible();
  await field.fill("");
  await expect(page.getByRole("button", { name: "Rename", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Remove address", exact: true }).click();

  // The house leaves the list; the other one stays, and so does the place.
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Pivka 27");
  await expect(page.locator(".tools-geo-addr-group")).toContainText("Pivka, Naklo, Slovenija");

  // It reached the records, not this list alone: the events now name the place
  // alone, which the places tab counts as three of them (the birth and the two
  // the address just left).
  await page.locator(".tools-geo-tabs").getByRole("tab", { name: /Places/ }).click();
  const places = page.locator(".tools-geocode .tools-tree > li:not(.v-spacer)");
  await expect(places).toHaveCount(1);
  await expect(places.first()).toContainText("Pivka, Naklo, Slovenija");
  await expect(places.first()).toContainText("3");
});
