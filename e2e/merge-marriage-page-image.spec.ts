import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// A marriage register's page image belongs beside the citation on the couple's
// MARR event, exactly as a baptism's does on the person's BIRT — and the merge
// writes it there. The Edit preview of a confirmed match has to say so too:
// the family's event rows once got the incoming citation but not the page
// image the save would link next to it.

const MAIN = path.join(tmpdir(), "marr-page-main.ged");
const COMPARE = path.join(tmpdir(), "marr-page-compare.ged");

const BOOK = "https://data.matricula-online.eu/sl/slovenia/ljubljana/radovica/04134";

writeFileSync(MAIN, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Marija /Rezek/", "1 SEX F",
  "1 BIRT", "2 DATE 19 MAR 1844", "2 PLAC Metlika", "2 OBJE @O1@", "2 SOUR @S1@", "3 PAGE 56",
  "1 FAMS @F1@",
  "0 @I2@ INDI", "1 NAME Marko /Nemanic/", "1 SEX M", "1 FAMS @F1@",
  "0 @F1@ FAM", "1 HUSB @I2@", "1 WIFE @I1@", "1 MARR", "2 DATE 19 FEB 1868", "2 PLAC Metlika",
  "0 @S1@ SOUR", "1 TITL Krstna knjiga - Radovica", "1 OBJE @O1@",
  "0 @O1@ OBJE", "1 FILE " + BOOK.replace("04134", "04130") + "/?pg=56",
  "0 @S5@ SOUR", "1 TITL Porocna knjiga - Radovica", "1 OBJE @O5@",
  "0 @O5@ OBJE", "1 FILE " + BOOK + "/?pg=3",
  "0 TRLR", "",
].join("\n"), "utf-8");

writeFileSync(COMPARE, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @P1@ INDI", "1 NAME Marija /Rezek/", "1 SEX F",
  "1 BIRT", "2 DATE 19 MAR 1844", "2 PLAC Metlika",
  "1 FAMS @G1@",
  "0 @P2@ INDI", "1 NAME Marko /Nemanic/", "1 SEX M", "1 FAMS @G1@",
  "0 @G1@ FAM", "1 HUSB @P2@", "1 WIFE @P1@", "1 MARR", "2 DATE 19 FEB 1868", "2 PLAC Metlika",
  "2 WWW " + BOOK + "/?pg=11",
  "0 TRLR", "",
].join("\n"), "utf-8");

test("a confirmed marriage link previews its page image on the marriage row", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(MAIN);
  await page.locator(".edit-person").first().waitFor();

  await page.getByRole("button", { name: "Merge", exact: true }).click();
  await page.locator("input.file-input").last().setInputFiles(COMPARE);
  await page.locator(".candidate").first().waitFor();
  await page.locator(".candidate-main").first().click();
  await page.locator(".decision-bar button").first().click();

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").first().waitFor();

  // The couple's marriage row: the incoming citation, and beside it the image
  // of the very page it cites.
  const marriage = page.locator(".edit-families .edit-event").first();
  await expect(marriage.locator(".source-ref--new")).toHaveCount(1);
  await expect(marriage.locator("a.link-icon.link-new")).toHaveCount(1);
  await expect(marriage.locator("a.link-icon.link-new")).toHaveAttribute("href", BOOK + "/?pg=11");
});
