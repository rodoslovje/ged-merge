import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import os from "os";
import path from "path";

// The address pin: every address the UI shows carries it, so a bare "Stražišče
// 11" is not read as one more name for the place beside it.

const FILE = path.join(os.tmpdir(), "addr-pin.ged");

writeFileSync(
  FILE,
  [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Ana /Kos/",
    "1 BIRT", "2 PLAC Kranj, Slovenija", "3 MAP", "4 LATI N46.24137", "4 LONG E14.35580", "2 ADDR Stražišče 114",
    "1 DEAT", "2 PLAC Kranj, Slovenija", "2 ADDR Stražišče",
    "0 TRLR", "",
  ].join("\n"),
  "utf-8",
);

/** The ::before marker is a mask, so it has no box of its own to assert on —
 *  ask the computed style whether the pin mask is actually painted. */
async function pinned(page: import("@playwright/test").Page, selector: string) {
  return page.locator(selector).first().evaluate((el) => {
    const s = getComputedStyle(el, "::before");
    const mask = s.maskImage === "none" || !s.maskImage ? s.webkitMaskImage : s.maskImage;
    return { mask: mask ?? "", content: s.content };
  });
}

test("addresses are shown with a pin, in both themes", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });

  // Edit view: the event's coordinate pin already stands before the address —
  // the address itself adds no second pin there.
  await expect(page.locator(".edit-event .edit-event-coord").first()).toBeVisible();
  await expect(page.locator(".edit-event-extra[data-detail='addr'] .gm-addr")).toHaveCount(0);

  // And a coordinate carries the same pin, so the numbers read as a position —
  // green for the one the event actually holds.
  await page.locator(".edit-event .edit-event-coord").first().click();
  await expect(page.locator(".edit-coord-current .gm-coord--set")).toBeVisible();
  await page.keyboard.press("Escape");

  // The geocode list: the address row itself.
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Places", { exact: true }).click();
  await page.getByRole("button", { name: /Geocoding/ }).click();
  await page.getByRole("tab", { name: /Addresses/ }).click();
  await page.locator(".tools-geo-addr-group .tools-pair-toggle").first().click();
  const row = await pinned(page, ".tools-geo-addr-row .tools-geo-cand-name");
  expect(row.mask).toContain("svg");
  // Unplaced houses: the pin is there but muted, like Edit's empty one.
  await expect(page.locator(".tools-geo-addr-row .gm-addr--set")).toHaveCount(0);


  // The mask is a shape, not a colour: it survives the light theme, where it
  // takes the text colour like everything else.
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  const light = await pinned(page, ".tools-geo-addr-row .tools-geo-cand-name");
  expect(light.mask).toContain("svg");
});
