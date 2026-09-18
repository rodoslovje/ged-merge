import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// Who else the file puts at the address a coordinate is being picked for: the
// panel counts them, unfolds into their names, and each name opens that person.

const FILE = path.join(tmpdir(), "coord-people.ged");

writeFileSync(
  FILE,
  [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    // Two events of Ana's at the house, so the list has to count her once.
    "0 @I1@ INDI", "1 NAME Ana /Kos/",
    // No coordinates anywhere: the geocoding list offers exactly the addresses
    // still to be placed, which is where the second test opens the panel.
    "1 BIRT", "2 PLAC Kranj, Slovenija", "2 ADDR Stražišče 114",
    "1 DEAT", "2 PLAC Kranj, Slovenija", "2 ADDR Stražišče 114",
    "1 FAMS @F1@",
    "0 @I2@ INDI", "1 NAME Jože /Kos/",
    "1 BIRT", "2 PLAC Kranj, Slovenija", "2 ADDR Stražišče 114",
    "1 FAMS @F1@",
    // A neighbour at the same place but another house — never on this list.
    "0 @I3@ INDI", "1 NAME Marija /Novak/",
    // The file's one coordinate: a file that holds none draws no pins at all,
    // and this house is not the one the tests open.
    "1 BIRT", "2 PLAC Kranj, Slovenija", "3 MAP", "4 LATI N46.24137", "4 LONG E14.35580", "2 ADDR Stražišče 115",
    "0 @F1@ FAM", "1 HUSB @I2@", "1 WIFE @I1@",
    "1 MARR", "2 PLAC Kranj, Slovenija", "2 ADDR Stražišče 114",
    "0 TRLR", "",
  ].join("\n"),
  "utf-8",
);

test("the coordinate panel lists the people at this address", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });

  await page.locator(".edit-event .edit-event-coord").first().click();
  const line = page.locator(".edit-coord-people > button");
  // Ana and Jože — the marriage adds no third person, and the neighbour at 115
  // is a different house.
  await expect(line).toHaveText("2 people at this address");

  // Folded to begin with; unfolding names them, each of them once — the
  // couple's marriage at the house adds no second pair of lines.
  await expect(page.locator(".edit-coord-people .tools-usage li")).toHaveCount(0);
  await line.click();
  const people = page.locator(".edit-coord-people .tools-usage .person-ref");
  await expect(people).toHaveCount(2);
  await expect(people.filter({ hasText: "Marija" })).toHaveCount(0);

  // A name opens that person, which closes the panel with the row it hung off.
  await people.filter({ hasText: "Jože" }).first().click();
  await expect(page.locator(".edit-name-input").first()).toHaveValue("Jože");
  await expect(page.locator(".edit-coord-people")).toHaveCount(0);
});

test("the same list reads off the address the geocoding page is positioning", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Places", { exact: true }).click();
  await page.getByRole("button", { name: /Geocoding/ }).click();
  await page.getByRole("tab", { name: /Addresses/ }).click();
  await page.locator(".tools-geo-addr-group .tools-pair-toggle").first().click();
  // The row for Stražišče 114 — the house two of the three share.
  await page.locator(".tools-geo-addr-row").filter({ hasText: "114" }).first()
    .locator(".tools-geo-addr-name").click();
  const line = page.locator(".edit-coord-people > button");
  await expect(line).toHaveText("2 people at this address");
  await line.click();
  await expect(page.locator(".edit-coord-people .tools-usage .person-ref")).toHaveCount(2);
});
