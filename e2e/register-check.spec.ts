import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// The compliance page end to end: a micro GURS register is served from route
// fixtures, imported through the real Settings › Map one-click flow, and the
// file's places are held against it — one compliant, one misspelled, one the
// register does not know. The misspelled row takes the official name; the
// unknown one is dismissed (a geoDb decision) and comes back via "Show
// dismissed". This was the one recently merged feature with no e2e at all.

const FILE = path.join(tmpdir(), "register-check.ged");
/** A file of 400 places the register does not know — past the 150 rows below
 *  which the list renders in full, so the windowing is the thing under test. */
const MANY = path.join(tmpdir(), "register-check-many.ged");
const MANY_COUNT = 400;

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

writeFileSync(
  MANY,
  [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    ...Array.from({ length: MANY_COUNT }, (_, i) => [
      `0 @I${i + 1}@ INDI`,
      `1 NAME Oseba${i + 1} /Kos/`,
      "1 BIRT",
      // Letters, never a trailing number: "Vas 001" reads as a house number,
      // which is a different finding entirely (the address split).
      `2 PLAC Vas ${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}, Slovenija`,
    ]).flat(),
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

/** Load a file with the micro register imported, and open the naming check. */
async function openNamingCheck(page: Page, file: string) {
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
  await page.locator("input.file-input").first().setInputFiles(file);
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
  // The naming check is its own page, opened beside Geocoding rather than
  // being a tab inside it.
  await page.getByRole("button", { name: /Naming/ }).click();
}

test("the compliance page: official name taken, an unknown place dismissed and recalled", async ({ page }) => {
  await openNamingCheck(page, FILE);

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

  // Hiding the unknown place files it under "Show hidden" (a decision
  // in this browser, never in the file) — and restoring brings it back.
  await unknown.getByRole("button", { name: "Hide" }).click();
  await expect(row(/Neznanovo, Slovenija/)).toHaveCount(0);
  await page.getByText("Show hidden").click();
  await expect(row(/Neznanovo, Slovenija/).first()).toBeVisible();
  await row(/Neznanovo, Slovenija/).first().getByRole("button", { name: "Restore" }).click();
  await page.getByText("Show hidden").click();
  await expect(row(/Neznanovo, Slovenija/).first()).toBeVisible();
});

test("every finding is reachable: the long list is windowed, not cut off", async ({ page }) => {
  // 400 places the register does not know. The list used to paint 300 of them
  // and tell the reader to narrow the rest away with the search box; now it
  // mounts only what is near the viewport and scrolls to the end.
  await openNamingCheck(page, MANY);

  const compliance = page.locator("section.tools-cleanup-section", { hasText: /match · SI-GURS/ });
  await expect(compliance.getByText(/0 of 400 match/)).toBeVisible({ timeout: 60000 });
  const rows = compliance.locator("li.tools-tree-node");

  // Nothing is held back behind the search any more.
  await expect(compliance.getByText(/more rows/)).toHaveCount(0);

  // Windowed: far fewer rows are in the DOM than the list holds.
  await expect.poll(() => rows.count(), { timeout: 15000 }).toBeLessThan(MANY_COUNT / 2);

  // And the last of the 400 is reached by scrolling — the whole point of the
  // cap being gone. The scroller is whichever ancestor actually scrolls, the
  // same one the windowing hook attaches to.
  // The 400th name: 399 = 15 * 26 + 9, so "P" and "j".
  const last = compliance.locator("li.tools-tree-node", { hasText: /Vas Pj/ });
  await expect(last).toHaveCount(0);
  // Scroll a page at a time until the last row is rendered. Bounded by time,
  // not by a count of iterations: under load the list needs the same number of
  // scrolls but longer to render each window, and a fixed 40 tries ran out
  // while the list was still catching up.
  await expect(async () => {
    await page.evaluate(() => {
      const spacer = document.querySelector(".tools-register-list .v-spacer");
      for (let el = spacer?.parentElement ?? null; el; el = el.parentElement) {
        if (/auto|scroll|overlay/.test(getComputedStyle(el).overflowY)) {
          el.scrollTop += el.clientHeight;
          return;
        }
      }
      window.scrollBy(0, window.innerHeight);
    });
    // Short: this only has to cover one window's re-render, and when it isn't
    // enough the next scroll simply follows. The cap on the whole climb is the
    // toPass budget below.
    await expect(last.first()).toBeVisible({ timeout: 200 });
  }).toPass({ timeout: 30_000 });
});
