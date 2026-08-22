import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// The geocoding Addresses tab names a place above each run of houses, and the ✎
// beside it renames that place — the places list's own rename, reached from the
// tab the houses are on. Every event whose PLAC is exactly that value takes the
// new one, so the group arrives whole under its new name.

const FILE = path.join(tmpdir(), "geocode-place-rename.ged");

writeFileSync(
  FILE,
  [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Ana /Kos/",
    "1 BIRT", "2 PLAC Kranj, Slovenija", "2 ADDR Stražišče 114",
    "1 DEAT", "2 PLAC Kranj, Slovenija", "2 ADDR Stražišče 120",
    "0 TRLR", "",
  ].join("\n"),
  "utf-8",
);

test("the place above the houses is renamed from its own ✎", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor();

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Places", { exact: true }).click();
  await page.getByRole("button", { name: /Geocoding/ }).click();

  await page.locator(".tools-geo-tabs").getByRole("tab", { name: /Addresses/ }).click();

  const group = page.locator(".tools-geo-addr-group");
  await expect(group).toHaveCount(1);
  await expect(group).toContainText("Kranj, Slovenija");

  // The ✎ on the group's own line — the place's, not a house's: the houses are
  // folded away until the group is opened. Like every other ✎ on these lists it
  // is drawn on the row under the pointer, so the row is hovered first.
  await group.locator(".tools-tree-row").first().hover();
  await group.locator(".tools-tree-row .tools-place-edit-btn").click();
  const field = page.locator(".tools-geo-addr-group .tools-place-rename-input");
  await field.fill("Kranj, Gorenjska, Slovenija");
  await group.getByRole("button", { name: "Rename", exact: true }).click();

  // Both houses arrive under the new name, and nothing is left under the old.
  await expect(group).toHaveCount(1);
  await expect(group).toContainText("Kranj, Gorenjska, Slovenija");
  await expect(group).toContainText("2 addresses");

  // …and it reached the records rather than this list alone: the places tab,
  // which reads the same values as whole PLAC strings, is renamed with it.
  await page.locator(".tools-geo-tabs").getByRole("tab", { name: /Places/ }).click();
  const places = page.locator(".tools-geocode .tools-tree > li:not(.v-spacer)");
  await expect(places).toHaveCount(1);
  await expect(places.first()).toContainText("Kranj, Gorenjska, Slovenija");
});
