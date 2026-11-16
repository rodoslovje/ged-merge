import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { tmpdir } from "./tmpdir";

// Tools → Family website end to end: the download is one HTML file that opens
// from disk, shows the people with the living reduced to initials, and runs
// the app's own charts and statistics — with no GEDCOM to take away.
const FILE = path.join(tmpdir(), "family-website.ged");

writeFileSync(FILE, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Petra /Zorman/", "1 SEX F",
  "1 BIRT", "2 DATE 12 MAR 1990", "2 PLAC Kranj,Slovenia",
  "1 FAMC @F1@",
  "0 @I2@ INDI", "1 NAME Franc /Zorman/", "1 SEX M",
  "1 BIRT", "2 DATE 3 JAN 1890", "2 PLAC Škofja Loka,Slovenia",
  "1 DEAT", "2 DATE 7 JUL 1960",
  "1 NOTE Franc's research note",
  "1 FAMS @F1@",
  "0 @I3@ INDI", "1 NAME Ivana /Bergant/", "1 SEX F",
  "1 BIRT", "2 DATE 1895",
  "1 DEAT", "2 DATE 1970",
  "1 FAMS @F1@",
  "0 @F1@ FAM", "1 HUSB @I2@", "1 WIFE @I3@", "1 CHIL @I1@",
  "1 MARR", "2 DATE 1920",
  "0 TRLR", "",
].join("\n"), "utf-8");

test("the family website downloads as one page that works from disk", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor();

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.locator(".tools-tab", { hasText: "Family website" }).click();
  await expect(page.locator(".tools-publish")).toContainText("The website will show 3 people and 1 families.");
  await page.locator(".tools-publish-field input").first().fill("Rodbina Zorman");
  // Downloads are off unless the author allows them; this site allows them.
  await page.getByLabel("Let visitors download charts, reports and statistics").check();

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download website (.html)" }).click();
  const file = await download;
  // The step indicator goes away once the page is written.
  await expect(page.locator(".tools-publish .tools-loading")).toHaveCount(0);
  expect(file.suggestedFilename()).toBe("rodbina-zorman.html");
  const html = readFileSync((await file.path())!, "utf-8");
  expect(html).not.toContain("research note");
  expect(html).not.toContain("@I1@");
  expect(html).not.toContain("Petra");

  // The page, opened from disk like a relative would.
  const site = path.join(tmpdir(), "rodbina-zorman.html");
  writeFileSync(site, html, "utf-8");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(pathToFileURL(site).href);
  await expect(page.locator(".site-hero h1")).toHaveText("Rodbina Zorman");

  // Search → person page.
  await page.locator("#site-search").fill("franc");
  await page.locator(".site-person-list .person-ref").first().click();
  await expect(page.locator(".site-person-name")).toContainText("Franc");
  await expect(page.locator(".site-events").first()).toContainText("Škofja Loka");

  // The header's search works where the reader is: from Franc's own page,
  // Ivana is found and opened in place.
  await page.locator(".site-search-btn").click();
  const found = page.locator(".site-search-pop input");
  await expect(found).toBeFocused();
  await found.fill("ivana");
  await page.locator(".site-search-pop .start-options li", { hasText: "Ivana" }).first().click();
  await expect(page.locator(".site-person-name")).toContainText("Ivana");
  await expect(page.locator(".site-search-pop")).toHaveCount(0);
  await page.goBack();
  await expect(page.locator(".site-person-name")).toContainText("Franc");

  // The visitor makes Franc their start person — from the start person's chip,
  // as in the app's Edit view: relatives are named from him.
  await page.locator(".site-person-kinship .start-chip").click();
  await page.getByRole("option", { name: "Make this person the start person" }).click();
  await expect(page.locator(".site-person-kinship")).toHaveText("Start Person");
  await expect(page.locator(".site-person-list li", { hasText: "P." })).toContainText("Daughter");

  // The living daughter: initials only, no details.
  await page.locator(".site-person-list .person-ref", { hasText: "P." }).click();
  await expect(page.locator(".site-person-kinship")).toHaveText("Daughter");
  await expect(page.locator(".site-note")).toBeVisible();
  await expect(page.locator(".site-events")).toHaveCount(0);

  // Charts: the app's own, without the branch GEDCOM export.
  // Her charts sit beside her name: the fan, and the path to the start
  // person — no timeline for a living person with nothing to draw.
  await expect(page.locator(".site-chart", { hasText: "Timeline" })).toHaveCount(0);
  await expect(page.locator(".site-chart", { hasText: "Relationship" })).toHaveCount(1);
  await page.locator(".site-chart", { hasText: "Fan" }).click();
  await expect(page).toHaveURL(/#\/c\/p[0-9a-z]+\/fan$/);
  await page.getByRole("tab", { name: "Tree", exact: true }).click();
  await expect(page.locator(".tree-page")).toBeVisible();
  await page.locator(".export-menu .tree-export-btn").click();
  await expect(page.getByText("GEDCOM", { exact: false })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Every chart has its own address: switching the chart rewrites it, and the
  // address opens that chart again.
  await expect(page).toHaveURL(/#\/c\/p[0-9a-z]+\/tree$/);
  await page.getByRole("tab", { name: "Timeline" }).click();
  await expect(page).toHaveURL(/#\/c\/p[0-9a-z]+\/timeline$/);
  const timelineUrl = page.url();
  await page.getByRole("tab", { name: "Tree", exact: true }).click();
  await expect(page).toHaveURL(/\/tree$/);
  await page.goto(timelineUrl);
  await page.reload();
  await expect(page.getByRole("tab", { name: "Timeline" })).toHaveAttribute("aria-selected", "true");

  // The view travels with it: the grid, one direction.
  await page.goto(timelineUrl.replace(/\/timeline$/, "/tree/grid/ancestors"));
  await page.reload();
  await expect(page.getByRole("tab", { name: /^Grid/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: /^Ancestors/ })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: /^Descendants/ }).click();
  await expect(page).toHaveURL(/\/tree\/grid\/descendants$/);

  // Statistics.
  await page.locator(".site-nav a", { hasText: "Statistics" }).click();
  await expect(page.locator(".site-stats .stats-tile-value").first()).toBeVisible();

  expect(errors).toEqual([]);
});
