import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// A name's types are a chip of their own: a married-names file has thousands
// of them, and under "Values" they buried everything else.
const FILE = path.join(tmpdir(), "health-check-name-types.ged");

writeFileSync(FILE, [
  "0 HEAD", "1 GEDC", "2 VERS 7.0",
  "0 @I1@ INDI", "1 NAME Ana /Kos/", "1 NAME Ana /Novak/", "2 TYPE married", "1 SEX F",
  "1 BIRT", "2 DATE 1880", "2 SOUR @S1@", "3 QUAY 4",
  "0 @S1@ SOUR", "1 TITL Krstna knjiga",
  "0 TRLR", "",
].join("\n"), "utf-8");

const chip = (page: Page, name: string) => page.locator(".tools-chip", { hasText: name });

test("name types stand apart from the other non-standard values", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor();

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Health check", { exact: true }).first().click();
  await page.getByRole("tab", { name: /GEDCOM .* compliance/ }).click();

  await expect(chip(page, "Name types").locator(".tools-chip-count")).toHaveText("1");
  await expect(chip(page, "Values").locator(".tools-chip-count")).toHaveText("1");

  await chip(page, "Values").click();
  await expect(page.locator(".tools-issue")).toHaveCount(1);
  await expect(page.locator(".tools-issue")).toContainText("QUAY");

  await chip(page, "Name types").click();
  await expect(page.locator(".tools-issue")).toHaveCount(1);
  await expect(page.locator(".tools-issue")).toContainText("MARRIED");
});
