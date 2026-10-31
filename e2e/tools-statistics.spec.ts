import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// Tools → Statistics end to end: the overview counts the file, a bar lists the
// people behind it, the scope narrows to the start person's ancestors, and the
// pages are history steps.
const FILE = path.join(tmpdir(), "tools-statistics.ged");

writeFileSync(FILE, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Petra /Zorman/", "1 SEX F",
  "1 BIRT", "2 DATE 12 MAR 1925", "2 PLAC Kranj, Slovenia",
  "1 DEAT", "2 DATE 1990",
  "1 FAMC @F1@",
  "0 @I2@ INDI", "1 NAME Franc /Zorman/", "1 SEX M",
  "1 BIRT", "2 DATE 3 JAN 1890", "2 PLAC Škofja Loka, Slovenia",
  "1 DEAT", "2 DATE 7 JUL 1960",
  "1 FAMS @F1@",
  "0 @I3@ INDI", "1 NAME Ivana /Bergant/", "1 SEX F",
  "1 BIRT", "2 DATE 1895",
  "1 DEAT", "2 DATE 1970",
  "1 FAMS @F1@",
  "0 @I4@ INDI", "1 NAME Marko /Horvat/", "1 SEX M",
  "1 BIRT", "2 DATE 1930", "2 PLAC Zagreb, Croatia",
  "1 DEAT", "2 DATE 1931",
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
  await panel.getByRole("button", { name: "0–4: 1", exact: true }).click();
  await expect(panel.locator(".stats-pick .tools-issue")).toHaveCount(1);
  await expect(panel.locator(".stats-pick")).toContainText("Marko");

  // Back returns to the overview page.
  await page.goBack();
  await expect(panel.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");

  expect(errors).toEqual([]);
});
