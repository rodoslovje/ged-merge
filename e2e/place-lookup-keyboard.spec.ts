import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// A new person is typed in without the mouse, and the place is where that used
// to stop: the lookup row at the foot of the place dropdown could be reached
// with Tab, but Enter on it closed the dropdown — the button disabled itself
// while it searched, the focus it held fell out of the field, and the answers
// arrived in a list nobody could see. The lookup has to work from the keyboard
// both ways: Tab + Enter, and ↓ past the last suggestion + Enter, each ending
// with the first answer highlighted so one more Enter takes it.

const FILE = path.join(tmpdir(), "place-lookup-keyboard.ged");

writeFileSync(
  FILE,
  [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Marko /Kočevar/", "1 SEX M",
    "1 BIRT", "2 DATE 1 JAN 1900", "2 PLAC Metlika",
    "0 TRLR", "",
  ].join("\n"),
  "utf-8",
);

async function openWithLookup(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("gedmerge.settings", JSON.stringify({ allowLinkFetch: true }));
  });
  // Every online register answers nothing, except OpenStreetMap.
  await page.route("**/gov.genealogy.net/**", (route) => route.abort());
  await page.route("**/ipi.eprostor.gov.si/**", (route) => route.abort());
  await page.route("**/nominatim.openstreetmap.org/**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify([
        {
          lat: "47.7557",
          lon: "-122.3415",
          name: "Shoreline",
          display_name: "Shoreline, King County, Washington, United States",
          type: "city",
          category: "place",
          address: { city: "Shoreline", county: "King County", state: "Washington", country: "United States" },
        },
      ]),
    }),
  );
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });
}

test("the place lookup runs from the keyboard with Tab and Enter", async ({ page }) => {
  await openWithLookup(page);
  const place = page.locator(".edit-person .edit-event-place").first();
  await place.fill("");
  await page.keyboard.type("Shoreline, Washington");

  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Search the online directories too" })).toBeFocused();
  await page.keyboard.press("Enter");

  // The answer arrives in a dropdown that is still open, highlighted, with the
  // keyboard back in the field.
  const offer = page.locator(".suggest-item--register").first();
  await expect(offer).toBeVisible({ timeout: 10000 });
  await expect(offer).toHaveClass(/suggest-item--hi/);
  await expect(place).toBeFocused();

  await page.keyboard.press("Enter");
  // The file writes its places one level deep, so the offer is taken as such.
  await expect(place).toHaveValue("Shoreline");
  await expect(page.locator(".suggest-list")).toHaveCount(0);
});

test("the place lookup is reached with the arrow keys, past the last suggestion", async ({ page }) => {
  await openWithLookup(page);
  const place = page.locator(".edit-person .edit-event-place").first();
  await place.fill("");
  await page.keyboard.type("Shoreline, Washington");

  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".suggest-list-foot")).toHaveClass(/suggest-list-foot--hi/);
  await page.keyboard.press("Enter");

  const offer = page.locator(".suggest-item--register").first();
  await expect(offer).toBeVisible({ timeout: 10000 });
  await expect(offer).toHaveClass(/suggest-item--hi/);
  await page.keyboard.press("Enter");
  await expect(place).toHaveValue("Shoreline");
});
