import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// An address naming a street and no house on it. The register cannot place the
// house, but it can say where the street is — the mean of the houses it files
// there — and that is as exact as such an address gets, so the pin that was
// amber on the settlement's position turns into the ordinary placed one.

const FILE = path.join(tmpdir(), "street-middle.ged");

writeFileSync(
  FILE,
  [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Ana /Kos/",
    "1 RESI", "2 PLAC Kranj, Slovenija", "3 MAP", "4 LATI N46.24137", "4 LONG E14.35580", "2 ADDR Hafnarjeva pot",
    // The place's own position — an event naming no address.
    "0 @I2@ INDI", "1 NAME Jože /Kos/",
    "1 BIRT", "2 PLAC Kranj, Slovenija", "3 MAP", "4 LATI N46.24137", "4 LONG E14.35580",
    "0 TRLR", "",
  ].join("\n"),
  "utf-8",
);

const house = (number: number, E: number, N: number) => ({
  properties: { NASELJE_NAZIV: "Kranj", OBCINA_NAZIV: "Kranj", ULICA_NAZIV: "Hafnarjeva pot", HS_STEVILKA: number, E, N },
});

test("a street without a number is placed at the middle of its houses", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("gedmerge.settings", JSON.stringify({ allowLinkFetch: true }));
  });
  await page.route("**/ipi.eprostor.gov.si/**", (route) => {
    const url = decodeURIComponent(route.request().url());
    const features = url.includes("ULICA_NAZIV LIKE 'Hafnarjeva pot%'")
      ? [house(2, 449300, 121200), house(20, 449500, 121400)]
      : [];
    return route.fulfill({ json: { features } });
  });

  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });

  const pin = page.locator(".edit-event .edit-event-coord").first();
  await expect(pin).toHaveClass(/edit-event-coord--place/);

  await pin.click();
  await page.getByRole("button", { name: "Search address register" }).click();
  await page.getByRole("button", { name: /Hafnarjeva pot, Kranj — middle of the street \(houses: 2\)/ }).click();

  await expect(pin).not.toHaveClass(/edit-event-coord--place|edit-event-coord--empty/);
});
