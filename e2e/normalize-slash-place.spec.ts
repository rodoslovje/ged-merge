import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// A place value whose levels are separated by slashes, in a file that otherwise
// writes PLAC + ADDR. The parser reads no levels in it, so the whole path came
// out as the "locality" with a house number behind it, and Normalize offered to
// split the two — leaving a place without its number and an address repeating
// the entire value. Nothing about such a value is understood well enough to
// reshape it, so the tool must find nothing to do here.
//
// Driven through the app rather than the function: the pass runs inside the
// tools worker, and this is the path the reader actually sees.
const FILE = path.join(tmpdir(), "normalize-slash-place.ged");

const SLASH_PLACE = "Kranj/Ulica Janeza Puharja 9/Grosova ulica 18";

writeFileSync(
  FILE,
  [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    // Enough ordinary records for the file's house style to be PLAC + ADDR.
    ...[1, 2, 3, 4, 5, 6].flatMap((i) => [
      `0 @I${i}@ INDI`, `1 NAME Oseba${i} /Novak/`, "1 SEX M",
      "1 BIRT", `2 DATE ${1860 + i}`, "2 PLAC Kranj, Kranj, Slovenia", `2 ADDR Prešernova ulica ${i}`,
    ]),
    // The path as the place …
    "0 @I9@ INDI", "1 NAME Jakob /Renka/", "1 SEX M",
    "1 BIRT", "2 DATE 1871", `2 PLAC ${SLASH_PLACE}`,
    // … and as the address, with no place beside it, which is the shape that
    // kept being offered: a PLAC minus the number, an ADDR repeating it all.
    "0 @I10@ INDI", "1 NAME Marija /Renka/", "1 SEX F",
    "1 BIRT", "2 DATE 1873", `2 ADDR ${SLASH_PLACE}`,
    "0 TRLR",
  ].join("\n"),
);

test("Normalize leaves a slash-separated place whole", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Normalize & batch", { exact: true }).click();
  await page.locator(".batch-section-tab", { hasText: "Normalize file" }).click();

  // The scan has finished when it says it found nothing to change.
  await expect(page.locator(".tools-clean--ok")).toBeVisible({ timeout: 20000 });
  // And the value is nowhere among the examples, split or otherwise.
  await expect(page.locator(".tools-examples")).toHaveCount(0);
  await expect(page.getByText(SLASH_PLACE, { exact: false })).toHaveCount(0);
});
