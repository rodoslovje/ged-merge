import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import os from "os";
import path from "path";

// The address field reaches other settlements through the list of place+address
// pairs the file already writes, so typing a place name there is how an event is
// moved. Every offer used to carry a house, leaving no way to say "this place,
// no particular address" — and no way to take the place's own coordinate.

const FILE = path.join(os.tmpdir(), "place-finder-bare.ged");

writeFileSync(
  FILE,
  [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    // A settlement the file writes with a coordinate and several houses.
    "0 @I1@ INDI", "1 NAME Ana /Kern/", "1 SEX F",
    "1 BIRT", "2 PLAC Zgornje Bitnje,Kranj,Slovenia", "3 MAP", "4 LATI N46.2", "4 LONG E14.3",
    "2 ADDR Zgornje Bitnje 7",
    "0 @I2@ INDI", "1 NAME Jože /Kern/", "1 SEX M",
    "1 BIRT", "2 PLAC Zgornje Bitnje,Kranj,Slovenia", "3 MAP", "4 LATI N46.2", "4 LONG E14.3",
    "2 ADDR Zgornje Bitnje 13",
    // One event names the settlement with no house, so the file records a
    // position for the place itself — the only kind a bare-place pick may take
    // (a pin recorded against a house describes that house, not the village).
    "0 @I4@ INDI", "1 NAME Neža /Kern/", "1 SEX F",
    "1 BIRT", "2 PLAC Zgornje Bitnje,Kranj,Slovenia", "3 MAP", "4 LATI N46.2", "4 LONG E14.3",
    // A second settlement whose name also contains "bitnje", and houses entered
    // in no particular order, so grouping and numeric order are both visible.
    "0 @I5@ INDI", "1 NAME Ivan /Kern/", "1 SEX M",
    "1 BIRT", "2 PLAC Spodnje Bitnje,Kranj,Slovenia", "2 ADDR Spodnje Bitnje 11",
    "0 @I6@ INDI", "1 NAME Ema /Kern/", "1 SEX F",
    "1 BIRT", "2 PLAC Spodnje Bitnje,Kranj,Slovenia", "2 ADDR Spodnje Bitnje 2",
    "0 @I7@ INDI", "1 NAME Rok /Kern/", "1 SEX M",
    "1 BIRT", "2 PLAC Zgornje Bitnje,Kranj,Slovenia", "2 ADDR Zgornje Bitnje 2",
    // The person edited below, whose birth names neither place nor address.
    "0 @I3@ INDI", "1 NAME Anton /Kern/", "1 SEX M", "1 BIRT", "2 DATE 31 MAY 1897",
    "0 TRLR", "",
  ].join("\n"),
  "utf-8",
);

/** Open Anton and reveal his birth event's address field. */
async function antonsAddressField(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });

  await page.locator(".edit-search-input, .start-selector input, .start-wrap input").first().click();
  await page.getByRole("button", { name: /Search everyone/i }).click();
  await page.locator(".global-search-input, .global-search input").first().fill("Anton");
  await page.locator(".global-search-open").first().click();
  await expect(page.locator(".edit-name-input").first()).toHaveValue("Anton");

  const row = page.locator(".edit-event").first();
  await row.locator(".edit-event-type-row").hover();
  await row.locator(".edit-event-addfield").click();
  await page.locator('.dd-menu .dd-item[data-value="addr"]').click();
  return row.locator(".edit-event-addr").first();
}

test("the place itself leads the offers, above its houses", async ({ page }) => {
  const addr = await antonsAddressField(page);
  await addr.fill("zgornje bitnje");

  const options = page.locator(".place-suggestion");
  await expect(options.first()).toBeVisible();
  // First row: the place on its own, no " · house" after it.
  await expect(options.first()).toHaveText("Zgornje Bitnje,Kranj,Slovenia");
  // Its houses still follow.
  await expect(options.filter({ hasText: "Zgornje Bitnje 7" })).toHaveCount(1);
});

test("picking the place moves the event there and takes its coordinate", async ({ page }) => {
  const addr = await antonsAddressField(page);
  await addr.fill("zgornje bitnje");
  await page.locator(".place-suggestion").first().click();

  // The place is filled and the address left empty — the house was not chosen.
  await expect(page.locator(".edit-event-place").first()).toHaveValue("Zgornje Bitnje,Kranj,Slovenia");
  await expect(page.locator(".edit-event").first().locator(".edit-event-addr")).toHaveValue("");

  // And the settlement's own coordinate came with it.
  await page.locator(".app-head-actions .export-btn").click();
  const download = page.waitForEvent("download", (d) => d.suggestedFilename().endsWith(".ged"));
  await page.locator(".preview-actions .export-btn").click();
  const file = await (await download).path();
  const { readFileSync } = await import("fs");
  const ged = readFileSync(file!, "utf-8");
  const anton = ged.split(/\n0 /).find((r) => r.includes("Anton"))!;
  expect(anton).toContain("Zgornje Bitnje,Kranj,Slovenia");
  expect(anton).toMatch(/LATI N46\.2/);
});

test("a typed house number still offers the house, not the settlement", async ({ page }) => {
  const addr = await antonsAddressField(page);
  await addr.fill("Zgornje Bitnje 13");

  // Matched on the address text, so the pair leads — no bare-place row above it.
  await expect(page.locator(".place-suggestion").first()).toContainText("Zgornje Bitnje 13");
});

test("a place's houses stand together, in house-number order", async ({ page }) => {
  const addr = await antonsAddressField(page);
  await addr.fill("bitnje");

  const rows = await page.locator(".place-suggestion").allInnerTexts();
  const pairs = rows.filter((r) => r.includes("·")).map((r) => r.replace(/\s+/g, " ").trim());

  // Each settlement's houses are consecutive — no interleaving between places.
  const places = pairs.map((r) => r.split("·")[0].trim());
  expect(new Set(places).size).toBe(places.filter((p, i) => i === 0 || p !== places[i - 1]).length);

  // And within a settlement the numbers read 2, 7, 13 — not 13, 2, 7.
  const zgornje = pairs.filter((r) => r.startsWith("Zgornje Bitnje")).map((r) => r.split("·")[1].trim());
  expect(zgornje).toEqual(["Zgornje Bitnje 2", "Zgornje Bitnje 7", "Zgornje Bitnje 13"]);
});
