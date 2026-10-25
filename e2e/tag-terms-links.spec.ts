import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// A program's own tag shown anywhere — here MacFamilyTree's bare NOBI at an
// event row's right edge and in the merge comparison — leads to the page that
// explains it.
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

  // The tag stands apart from the label, which picks the event's type, at the
  // row's right edge, and links the page that explains it.
  const tagLink = page.locator(".edit-event a.edit-event-tag", { hasText: "NOBI" });
  await expect(tagLink).toHaveAttribute("href", "/terms/macfamilytree/NOBI");
  const row = page.locator(".edit-event", { has: page.locator("a.edit-event-tag") });
  await expect(row.locator(".edit-event-label")).toHaveCount(1);
  await expect(row.locator(".edit-event-label")).not.toContainText("(NOBI)");
  const rowBox = (await row.boundingBox())!;
  const tagBox = (await tagLink.boundingBox())!;
  expect(rowBox.x + rowBox.width - (tagBox.x + tagBox.width)).toBeLessThan(4);
  const popup = page.waitForEvent("popup");
  await tagLink.click();
  expect((await popup).url()).toContain("/terms/macfamilytree/NOBI");

  await page.getByRole("button", { name: "Merge", exact: true }).click();
  await page.locator("input.file-input").last().setInputFiles(COMPARE);
  await page.locator(".candidate-main", { hasText: "Janez" }).first().click();
  const link = page.locator("a.tag-terms-link", { hasText: "NOBI" }).first();
  await expect(link).toHaveAttribute("href", "/terms/macfamilytree/NOBI");
});
