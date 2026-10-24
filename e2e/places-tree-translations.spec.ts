import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// The places tree shows a place's other names (GEDCOM 7 TRAN) beside it, finds
// the place by them, and edits them under the rename box: the list written
// there lands on every event naming the place.
const FILE = path.join(tmpdir(), "places-tree-translations.ged");

writeFileSync(FILE, [
  "0 HEAD", "1 GEDC", "2 VERS 7.0.3", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Ana /Kos/",
  "1 BIRT", "2 PLAC Kranj, Slovenija", "3 TRAN Krainburg", "4 LANG de",
  "0 @I2@ INDI", "1 NAME Ivan /Kos/",
  "1 BIRT", "2 PLAC Kranj, Slovenija",
  "0 @I3@ INDI", "1 NAME Neža /Kos/",
  "1 BIRT", "2 PLAC Ljubljana, Slovenija",
  "0 TRLR", "",
].join("\n"), "utf-8");

test("a place's other names: shown, searched and written on every event", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor();
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Places", { exact: true }).click();

  const kranj = page.locator(".tools-tree-row").filter({ hasText: "Kranj" }).first();
  await expect(kranj.locator(".tools-tree-tran")).toHaveText("Krainburg");

  // The old name finds the place.
  await page.locator(".tools-search-input").first().fill("Krainburg");
  await expect(page.locator(".tools-tree-row").filter({ hasText: "Ljubljana" })).toHaveCount(0);
  await expect(kranj).toBeVisible();

  await kranj.hover();
  await kranj.locator(".tools-place-edit-btn").first().click();
  const editor = page.locator(".tools-place-tran");
  await expect(editor).toContainText("on 2 events");
  await expect(editor).toContainText("Not every event here carries the same other names");
  await expect(editor.locator(".tools-place-tran-input")).toHaveValue("Krainburg");

  await editor.getByRole("button", { name: "+ Add a name" }).click();
  await editor.locator(".tools-place-tran-input").nth(1).fill("Carnium");
  await editor.getByRole("button", { name: "Write names" }).click();

  await expect(kranj.locator(".tools-tree-tran")).toHaveText("Krainburg · Carnium");
  // Every event now carries the same list: reopening finds nothing to reconcile.
  await kranj.hover();
  await kranj.locator(".tools-place-edit-btn").first().click();
  await expect(editor).not.toContainText("Not every event here");
  await expect(editor.getByRole("button", { name: "Write names" })).toBeDisabled();

  expect(errors).toEqual([]);
});
