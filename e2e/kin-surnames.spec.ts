import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// The Contemporaries chart's Surnames layout: the wheel's rings, shared out
// among continuous surname bands instead of dots.

// Root Ana Kovac (b. 1900): father Jožef Kovac, mother Marija Novak, brother
// Peter Kovac, son Tone Kovac, and a paternal grandfather Jakob Kovac. Every
// life overlaps Ana's, so the default Contemporaries scope keeps them all.
const FILE = path.join(tmpdir(), "kin-surnames.ged");
writeFileSync(FILE, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Ana /Kovac/", "1 SEX F",
  "1 BIRT", "2 DATE 1900", "1 DEAT", "2 DATE 1975",
  "1 FAMC @F1@", "1 FAMS @F2@",
  "0 @I2@ INDI", "1 NAME Jozef /Kovac/", "1 SEX M",
  "1 BIRT", "2 DATE 1870", "1 DEAT", "2 DATE 1940",
  "1 FAMC @F3@", "1 FAMS @F1@",
  "0 @I3@ INDI", "1 NAME Marija /Novak/", "1 SEX F",
  "1 BIRT", "2 DATE 1875", "1 DEAT", "2 DATE 1950", "1 FAMS @F1@",
  "0 @I4@ INDI", "1 NAME Peter /Kovac/", "1 SEX M",
  "1 BIRT", "2 DATE 1902", "1 DEAT", "2 DATE 1960", "1 FAMC @F1@",
  "0 @I5@ INDI", "1 NAME Tone /Kovac/", "1 SEX M",
  "1 BIRT", "2 DATE 1930", "1 DEAT", "2 DATE 1990", "1 FAMC @F2@",
  "0 @I6@ INDI", "1 NAME Jakob /Kovac/", "1 SEX M",
  "1 BIRT", "2 DATE 1840", "1 DEAT", "2 DATE 1910", "1 FAMS @F3@",
  "0 @F1@ FAM", "1 HUSB @I2@", "1 WIFE @I3@", "1 CHIL @I1@", "1 CHIL @I4@",
  "0 @F2@ FAM", "1 HUSB @I1@", "1 CHIL @I5@",
  "0 @F3@ FAM", "1 HUSB @I6@", "1 CHIL @I2@",
  "0 TRLR", "",
].join("\n"), "utf-8");

test("the surnames layout bands every relative and marks the elders' edge", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor();
  await page.locator(".charts-open-btn").first().click();
  // By name, not by digit: the digit moves whenever a kind is added or folded.
  await page.getByRole("tablist", { name: "Chart kind" }).getByRole("tab", { name: "Contemporaries" }).click();
  await expect(page.locator(".kin-svg")).toBeVisible();

  await page.getByRole("tablist", { name: "Layout" }).getByRole("tab", { name: "Surnames" }).click();

  // One section per surname, not per person: ring 1 holds Kovac the father,
  // Novak the mother and Kovac the son (a band of his own, being issue rather
  // than an elder); ring 2 the grandfather and the brother.
  await expect(page.locator(".kin-surname-band")).toHaveCount(5);
  // The hairline between the elders' run and the issue's is the whole point.
  await expect(page.locator(".kin-gen-split")).toHaveCount(4);
  await expect(page.locator(".kin-surname").first()).toBeVisible();

  // The colour key filters bands and their captions together — a caption left
  // behind by the band it named floats on bare ground and names nobody.
  await page.locator(".chart-settings-btn").first().click();
  await page.getByRole("button", { name: "Sex", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.locator(".kin-legend .map-kind-chip").last().click();
  await expect(page.locator(".kin-surname-band")).not.toHaveCount(5);
  const left = await page.locator(".kin-surname-band").count();
  await expect(page.locator(".kin-surname")).toHaveCount(left);
  await page.locator(".kin-legend .map-kind-chip").last().click();
  await expect(page.locator(".kin-surname-band")).toHaveCount(5);

  // Names off, bands stay: the toggle is the shared Contemporaries one.
  await page.locator(".chart-settings-btn").first().click();
  await page.getByRole("button", { name: "Names", exact: true }).click();
  await expect(page.locator(".kin-surname")).toHaveCount(0);
  await expect(page.locator(".kin-surname-band")).toHaveCount(5);
  await page.keyboard.press("Escape");

  // A band answers about its blood relatives, never with a person's own panel.
  // Dispatched rather than clicked: a band's bounding box is a rectangle across
  // half the chart, so a click at its centre can land on a neighbour.
  await page.locator(".kin-surname-band").first().dispatchEvent("click");
  await expect(page.locator(".kin-unplaced-panel")).toBeVisible();
  await expect(page.locator(".tree-compare")).toHaveCount(0);
});

test("a band lists its people with their lifespans and how they are related", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor();
  await page.locator(".charts-open-btn").first().click();
  await page.getByRole("tablist", { name: "Chart kind" }).getByRole("tab", { name: "Contemporaries" }).click();
  await page.getByRole("tablist", { name: "Layout" }).getByRole("tab", { name: "Surnames" }).click();
  await expect(page.locator(".kin-surname-band")).toHaveCount(5);

  // Ring 1 holds the father (Kovac), the mother (Novak) and the son (Kovac,
  // issue rather than an elder, so a band of his own).
  const father = page.locator('.kin-surname-band[aria-label="Kovac · 1 blood relative"]');
  await father.first().dispatchEvent("click");
  const panel = page.locator(".kin-unplaced-panel");
  await expect(panel).toBeVisible();
  const row = panel.locator(".kin-band-row").first();
  // Name in the sex colour, lifespan beside it, then the kinship.
  await expect(row.locator(".person-name")).toHaveClass(/sex-/);
  await expect(row.locator(".person-years")).toContainText("1870");
  await expect(row.locator(".person-kinship")).not.toBeEmpty();
  // Opening a band picks out every band of the same surname — the father, the
  // son and the grandfather are all Kovac — and stands the rest down. The
  // mother's Novak band is the only one left out.
  await expect(page.locator(".kin-surname-band.same")).toHaveCount(4);
  await expect(page.locator(".kin-surname-band.other")).toHaveCount(1);

  // Clicking the same band again closes it; nothing ever opens a person panel.
  await father.first().dispatchEvent("click");
  await expect(page.locator(".kin-surname-band.same")).toHaveCount(0);
  await expect(panel).toBeHidden();
  await expect(page.locator(".tree-compare")).toHaveCount(0);

  // Hovering says the same thing, in the chart's own hover card rather than a
  // plain browser tooltip: the names carry their sex colour and lifespan.
  await father.first().hover({ force: true });
  const card = page.locator(".chart-hover-card");
  await expect(card).toBeVisible();
  await expect(card.locator(".chart-hover-head")).toContainText("Kovac");
  // …and says which way the band lies and how far out it sits, which the list
  // of people underneath cannot say for itself.
  await expect(card.locator(".chart-hover-line")).toHaveText("Ancestors · blood distance 1");
  const hovered = card.locator(".chart-hover-people li").first();
  await expect(hovered.locator(".person-name")).toHaveClass(/sex-/);
  await expect(hovered.locator(".person-years")).toContainText("1870");
});
