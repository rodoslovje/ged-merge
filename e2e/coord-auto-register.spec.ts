import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// A register this browser holds needs no button: opening the coordinate panel
// is the question, and the houses are on offer at once. The position the event
// holds now stands in the same list, under a number of its own — the map draws
// it among the offers, and a dot no line accounts for cannot be weighed
// against the house that was found.

const FILE = path.join(tmpdir(), "coord-auto-register.ged");

writeFileSync(
  FILE,
  [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Janez /Rakar/",
    "1 RESI", "2 PLAC Gradac, Slovenija", "3 MAP", "4 LATI N45.61107", "4 LONG E15.23651", "2 ADDR Gradac 88",
    // The place's own position — an event naming no address.
    "0 @I2@ INDI", "1 NAME Jože /Rakar/",
    "1 BIRT", "2 PLAC Gradac, Slovenija", "3 MAP", "4 LATI N45.61107", "4 LONG E15.23651",
    "0 TRLR", "",
  ].join("\n"),
  "utf-8",
);

test("a stored register answers as the panel opens, beside the position held now", async ({ page }) => {
  // No online opt-in: nothing here may leave the browser.
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });

  // Store a one-house register through the app's own modules — the download
  // that fills it for real is half a million rows from a public service.
  await page.evaluate(async () => {
    const load = (file: string) => import(/* @vite-ignore */ file);
    const { AddressCollector } = await load("/src/geo/addressRegister.ts");
    const { putAddressRegister } = await load("/src/persist/geoDb.ts");
    const { invalidateAddressRegisters } = await load("/src/geo/addressLookup.ts");
    const collector = new AddressCollector("SI");
    collector.add({
      settlementId: "1", settlement: "Gradac", municipality: "Metlika", street: "", post: "8332 Gradac",
      number: 88, ext: "", ext2: 0, lat: 45.61411, lon: 15.24677,
    });
    await putAddressRegister(collector.index(Date.now()), collector.buckets());
    invalidateAddressRegisters();
  });

  const pin = page.locator(".edit-event .edit-event-coord").first();
  await expect(pin).toHaveClass(/edit-event-coord--place/);
  await pin.click();

  // The house, with no search pressed.
  const house = page.getByRole("button", { name: "Gradac 88, 8332 Gradac" });
  await expect(house).toBeVisible();
  await expect(page.getByRole("button", { name: "Search address register" })).toHaveCount(0);

  // And the position held now, named for what it is and numbered after it.
  const current = page.locator(".edit-coord-current-line");
  await expect(current).toContainText("The place's own position");
  await expect(current.locator(".tools-geo-cand-num")).toHaveText("2");

  await house.click();
  await expect(pin).not.toHaveClass(/edit-event-coord--place|edit-event-coord--empty/);
});
