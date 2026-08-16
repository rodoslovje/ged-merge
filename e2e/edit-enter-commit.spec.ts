import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// Editing should be doable from the keyboard alone. Fields commit on blur, so
// without a key that leaves the field, focus stayed in the input you had just
// typed into and every bare app key went into it as text: after entering a
// place, "M" typed an m instead of switching to Merge mode.

const FILE = path.join(tmpdir(), "edit-enter-commit.ged");

writeFileSync(
  FILE,
  [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Marko /Kočevar/", "1 SEX M",
    "1 BIRT", "2 PLAC Metlika,Metlika,Slovenia",
    "0 TRLR", "",
  ].join("\n"),
  "utf-8",
);

test("Enter commits an edit field and hands the keyboard back to the app", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });

  const place = page.locator(".edit-person .edit-event-place").first();
  await place.click();
  await place.fill("Bojanja vas,Metlika,Slovenia");
  await page.keyboard.press("Enter");

  // The field kept the value and let go of the keyboard.
  await expect(place).toHaveValue("Bojanja vas,Metlika,Slovenia");
  await expect(place).not.toBeFocused();

  // So a bare mode key is a mode key again, not typing.
  await page.keyboard.press("m");
  await expect(page.locator(".mode-tabs .seg-btn.active")).toHaveCount(1);
  await expect(page.locator(".mode-tabs .seg-btn").nth(1)).toHaveClass(/active/);
  await expect(place).toHaveValue("Bojanja vas,Metlika,Slovenia");
});
