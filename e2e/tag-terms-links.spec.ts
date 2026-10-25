import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// A program's own tag shown anywhere — here MacFamilyTree's bare NOBI on an
// event row and in the merge comparison — leads to the page that explains it.
const MAIN = path.join(tmpdir(), "tag-terms-main.ged");
const COMPARE = path.join(tmpdir(), "tag-terms-compare.ged");
const person = (award: string) => [
  "0 HEAD", "1 SOUR TEST", "1 GEDC", "2 VERS 5.5.1", "2 FORM LINEAGE-LINKED", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Janez /Kos/", "1 SEX M", "1 BIRT", "2 DATE 1880", "2 PLAC Kranj",
  "1 NOBI", "2 TYPE " + award, "2 DATE 1920",
  "0 TRLR", "",
].join("\n");
writeFileSync(MAIN, person("Medal"), "utf-8");
writeFileSync(COMPARE, person("Order"), "utf-8");

test("a non-standard event tag links its page from the event menu and the comparison", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(MAIN);
  await page.locator(".edit-person").waitFor();

  const row = page.locator(".edit-event", { hasText: "(NOBI)" });
  await row.locator(".edit-event-label--select").click();
  const item = page.locator(".dd-menu .dd-item", { hasText: "What NOBI means" });
  await expect(item).toHaveCount(1);
  const popup = page.waitForEvent("popup");
  await item.click();
  expect((await popup).url()).toContain("/terms/macfamilytree/NOBI");

  await page.getByRole("button", { name: "Merge", exact: true }).click();
  await page.locator("input.file-input").last().setInputFiles(COMPARE);
  await page.locator(".candidate-main", { hasText: "Janez" }).first().click();
  const link = page.locator("a.tag-terms-link", { hasText: "NOBI" }).first();
  await expect(link).toHaveAttribute("href", "/terms/macfamilytree/NOBI");
});
