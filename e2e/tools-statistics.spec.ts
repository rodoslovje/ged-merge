import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// Tools → Statistics end to end: the overview counts the file, a bar lists the
// people behind it, the scope narrows to the start person's ancestors, and the
// pages are history steps.
const FILE = path.join(tmpdir(), "tools-statistics.ged");

writeFileSync(FILE, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Petra /Zorman/", "1 SEX F",
  "1 BIRT", "2 DATE 12 MAR 1925", "2 PLAC Kranj, Gorenjska, Slovenia",
  "1 DEAT", "2 DATE 1990",
  "1 FAMC @F1@",
  "0 @I2@ INDI", "1 NAME Franc /Zorman/", "1 SEX M", "1 OCCU kmet",
  "1 BIRT", "2 DATE 3 JAN 1890", "2 PLAC Škofja Loka, Slovenia",
  "1 DEAT", "2 DATE 7 JUL 1960",
  "1 FAMS @F1@",
  "0 @I3@ INDI", "1 NAME Ivana /Bergant/", "1 SEX F",
  "1 BIRT", "2 DATE 1895",
  "1 DEAT", "2 DATE 1970",
  "1 FAMS @F1@",
  "0 @I4@ INDI", "1 NAME Marko /Horvat/", "1 SEX M",
  "1 BIRT", "2 DATE 1930", "2 PLAC Zagreb, Croatia",
  "1 DEAT", "2 DATE 1931", "2 CAUS davica",
  "0 @F1@ FAM", "1 HUSB @I2@", "1 WIFE @I3@", "1 CHIL @I1@",
  "1 MARR", "2 DATE 12 JUN 1920",
  "0 TRLR", "",
].join("\n"), "utf-8");

test("statistics count the file, list who is behind a bar and narrow the scope", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor();

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Statistics", { exact: true }).first().click();
  const panel = page.locator(".tools-stats-panel");
  const people = panel.locator(".stats-tile", { hasText: "People" });
  await expect(people.locator(".stats-tile-value")).toHaveText("4");
  await expect(panel.locator(".stats-tile", { hasText: "Birth years" })).toContainText("1890–1930");
  // A place reads by its own name, flagged by its country; the whole value is the tip.
  await expect(panel.locator(".stats-card", { has: page.getByRole("heading", { name: "Birth places", exact: true }) }).locator(".stats-bar-label", { hasText: "Kranj" })).toHaveText("🇸🇮 Kranj");

  // The completeness row lists who is missing a birth place.
  await panel.locator(".stats-bar", { hasText: "Birth place" }).click();
  const pick = panel.locator(".stats-pick");
  await expect(pick.locator(".tools-issue")).toHaveCount(1);
  await expect(pick).toContainText("Ivana");

  // A country chip narrows every number.
  await panel.locator(".tools-chip", { hasText: "Croatia" }).click();
  await expect(people.locator(".stats-tile-value")).toHaveText("1");
  await panel.locator(".tools-chip", { hasText: "All" }).click();

  // A line follows the app's start person (Petra: herself and her parents)
  // until another is picked here; the house gives the line back to Petra.
  await panel.getByRole("tab", { name: "Ancestors" }).click();
  await expect(panel.locator(".tools-summary")).toHaveText("3 of 4 people in scope");
  await panel.locator(".stats-start input").fill("Marko");
  await panel.locator(".stats-start .start-option", { hasText: "Marko" }).click();
  await expect(panel.locator(".tools-summary")).toHaveText("1 of 4 people in scope");
  await panel.getByRole("button", { name: "Back to the start person" }).click();
  await expect(panel.locator(".tools-summary")).toHaveText("3 of 4 people in scope");
  await panel.getByRole("tab", { name: "All", exact: true }).click();

  // Lifespan: the infant death is the one bar under five.
  await panel.getByRole("tab", { name: "Lifespan" }).click();
  await panel.locator(".stats-card", { has: page.getByRole("heading", { name: "Age at death", exact: true }) }).getByRole("button", { name: "0–4: 1", exact: true }).click();
  await expect(panel.locator(".stats-pick .tools-issue")).toHaveCount(1);
  await expect(panel.locator(".stats-pick")).toContainText("Marko");

  // Death lists the cause as written; Occupation the occupation, each opening its people.
  await panel.getByRole("tab", { name: "Death" }).click();
  await panel.locator(".stats-bar", { hasText: "davica" }).click();
  await expect(panel.locator(".stats-pick")).toContainText("Marko");
  await panel.getByRole("tab", { name: "Occupation" }).click();
  await panel.locator(".stats-bar", { hasText: "kmet" }).click();
  await expect(panel.locator(".stats-pick")).toContainText("Franc");

  // Each page is a step of its own: Back retraces them to the overview.
  for (const name of ["Death", "Lifespan", "Overview"]) {
    await page.goBack();
    await expect(panel.getByRole("tab", { name })).toHaveAttribute("aria-selected", "true");
  }

  expect(errors).toEqual([]);
});

test("generations follow the line's person, research counts the sources", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor();
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  const panel = page.locator(".tools-stats-panel");
  await panel.locator(".stats-tile").first().waitFor();

  // Petra's two parents fill her first generation; she has no descendants.
  await panel.getByRole("tab", { name: "Generations" }).click();
  await expect(panel.locator(".stats-tile", { has: page.locator(".stats-tile-label", { hasText: /^Ancestors$/ }) }).locator(".stats-tile-value")).toHaveText("2");
  await panel.locator(".stats-card", { has: page.getByRole("heading", { name: "Ancestors by generation", exact: true }) }).locator(".stats-bar").first().click();
  await expect(panel.locator(".stats-pick .tools-issue")).toHaveCount(2);

  // No event in the file cites a source.
  await panel.getByRole("tab", { name: "Research" }).click();
  await expect(panel.locator(".stats-tile", { hasText: "Events with a source" }).locator(".stats-tile-value")).toHaveText("0%");

  // Without coordinates there are no distances, and the page says why.
  await panel.getByRole("tab", { name: "Migration" }).click();
  await expect(panel.locator(".stats-note")).toBeVisible();

  expect(errors).toEqual([]);
});

test("a card and the people behind a bar download as CSV", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor();
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  const panel = page.locator(".tools-stats-panel");
  const completeness = panel.locator(".stats-card", { has: page.getByRole("heading", { name: "Completeness", exact: true }) });

  const cardCsv = page.waitForEvent("download");
  await completeness.getByRole("button", { name: "Export" }).click();
  await completeness.getByRole("menuitem", { name: "CSV table" }).click();
  const numbers = readFileSync((await (await cardCsv).path())!, "utf-8");
  expect(numbers).toContain("Birth place,3,4,75%");

  await completeness.locator(".stats-bar", { hasText: "Birth place" }).click();
  const listCsv = page.waitForEvent("download");
  await completeness.getByRole("button", { name: "Download the list as CSV" }).click();
  const list = readFileSync((await (await listCsv).path())!, "utf-8");
  expect(list).toContain("@I3@,Ivana Bergant,1895–1970");

  // The card as a picture: its title and rows drawn as SVG text.
  const cardSvg = page.waitForEvent("download");
  await completeness.getByRole("button", { name: "Export" }).click();
  await completeness.getByRole("menuitem", { name: "SVG image" }).click();
  const svg = readFileSync((await (await cardSvg).path())!, "utf-8");
  expect(svg).toContain("<svg");
  expect(svg).toContain(">Completeness<");
  expect(svg).toContain(">Birth place<");

  // The whole page as a PNG.
  const pagePng = page.waitForEvent("download");
  await panel.locator(".stats-head").getByRole("button", { name: "Export" }).click();
  await panel.locator(".stats-head").getByRole("menuitem", { name: "PNG image" }).click();
  const png = await pagePng;
  expect(png.suggestedFilename()).toMatch(/\.png$/);
  expect(readFileSync((await png.path())!).subarray(1, 4).toString()).toBe("PNG");
});
