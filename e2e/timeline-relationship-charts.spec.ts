import { test, expect, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// The Timeline and Relationship kinds of the chart hub end to end: each draws
// the people it should, and its exports carry them.
const FILE = path.join(tmpdir(), "timeline-relationship.ged");

writeFileSync(FILE, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Janez /Kos/", "1 SEX M",
  "1 BIRT", "2 DATE 4 MAY 1900", "2 PLAC Kranj,Slovenia",
  "1 DEAT", "2 DATE 1970",
  "1 FAMC @F1@", "1 FAMS @F3@",
  "0 @I2@ INDI", "1 NAME Anton /Kos/", "1 SEX M",
  "1 BIRT", "2 DATE 1870", "1 DEAT", "2 DATE 1940",
  "1 FAMC @F2@", "1 FAMS @F1@",
  "0 @I3@ INDI", "1 NAME Marija /Novak/", "1 SEX F",
  "1 BIRT", "2 DATE 1875", "1 DEAT", "2 DATE 1950",
  "1 FAMS @F1@",
  "0 @I4@ INDI", "1 NAME Jakob /Kos/", "1 SEX M",
  "1 BIRT", "2 DATE 1840", "1 DEAT", "2 DATE 1910",
  "1 FAMS @F2@",
  "0 @I5@ INDI", "1 NAME Mojca /Bergant/", "1 SEX F",
  "1 BIRT", "2 DATE 1905", "1 DEAT", "2 DATE 1985",
  "1 FAMS @F3@",
  "0 @I6@ INDI", "1 NAME Tone /Kos/", "1 SEX M",
  "1 BIRT", "2 DATE 1930", "1 DEAT", "2 DATE 2001",
  "1 FAMC @F3@",
  // Outside every line through Janez: must not appear on either chart.
  "0 @I7@ INDI", "1 NAME Polona /Tomc/", "1 SEX F",
  "1 BIRT", "2 DATE 1910",
  "0 @F1@ FAM", "1 HUSB @I2@", "1 WIFE @I3@", "1 CHIL @I1@",
  "1 MARR", "2 DATE 1898",
  "0 @F2@ FAM", "1 HUSB @I4@", "1 CHIL @I2@",
  "0 @F3@ FAM", "1 HUSB @I1@", "1 WIFE @I5@", "1 CHIL @I6@",
  "1 MARR", "2 DATE 1928",
  "0 TRLR", "",
].join("\n"), "utf-8");

const TIMELINE_KEY = "3";
const RELATIONSHIP_KEY = "4";

async function exportItem(page: Page, name: RegExp | string) {
  await page.locator(".export-menu .tree-export-btn").click();
  const dl = page.waitForEvent("download");
  await page.getByRole("menuitem", { name }).click();
  const d = await dl;
  return { name: d.suggestedFilename(), text: readFileSync((await d.path())!, "utf-8") };
}

test("timeline and relationship charts draw their people and export them", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await expect(page.locator(".edit-name-input").first()).toHaveValue("Janez");
  await page.locator(".charts-open-btn").first().click();

  // Timeline: one row per family member, oldest first, each with its kinship;
  // the outsider has no row.
  await page.keyboard.press(TIMELINE_KEY);
  const rows = page.locator(".timeline-row-name");
  await expect(rows).toHaveText([
    /^Jakob Kos1840–1910· Grandfather/,
    /^Anton Kos1870–1940· Father/,
    /^Marija Novak1875–1950· Mother/,
    /^Janez Kos1900–1970/,
    /^Mojca Bergant1905–1985· Spouse/,
    /^Tone Kos1930–2001· Son/,
  ]);
  // Births, deaths and marriages are marked on the bars.
  await expect(page.locator(".tree-svg .timeline-mark-marriage")).not.toHaveCount(0);
  await expect(page.locator(".tree-svg .timeline-mark-glyph", { hasText: "†" })).not.toHaveCount(0);

  const svg = await exportItem(page, "SVG image");
  expect(svg.name).toBe("Janez-Kos-Family-Timeline.gedmerge.svg");
  expect(svg.text).toContain("Janez Kos 1900–1970 — Family Timeline");
  for (const name of ["Jakob Kos", "Anton Kos", "Marija Novak", "Janez Kos", "Mojca Bergant", "Tone Kos"]) {
    expect(svg.text).toContain(`>${name}<`);
  }
  expect(svg.text).not.toContain("Polona");
  expect(svg.text).toContain(">1840<"); // the year axis starts at the oldest birth

  // Relationship: from Janez (the start person) to his grandfather Jakob.
  await page.keyboard.press(RELATIONSHIP_KEY);
  await page.locator(".relchart-endpoint").nth(1).click();
  await page.locator(".relchart-picker-bar input").fill("Jakob");
  await page.locator(".relchart-picker-bar .start-option", { hasText: "Jakob" }).click();
  await expect(page.locator(".tree-title-kinship")).toHaveText("Grandfather");
  const boxes = page.locator("svg.tree-svg");
  for (const text of ["Janez Kos", "Start Person", "Anton Kos", "Father", "Marija Novak", "Mother", "Jakob Kos", "Grandfather"]) {
    await expect(boxes.getByText(text, { exact: true })).toBeVisible();
  }
  await expect(boxes.getByText("Tone Kos")).toHaveCount(0);

  // Its GEDCOM export holds the route's people and their families only.
  const ged = await exportItem(page, /^GEDCOM \(4 people\)/);
  expect(ged.name).toBe("Janez-Kos-Jakob-Kos-Relationship-Chart.ged");
  const xrefs = ged.text.split(/\r?\n/).filter((l) => /^0 @/.test(l));
  expect(xrefs).toEqual(["0 @I1@ INDI", "0 @I2@ INDI", "0 @I3@ INDI", "0 @I4@ INDI", "0 @F1@ FAM", "0 @F2@ FAM"]);
  expect(ged.text).not.toContain("@F3@"); // Janez's own marriage is off the route
  expect(ged.text).toContain("1 NAME Jakob /Kos/");
  expect(ged.text.trimEnd().endsWith("0 TRLR")).toBe(true);

  expect(errors).toEqual([]);
});
