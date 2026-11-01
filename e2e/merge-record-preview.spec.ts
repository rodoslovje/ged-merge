import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

const MAIN = path.join(tmpdir(), "merge-record-preview-main.ged");
const COMPARE = path.join(tmpdir(), "merge-record-preview-compare.ged");

writeFileSync(MAIN, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Marija /Zaletel/", "1 SEX F",
  "1 BIRT", "2 DATE 4 NOV 1738", "2 PLAC Kranj",
  "0 TRLR", "",
].join("\n"), "utf-8");

// The same person, with a note, a nickname and a FamilySearch id the main lacks.
writeFileSync(COMPARE, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Marija /Zaletel/", "2 NICK Mica", "1 SEX F",
  "1 BIRT", "2 DATE 4 NOV 1738", "2 PLAC Kranj",
  "1 NOTE Zapis v krstni knjigi: Marina",
  "1 _FID GPZG-CXL",
  "0 TRLR", "",
].join("\n"), "utf-8");

/** Load both files, confirm the one candidate, and open the person in Edit. */
async function confirmAndOpenInEdit(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(MAIN);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Merge", exact: true }).click();
  await page.locator("input.file-input").last().setInputFiles(COMPARE);
  await page.locator(".candidate").first().waitFor({ timeout: 30000 });

  await page.locator(".candidate").first().click();
  const bar = page.locator(".compare-name-decisions");
  await bar.getByRole("button", { name: "Confirm" }).click();
  await expect(bar.locator(".decision.confirmed.active")).toBeVisible();

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator(".edit-name-input").first()).toHaveValue("Marija");
}

test("a confirmed match's person note, nickname and id show in Edit before the save", async ({ page }) => {
  await confirmAndOpenInEdit(page);

  const note = page.locator(".edit-notes .edit-name-chip--merge");
  await expect(note).toContainText("Zapis v krstni knjigi: Marina");
  // The note is already there, so "+ Add note" is not offered beside it.
  await expect(page.locator(".edit-other-names-actions").getByRole("button", { name: "+ Add note" })).toHaveCount(0);
  await expect(page.locator(".edit-other-names .edit-name-chip--merge", { hasText: "Mica" })).toBeVisible();
  await expect(page.locator(".edit-name-chip--merge", { hasText: "GPZG-CXL" })).toBeVisible();

  // Taking the note over makes it the record's own, editable note.
  await note.click();
  await expect(page.locator(".edit-notes .edit-name-chip--merge")).toHaveCount(0);
  await expect(page.locator(".edit-notes .edit-event-note")).toContainText("Zapis v krstni knjigi: Marina");
});

test("× on a previewed incoming id leaves it out", async ({ page }) => {
  await confirmAndOpenInEdit(page);

  const wrap = page.locator(".edit-name-chip-wrap", { has: page.locator(".edit-name-chip--merge", { hasText: "GPZG-CXL" }) });
  await wrap.hover();
  await wrap.locator(".edit-link-remove").click();

  await expect(page.locator(".edit-name-chip", { hasText: "GPZG-CXL" })).toHaveCount(0);
  await expect(page.locator(".edit-notes .edit-name-chip--merge")).toHaveCount(1);
});

const LINK_MAIN = path.join(tmpdir(), "merge-record-preview-link-main.ged");
const LINK_COMPARE = path.join(tmpdir(), "merge-record-preview-link-compare.ged");

// Main holds the husband and the wife, unmarried; the incoming file marries them.
writeFileSync(LINK_MAIN, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Janez /Novak/", "1 SEX M", "1 BIRT", "2 DATE 12 MAR 1850", "2 PLAC Kranj",
  "0 @I2@ INDI", "1 NAME Ana /Kos/", "1 SEX F", "1 BIRT", "2 DATE 3 JUN 1855", "2 PLAC Kranj",
  "0 TRLR", "",
].join("\n"), "utf-8");
writeFileSync(LINK_COMPARE, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @P1@ INDI", "1 NAME Janez /Novak/", "1 SEX M", "1 BIRT", "2 DATE 12 MAR 1850", "2 PLAC Kranj", "1 FAMS @G1@",
  "0 @P2@ INDI", "1 NAME Ana /Kos/", "1 SEX F", "1 BIRT", "2 DATE 3 JUN 1855", "2 PLAC Kranj", "1 FAMS @G1@",
  "0 @G1@ FAM", "1 HUSB @P1@", "1 WIFE @P2@", "1 MARR", "2 DATE 1875",
  "0 TRLR", "",
].join("\n"), "utf-8");

test("a partner the save links to an existing person shows in Edit, flagged when unconfirmed", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(LINK_MAIN);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Merge", exact: true }).click();
  await page.locator("input.file-input").last().setInputFiles(LINK_COMPARE);
  const janez = page.locator(".candidate", { hasText: "Janez" }).first();
  await janez.waitFor({ timeout: 30000 });

  // Confirm only Janez: Ana's pairing stays the matcher's proposal.
  await janez.click();
  const bar = page.locator(".compare-name-decisions");
  await bar.getByRole("button", { name: "Confirm" }).click();
  await expect(bar.locator(".decision.confirmed.active")).toBeVisible();

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator(".edit-name-input").first()).toHaveValue("Janez");
  const pending = page.locator(".edit-family--pending .person-card-wrap--pending");
  await expect(pending).toContainText("Ana Kos");
  await expect(pending.locator(".gm-join-mark")).toBeVisible();
});
