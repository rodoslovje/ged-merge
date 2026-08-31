import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// Every page of the app is a browser-history step, and Back undoes them in the
// order they were visited. Before this, only the people opened in Edit and the
// full-page overlays recorded anything: switching mode, switching tool and
// opening a tool's page recorded nothing at all, so from Tools → Geocoding the
// browser's Back found only the app's bottom entry and tried to leave the page
// — which looked like a Back button that did nothing.

const FILE = path.join(tmpdir(), "page-history.ged");

writeFileSync(
  FILE,
  [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Ana /Kos/",
    "1 BIRT", "2 PLAC Kranj, Slovenija", "2 ADDR Stražišče 114",
    "0 @I2@ INDI", "1 NAME Jože /Kos/",
    "1 BIRT", "2 PLAC Bled, Slovenija",
    "0 @F1@ FAM", "1 HUSB @I2@", "1 WIFE @I1@",
    "0 TRLR", "",
  ].join("\n"),
  "utf-8",
);

const geocodeList = ".tools-geocode, .tools-geo-addr-list";

test("Back retraces Edit → Tools → Places → Geocoding one page at a time", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor();

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await expect(page.locator(".tools-view")).toBeVisible();
  // A tool of its own, then that tool's geocoding page.
  await page.getByRole("tab", { name: /Sources/ }).click();
  await page.getByRole("tab", { name: /Places/ }).click();
  await page.getByRole("button", { name: /Geocoding/ }).click();
  await expect(page.locator(geocodeList).first()).toBeVisible();

  // Back down the same stairs: the places tree, the sources tool, the tools
  // page, and Edit — each one press.
  await page.goBack();
  await expect(page.locator(geocodeList).first()).toBeHidden();
  await expect(page.locator(".tools-view")).toBeVisible();

  await page.goBack();
  await expect(page.locator(".tools-view")).toBeVisible();
  await expect(page.getByRole("tab", { name: /Sources/ })).toHaveAttribute("aria-selected", "true");

  await page.goBack();
  await expect(page.getByRole("tab", { name: /Places/ })).toHaveAttribute("aria-selected", "true");

  await page.goBack();
  await expect(page.locator(".edit-person")).toBeVisible();
  await expect(page.locator(".tools-view")).toBeHidden();

  // …and Forward climbs them again, which is the same record read the other way.
  await page.goForward();
  await expect(page.locator(".tools-view")).toBeVisible();
});

test("a tool's own Back walks up to its front page, and the browser's undoes that too", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor();

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByRole("button", { name: /Geocoding/ }).click();
  await expect(page.locator(geocodeList).first()).toBeVisible();

  // The page's own Back names where it lands — the tool's front page.
  await page.getByRole("button", { name: "Back to Places" }).click();
  await expect(page.locator(geocodeList).first()).toBeHidden();

  // And that walk up is a step like any other, so Back returns into geocoding.
  await page.goBack();
  await expect(page.locator(geocodeList).first()).toBeVisible();
});
