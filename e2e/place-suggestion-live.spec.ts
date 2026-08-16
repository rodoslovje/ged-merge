import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// A place typed on one record must be offered on the next one straight away.
// The dataset is mutated in place while editing, so the suggestion list used to
// be built once per loaded file: a village entered on a husband was invisible in
// his wife's place field until the file was saved and reloaded — exactly when
// the offer is wanted most, since the two events usually name the same place.

const FILE = path.join(tmpdir(), "place-suggestion-live.ged");

writeFileSync(
  FILE,
  [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Marko /Kočevar/", "1 SEX M",
    "1 BIRT", "2 PLAC Metlika,Metlika,Slovenia",
    "1 FAMS @F1@",
    "0 @I2@ INDI", "1 NAME Ana /Stipanič/", "1 SEX F",
    "1 BIRT", "2 PLAC Metlika,Metlika,Slovenia",
    "1 FAMS @F1@",
    "0 @F1@ FAM", "1 HUSB @I1@", "1 WIFE @I2@",
    "0 TRLR", "",
  ].join("\n"),
  "utf-8",
);

test("a place typed on one person is suggested on the next one, without a reload", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });

  // Whoever the file opens on, give their birth a place the file has never
  // written, and blur so the edit is committed.
  const place = page.locator(".edit-person .edit-event-place").first();
  await place.fill("Malo Lešče,Metlika,Slovenia");
  await page.locator(".edit-person .edit-name-input").first().click();

  // Over to the partner — same session, same dataset, no reload.
  await page.locator(".edit-families button.person-card").first().click();
  const partnerPlace = page.locator(".edit-person .edit-event-place").first();
  await expect(partnerPlace).toHaveValue("Metlika,Metlika,Slovenia");

  await partnerPlace.fill("Malo");
  await expect(page.locator(".place-suggestions li").first()).toContainText("Malo Lešče,Metlika,Slovenia");
});
