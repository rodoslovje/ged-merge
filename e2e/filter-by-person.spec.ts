import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// The filter boxes find a person, not only a place or a title: a reader looking
// for "the entries for Marija Kovačič" has no place name and no book to type.
const uid = `${process.pid}`;
const FILE = path.join(tmpdir(), `filter-by-person-${uid}.ged`);
const BOOK = "https://data.matricula-online.eu/sl/slovenia/maribor/sentjur-pri-celju/03869";

writeFileSync(
  FILE,
  [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    // Two people in two villages, so a place filter and a name filter pick out
    // different rows — and the name has diacritics the box must see past.
    "0 @I1@ INDI", "1 NAME Marija /Kovačič/", "1 SEX F",
    "1 BIRT", "2 DATE 3 MAR 1880", "2 PLAC Kranj, Kranj, Slovenia", "2 ADDR Zoisova 5",
    "2 SOUR @S1@", "3 PAGE 11",
    "0 @I2@ INDI", "1 NAME Blaž /Kern/", "1 SEX M",
    "1 BIRT", "2 DATE 7 JUL 1885", "2 PLAC Preddvor, Preddvor, Slovenia", "2 ADDR Breg 3",
    "2 SOUR @S1@", "3 PAGE 12", "2 OBJE @M12@",
    // A third, so keeping the page beside the citation reads as the file's own
    // habit rather than one record's.
    "0 @I3@ INDI", "1 NAME Cilka /Kern/", "1 SEX F",
    "1 BIRT", "2 DATE 5 MAY 1882", "2 PLAC Preddvor, Preddvor, Slovenia",
    "2 SOUR @S1@", "3 PAGE 13", "2 OBJE @M13@",
    "0 @S1@ SOUR", "1 TITL Krstna knjiga - 03869", "1 OBJE @M11@", "1 OBJE @M12@", "1 OBJE @M13@",
    "0 @M11@ OBJE", `1 FILE ${BOOK}/?pg=11`, "2 FORM htm",
    "0 @M12@ OBJE", `1 FILE ${BOOK}/?pg=12`, "2 FORM htm",
    "0 @M13@ OBJE", `1 FILE ${BOOK}/?pg=13`, "2 FORM htm",
    "0 TRLR", "",
  ].join("\n"),
  "utf-8",
);

test("the geocoding filter finds a person by name, in both its lists", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Places", { exact: true }).click();
  await page.getByRole("button", { name: /Geocoding/ }).click();

  const places = page.locator(".tools-geocode .tools-tree > li:not(.v-spacer)");
  const box = page.locator(".tools-geocode .tools-search-input");
  await expect(places).toHaveCount(2);

  // A name — typed without its diacritics, and surname first — leaves the one
  // place that person's events are in.
  await box.fill("kovacic marija");
  await expect(places).toHaveCount(1);
  await expect(places.first()).toContainText("Kranj");

  // The addresses list narrows to the same person's house.
  await page.locator(".tools-geo-tabs [role=tab]", { hasText: "Addresses" }).click();
  const groups = page.locator(".tools-geo-addr-group");
  await expect(groups).toHaveCount(1);
  await expect(groups.first()).toContainText("Kranj");
  await expect(page.getByText("Zoisova 5")).toBeVisible();
});

test("the Organize sources filter finds a person by name", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Sources", { exact: true }).click();
  await page.getByRole("button", { name: /Organize sources/ }).click();

  // Marija's birth is the citation missing its page image; Blaž's has his.
  await page.getByRole("tab", { name: /Pages/ }).click();
  const rows = page.locator(".tools-cleanup-section .tools-tree > li");
  await expect(rows).toHaveCount(1);
  await rows.first().locator(".tools-tree-label").click();
  await expect(rows.first()).toContainText("Marija");

  // The box keeps the row for the person it names, and drops it for one whose
  // name is nowhere in this list.
  const box = page.locator(".tools-search-input").first();
  await box.fill("marija");
  await expect(rows).toHaveCount(1);
  await box.fill("nikogar");
  await expect(rows).toHaveCount(0);
  await expect(page.getByText("No matches.")).toBeVisible();
});
