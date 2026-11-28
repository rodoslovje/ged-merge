import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// An address written under a street name the town has since changed. The
// answer; with a table of former street names loaded, the street is offered —
// marked with the old name it was found under — and the address in the file
// marked with the old name it was found under — and the address in the file
// stays as the record wrote it.

const FILE = path.join(tmpdir(), "former-street-names.ged");
const TABLE = path.join(tmpdir(), "former-street-names.csv");

writeFileSync(
  FILE,
  [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Ana /Kos/",
    "1 RESI", "2 PLAC Ljubljana, Slovenija", "2 ADDR Aleksandrova cesta 5",
    // A coordinate somewhere in the file, so events show their coordinate pin.
    "0 @I2@ INDI", "1 NAME Bo /Kos/",
    "1 BIRT", "2 PLAC Kranj, Slovenija", "3 MAP", "4 LATI N46.2389", "4 LONG E14.3556",
    "0 TRLR", "",
  ].join("\n"),
  "utf-8",
);

writeFileSync(
  TABLE,
  ["settlement,former_name,from,to,current_name", "Ljubljana,Aleksandrova cesta,1919,,Cankarjeva cesta", ""].join("\n"),
  "utf-8",
);

test("a loaded table of former street names finds the street under today's name", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });

  // Today's register, one house of it, stored through the app's own modules.
  await page.evaluate(async () => {
    const load = (file: string) => import(/* @vite-ignore */ file);
    const { AddressCollector } = await load("/src/geo/addressRegister.ts");
    const { putAddressRegister } = await load("/src/persist/geoDb.ts");
    const { invalidateAddressRegisters } = await load("/src/geo/addressLookup.ts");
    const collector = new AddressCollector("SI");
    collector.add({
      settlementId: "1", settlement: "Ljubljana", municipality: "Ljubljana", street: "Cankarjeva cesta",
      post: "1000 Ljubljana", number: 5, ext: "", ext2: 0, lat: 46.0525, lon: 14.5005,
    });
    await putAddressRegister(collector.index(Date.now()), collector.buckets());
    invalidateAddressRegisters();
  });

  const pin = page.getByRole("button", { name: "Coordinates for Residence" });
  const house = page.getByRole("button", { name: /Cankarjeva cesta, Ljubljana/ });

  // Load the table in Settings → Map; it is listed with what it holds.
  await page.getByRole("button", { name: "Settings" }).first().click();
  await page.getByRole("tab", { name: "Map" }).click();
  await page
    .locator(".tools-geo-source", { hasText: "Former street names" })
    .locator("input[type=file]")
    .setInputFiles(TABLE);
  await expect(page.locator(".tools-geo-countries li", { hasText: "Ljubljana — former street names: 1" })).toBeVisible();
  await page.locator(".modal-close").click();

  // Now the street is offered — its middle, since the number may have changed
  // with the name — marked with the name the record wrote.
  await pin.click();
  await expect(house).toBeVisible();
  await expect(house).toContainText("← Aleksandrova cesta (1919–)");
  await house.click();
  await expect(pin).not.toHaveClass(/edit-event-coord--empty/);
  // Only the coordinate was taken: the address still reads as it did.
  await expect(page.getByRole("textbox", { name: "Residence address" })).toHaveValue("Aleksandrova cesta 5");

  // A file that is not such a table is refused, and says why.
  await page.getByRole("button", { name: "Settings" }).first().click();
  await page.getByRole("tab", { name: "Map" }).click();
  await page
    .locator(".tools-geo-source", { hasText: "Former street names" })
    .locator("input[type=file]")
    .setInputFiles(FILE);
  await expect(page.locator(".tools-geo-source-error")).toContainText("not a table of former street names");
});

/** Open a file whose residence is "Aleksandrova" in Ljubljana, with an address
 *  register and a table of former street names stored in the browser. */
async function openWithStoredRegister(page: Page, online: boolean) {
  const file = path.join(tmpdir(), "former-street-names-field.ged");
  writeFileSync(
    file,
    [
      "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
      "0 @I1@ INDI", "1 NAME Ana /Kos/",
      "1 RESI", "2 PLAC Ljubljana, Ljubljana, Slovenija", "2 ADDR Aleksandrova",
      "0 @I2@ INDI", "1 NAME Bo /Kos/",
      "1 BIRT", "2 PLAC Kranj, Kranj, Slovenija", "3 MAP", "4 LATI N46.2389", "4 LONG E14.3556",
      "0 TRLR", "",
    ].join("\n"),
    "utf-8",
  );
  if (online) {
    // The one service the lookup would reach beside the stored register
    // answers nothing here.
    await page.addInitScript(() => {
      localStorage.setItem("gedmerge.settings", JSON.stringify({ allowLinkFetch: true }));
    });
    await page.route("**/nominatim.openstreetmap.org/**", (route) => route.fulfill({ json: [] }));
  }

  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(file);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });

  await page.evaluate(async () => {
    const load = (file: string) => import(/* @vite-ignore */ file);
    const { AddressCollector } = await load("/src/geo/addressRegister.ts");
    const { putAddressRegister, putFormerStreets } = await load("/src/persist/geoDb.ts");
    const { invalidateAddressRegisters } = await load("/src/geo/addressLookup.ts");
    const { invalidateFormerStreets } = await load("/src/geo/formerStreets.ts");
    const collector = new AddressCollector("SI");
    collector.add({
      settlementId: "1", settlement: "Ljubljana", municipality: "Ljubljana", street: "Cankarjeva cesta",
      post: "1000 Ljubljana", number: 5, ext: "", ext2: 0, lat: 46.0525, lon: 14.5005,
    });
    await putAddressRegister(collector.index(Date.now()), collector.buckets());
    await putFormerStreets({
      entries: [{ settlement: "Ljubljana", former: "Aleksandrova cesta", from: 1919, current: "Cankarjeva cesta" }],
      importedAt: Date.now(),
    });
    invalidateAddressRegisters();
    invalidateFormerStreets();
  });
}

test("the address field proposes a former street typed short under both its names", async ({ page }) => {
  await openWithStoredRegister(page, true);
  const address = page.getByRole("textbox", { name: "Residence address" });
  await address.click();
  await page.getByRole("button", { name: "Look this place up in the directories" }).click();

  // The offer names the street both ways, today's name first.
  const offer = page.locator(".suggest-item--register");
  await expect(offer).toHaveCount(1);
  await expect(offer).toContainText("Cankarjeva cesta / Aleksandrova cesta");

  // Picked, it replaces the start that was typed and places the event.
  await offer.dispatchEvent("mousedown");
  await expect(address).toHaveValue("Cankarjeva cesta / Aleksandrova cesta");
  await expect(page.getByRole("button", { name: "Coordinates for Residence" })).not.toHaveClass(/edit-event-coord--empty/);
});

test("a stored register answers the address field as it is typed, with online lookups off", async ({ page }) => {
  await openWithStoredRegister(page, false);
  const address = page.getByRole("textbox", { name: "Residence address" });
  await address.click();

  // No button to press — and none offered, since there is nothing online to ask.
  const offer = page.locator(".suggest-item--register");
  await expect(offer).toHaveCount(1);
  await expect(offer).toContainText("Cankarjeva cesta / Aleksandrova cesta");
  await expect(page.getByRole("button", { name: "Look this place up in the directories" })).toHaveCount(0);

  // The number written on today's name as well is answered with that house.
  await address.fill("Cankarjeva cesta 5 / Aleksandrova cesta 5");
  await expect(offer).toHaveCount(1);
  await expect(offer).toContainText("Cankarjeva cesta 5 / Aleksandrova cesta 5");
  await offer.dispatchEvent("mousedown");
  await expect(page.getByRole("button", { name: "Coordinates for Residence" })).not.toHaveClass(/edit-event-coord--empty/);
});
