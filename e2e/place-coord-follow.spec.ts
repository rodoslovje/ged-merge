import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "fs";
import os from "os";
import path from "path";

// An event's coordinate belongs to the place it was recorded for. Moving the
// event to another place must take the file's position for that place — or, when
// the file has none, leave the event unplaced rather than at the old village.
const FIXTURE = path.join(os.tmpdir(), "place-coord-follow.ged");

writeFileSync(FIXTURE, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Ana /Kocevar/", "1 SEX F",
  "1 BIRT", "2 DATE 5 DEC 1783",
  "2 PLAC Lesce,Radovljica,Slovenia",
  "3 MAP", "4 LATI N46.363000", "4 LONG E14.157000",
  // A second person puts Malo Lesce on the map, so the file knows that place.
  "0 @I2@ INDI", "1 NAME Marko /Kocevar/", "1 SEX M",
  "1 BIRT", "2 DATE 14 MAY 1777",
  "2 PLAC Malo Lesce,Metlika,Slovenia",
  "3 MAP", "4 LATI N45.647000", "4 LONG E15.310000",
  "0 TRLR", "",
].join("\n"), "utf-8");

async function saveAndRead(page: import("@playwright/test").Page): Promise<string> {
  const saveBtn = page.locator(".app-head-actions .export-btn");
  await expect(saveBtn).toBeEnabled();
  await saveBtn.click();
  const download = page.waitForEvent("download", (d) => d.suggestedFilename().endsWith(".ged"));
  await page.locator(".preview-actions .export-btn").click();
  return readFileSync((await (await download).path())!, "utf-8");
}

/** @I1@'s birth event as saved, so the assertions read one record's lines. */
function birthOf(ged: string, xref: string): string {
  const from = ged.indexOf(`0 ${xref} INDI`);
  const next = ged.indexOf("\n0 ", from + 1);
  return ged.slice(from, next === -1 ? undefined : next);
}

test("moving an event to a place the file knows takes that place's position", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FIXTURE);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });

  const place = page.locator(".edit-person").first().locator(".edit-event-place").first();
  await expect(place).toHaveValue("Lesce,Radovljica,Slovenia");
  await place.fill("Malo Lesce,Metlika,Slovenia");
  // Escape closes the suggestion dropdown; Tab out of the field commits.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Tab");

  const birth = birthOf(await saveAndRead(page), "@I1@");
  expect(birth).toContain("Malo Lesce,Metlika,Slovenia");
  expect(birth).toContain("N45.647");
  expect(birth).not.toContain("N46.363");
});

test("moving an event to a place the file does not know drops the old position", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FIXTURE);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });

  const place = page.locator(".edit-person").first().locator(".edit-event-place").first();
  await place.fill("Nekje,Nekje,Slovenia");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Tab");

  const birth = birthOf(await saveAndRead(page), "@I1@");
  expect(birth).toContain("Nekje,Nekje,Slovenia");
  expect(birth).not.toContain("MAP");
  expect(birth).not.toContain("N46.363");
});

test("editing the address at the same place keeps the event's own position", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FIXTURE);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });

  const row = page.locator(".edit-person").first().locator(".edit-event").first();
  await row.locator(".edit-event-place").first().click();
  await row.locator(".edit-event-addfield").click();
  await page.locator('.dd-menu .dd-item[data-value="addr"]').click();
  await row.locator(".edit-event-addr").first().fill("Lesce 8");
  await page.keyboard.press("Tab");

  const birth = birthOf(await saveAndRead(page), "@I1@");
  expect(birth).toContain("Lesce 8");
  expect(birth).toContain("N46.363");
});
