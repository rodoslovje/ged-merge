import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// Back walks the pages in the order they were visited. A person opened from a
// Tools list is a step away from that list, so Back — Edit's own button, ⌫, or
// the browser's — returns to it. Edit used to keep a trail of people alone:
// Back out of a person opened from geocoding stepped to whoever Edit had been
// showing before, and the list the reader came from could not be reached from
// inside the view at all.

const FILE = path.join(tmpdir(), "tools-back-to-page.ged");

writeFileSync(
  FILE,
  [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Ana /Kos/",
    "1 BIRT", "2 PLAC Kranj, Slovenija", "2 ADDR Stražišče 114",
    "0 @I2@ INDI", "1 NAME Jože /Kos/",
    "1 BIRT", "2 PLAC Bled, Slovenija", "2 ADDR Grajska 1",
    "0 @F1@ FAM", "1 HUSB @I2@", "1 WIFE @I1@",
    "0 TRLR", "",
  ].join("\n"),
  "utf-8",
);

test("Back returns to the Tools list a person was opened from", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor();

  // Edit opens on somebody, and walking to a relative first is the case that
  // used to swallow the return: Edit's own trail then had a person on it.
  await page.locator(".person-card").filter({ hasNot: page.locator(".person-card-add") }).first().click();

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Places", { exact: true }).click();
  await page.getByRole("button", { name: /Geocoding/ }).click();

  await page.locator(".tools-geo-tabs").getByRole("tab", { name: /Addresses/ }).click();

  // Open a group and its people, and go to one of them in Edit.
  const group = page.locator(".tools-geo-addr-group").first();
  await group.locator(".tools-pair-toggle").first().click();
  await group.locator(".tools-geo-addr-row .tools-count-toggle").first().click();
  await group.locator(".tools-geo-people .person-ref").first().click();
  await expect(page.locator(".edit-person")).toBeVisible();

  // Back is the trip we just made, undone: the geocoding list, not the person
  // Edit was showing before it.
  await page.locator(".edit-actions .tree-back-btn").click();
  await expect(page.locator(".tools-geo-addr-group").first()).toBeVisible();
  await expect(page.locator(".edit-person")).toBeHidden();
});
