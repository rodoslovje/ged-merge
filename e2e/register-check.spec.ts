import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import os from "os";
import path from "path";

// The compliance page end to end: a micro GURS register is served from route
// fixtures, imported through the real Settings › Map one-click flow, and the
// file's places are held against it — one compliant, one misspelled, one the
// register does not know. The misspelled row takes the official name; the
// unknown one is dismissed (a geoDb decision) and comes back via "Show
// dismissed". This was the one recently merged feature with no e2e at all.

const FILE = path.join(os.tmpdir(), "register-check.ged");

writeFileSync(
  FILE,
  [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Ana /Kos/",
    "1 BIRT", "2 DATE 1900", "2 PLAC Kranj, Kranj, Slovenija",
    "0 @I2@ INDI", "1 NAME Bo /Kos/",
    "1 BIRT", "2 DATE 1901", "2 PLAC kranj, Kranj, Slovenija",
    "0 @I3@ INDI", "1 NAME Cene /Kos/",
    "1 BIRT", "2 DATE 1902", "2 PLAC Neznanovo, Slovenija",
    "0 TRLR", "",
  ].join("\n"),
  "utf-8",
);

/** A small polygon around a point, the shape rpeNaseljaToEntries reduces. */
const box = (lon: number, lat: number) => [
  [lon, lat], [lon + 0.01, lat], [lon + 0.01, lat + 0.01], [lon, lat + 0.01], [lon, lat],
];

const NASELJA = {
  features: [
    { properties: { NAZIV: "Kranj", EID_OBCINA: "o-kranj" }, geometry: { type: "Polygon", coordinates: [box(14.35, 46.23)] } },
    { properties: { NAZIV: "Bled", EID_OBCINA: "o-bled" }, geometry: { type: "Polygon", coordinates: [box(14.1, 46.36)] } },
  ],
};
const OBCINE = {
  features: [
    { properties: { EID_OBCINA: "o-kranj", NAZIV: "Kranj" } },
    { properties: { EID_OBCINA: "o-bled", NAZIV: "Bled" } },
  ],
};

test("the compliance page: official name taken, an unknown place dismissed and recalled", async ({ page }) => {
  // The GURS download is behind the online opt-in; seed it instead of driving
  // the settings toggle, which is not what this spec is about.
  await page.addInitScript(() => {
    localStorage.setItem("gedmerge.settings", JSON.stringify({ allowLinkFetch: true }));
  });
  await page.route("**/ipi.eprostor.gov.si/**", (route) => {
    const url = route.request().url();
    if (url.includes("NASELJA")) return route.fulfill({ json: NASELJA });
    if (url.includes("OBCINE")) return route.fulfill({ json: OBCINE });
    return route.fulfill({ status: 404, body: "not fixtured" });
  });

  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });

  // Import the register through the real one-click flow.
  await page.locator('button[title*="etting"]').first().click();
  await page.getByRole("tab", { name: "Map" }).click();
  // The register's name is a label above its two downloads (places, addresses),
  // not words inside either button — so the row is found by the name and the
  // button by what it fetches.
  const gursBtn = page
    .locator(".tools-geo-source", { hasText: "GURS (Slovenia)" })
    .getByRole("button", { name: "Places" });
  const imported = page.locator(".tools-geo-countries li", { hasText: "SI-GURS" });
  await gursBtn.click();
  try {
    await imported.waitFor({ timeout: 5000 });
  } catch {
    // The manager re-renders as its stored-countries load settles, which can
    // swallow the first click — once is enough to retry.
    await gursBtn.click();
    await imported.waitFor({ timeout: 20000 });
  }
  await page.locator(".modal-close").click();

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Places", { exact: true }).click();
  // Compliance is its own page now, opened beside Geocoding rather than being
  // a tab inside it.
  await page.getByRole("button", { name: /Compliance/ }).click();

  // One place matches; the misspelled and the unknown one are findings, each
  // under its verdict. (Locators are scoped to the findings rows — the Edit
  // view stays mounted behind a display toggle, and its inputs carry the same
  // place texts.)
  await expect(page.getByText(/1 of 3 match/)).toBeVisible({ timeout: 30000 });
  // Scoped to the compliance section: the Places tab stays mounted behind a
  // display toggle and lists the very same place values. A RegExp, not a
  // string — hasText strings additionally match case-insensitively.
  const compliance = page.locator("section.tools-cleanup-section", { hasText: /match · SI-GURS/ });
  const row = (text: RegExp) => compliance.locator("li.tools-tree-node", { hasText: text });
  const spelling = row(/kranj, Kranj, Slovenija/).first();
  await expect(spelling.getByText("Spelling")).toBeVisible();
  const unknown = row(/Neznanovo, Slovenija/).first();
  await expect(unknown.getByText("Unknown")).toBeVisible();

  // Taking the official name renames the value into the compliant spelling —
  // the two values merge into one distinct place, and the findings shrink.
  await spelling.getByRole("button", { name: "Use official name" }).click();
  await expect(page.getByText(/1 of 2 match/)).toBeVisible({ timeout: 15000 });

  // Dismissing the unknown place files it under "Show dismissed" (a decision
  // in this browser, never in the file) — and restoring brings it back.
  await unknown.getByRole("button", { name: "Hide" }).click();
  await expect(row(/Neznanovo, Slovenija/)).toHaveCount(0);
  await page.getByText("Show dismissed").click();
  await expect(row(/Neznanovo, Slovenija/).first()).toBeVisible();
  await row(/Neznanovo, Slovenija/).first().getByRole("button", { name: "Restore" }).click();
  await page.getByText("Show dismissed").click();
  await expect(row(/Neznanovo, Slovenija/).first()).toBeVisible();
});
