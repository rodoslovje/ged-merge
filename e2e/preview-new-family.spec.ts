import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// Adding one parent writes two records: the person, and the family that holds
// them and the child. Both belong in the save preview — but the family's head
// is its couple, and a family with one spouse had only her name and her years
// in it, which is exactly what the person's own card says. The same person
// appeared to be listed twice, one of the two saying nothing at all.

const FILE = path.join(tmpdir(), "preview-new-family.ged");

writeFileSync(
  FILE,
  [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Benjamin /Gluhak/", "1 SEX M",
    "1 BIRT", "2 DATE 1 JAN 1993",
    "0 TRLR", "",
  ].join("\n"),
  "utf-8",
);

test("a new one-spouse family is not read as a second copy of the person", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor();

  // Add a mother — a new person, and a new family holding her and Benjamin.
  await page.locator(".edit-parents .person-card-add", { hasText: "Add mother" }).first().click();
  await page.locator(".relative-picker-new").click();
  await page.locator(".edit-name-input").first().waitFor();
  await page.locator(".edit-name-input").first().fill("Pavla Gluhak");

  await page.locator(".app-head-actions .export-btn").click();
  const cards = page.locator(".preview-card");
  await expect(cards).toHaveCount(3);

  // Her own card, and the family's — told apart by the side the family has
  // not got, which the family card now shows.
  const heads = page.locator(".preview-card-head").filter({ hasText: "Pavla Gluhak" });
  await expect(heads).toHaveCount(2);
  await expect(cards.locator(".preview-rec-nospouse")).toHaveCount(1);
});
