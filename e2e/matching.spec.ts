import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// End-to-end validation of the matching pipeline through the real app
// (worker + UI): placeholder records must not produce candidates, a
// day-exact genuine match must, and the Tools duplicate finder must veto
// same-named cousins while still flagging a true duplicate.

const MAIN = path.join(tmpdir(), "match-main.ged");
const COMPARE = path.join(tmpdir(), "match-compare.ged");
const COUSINS = path.join(tmpdir(), "match-cousins.ged");
const TRUEDUP = path.join(tmpdir(), "match-truedup.ged");

const HEAD = ["0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8"];

// Main and compare each hold one real person (day-exact birth agreement →
// a perfect identity key) and one privacy-scrubbed "Living" record. Only the
// real pair may match: "Living" ~ "Living" is a placeholder, not a name.
writeFileSync(MAIN, [
  ...HEAD,
  "0 @I1@ INDI", "1 NAME Janez /Novak/", "1 SEX M",
  "1 BIRT", "2 DATE 12 JAN 1900", "2 PLAC Kranj",
  "0 @I2@ INDI", "1 NAME Living", "1 SEX F",
  "1 BIRT", "2 DATE 1950",
  "0 TRLR", "",
].join("\n"), "utf-8");

writeFileSync(COMPARE, [
  ...HEAD,
  "0 @P1@ INDI", "1 NAME Janez /Novak/", "1 SEX M",
  "1 BIRT", "2 DATE 12 JAN 1900", "2 PLAC Kranj",
  "0 @P2@ INDI", "1 NAME Living", "1 SEX F",
  "1 BIRT", "2 DATE 1950",
  "0 TRLR", "",
].join("\n"), "utf-8");

// Same-named cousins: same name and birth year (different months), fathers
// Anton vs Jakob, and the ubiquitous mother given name (Marija) on both
// sides. The father conflict must veto the pair in the duplicate finder.
writeFileSync(COUSINS, [
  ...HEAD,
  "0 @I1@ INDI", "1 NAME Marija /Sattler/", "1 SEX F",
  "1 BIRT", "2 DATE 16 JUN 1903", "1 FAMC @F1@",
  "0 @I2@ INDI", "1 NAME Marija /Sattler/", "1 SEX F",
  "1 BIRT", "2 DATE 25 SEP 1903", "1 FAMC @F2@",
  "0 @I3@ INDI", "1 NAME Anton /Sattler/", "1 SEX M",
  "0 @I4@ INDI", "1 NAME Marija /Horvat/", "1 SEX F",
  "0 @I5@ INDI", "1 NAME Jakob /Sattler/", "1 SEX M",
  "0 @I6@ INDI", "1 NAME Marija /Zupan/", "1 SEX F",
  "0 @F1@ FAM", "1 HUSB @I3@", "1 WIFE @I4@", "1 CHIL @I1@",
  "0 @F2@ FAM", "1 HUSB @I5@", "1 WIFE @I6@", "1 CHIL @I2@",
  "0 TRLR", "",
].join("\n"), "utf-8");

// A genuine duplicate: identical name, day-exact birth, same parents.
writeFileSync(TRUEDUP, [
  ...HEAD,
  "0 @I1@ INDI", "1 NAME Janez /Novak/", "1 SEX M",
  "1 BIRT", "2 DATE 12 JAN 1850", "1 FAMC @F1@",
  "0 @I2@ INDI", "1 NAME Janez /Novak/", "1 SEX M",
  "1 BIRT", "2 DATE 12 JAN 1850", "1 FAMC @F1@",
  "0 @I3@ INDI", "1 NAME Anton /Novak/", "1 SEX M",
  "0 @I4@ INDI", "1 NAME Marija /Kovac/", "1 SEX F",
  "0 @F1@ FAM", "1 HUSB @I3@", "1 WIFE @I4@", "1 CHIL @I1@", "1 CHIL @I2@",
  "0 TRLR", "",
].join("\n"), "utf-8");

test("merge candidates: day-exact pair matches, Living placeholders do not", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(MAIN);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });

  await page.getByRole("button", { name: "Merge", exact: true }).click();
  await page.locator("input.file-input").last().setInputFiles(COMPARE);
  await page.locator(".candidate").first().waitFor({ timeout: 30000 });

  // Exactly one candidate: the genuine Janez Novak pair. The Living↔Living
  // pair must not appear — placeholder names carry no identity.
  await expect(page.locator(".candidate")).toHaveCount(1);
  await expect(page.locator(".candidate").first()).toContainText("Janez Novak");
});

test("a merge decision undoes and redoes as one step", async ({ page }) => {
  // The unified undo stack's merge entries restore whole decision maps by
  // value — previously the only uncovered entry kind. Confirm → undo → redo
  // must land back on exactly the same decision.
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

  await page.keyboard.press("ControlOrMeta+z");
  await expect(bar.locator(".decision.confirmed.active")).toHaveCount(0);

  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(bar.locator(".decision.confirmed.active")).toBeVisible();
});

test("duplicate finder: same-named cousins with conflicting fathers are not flagged", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(COUSINS);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Find duplicates").click();
  await expect(page.getByText("No likely duplicates found.")).toBeVisible({ timeout: 30000 });
});

test("duplicate finder: a true duplicate (same parents, day-exact birth) is flagged", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(TRUEDUP);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Find duplicates").click();
  await expect(page.getByText(/possible duplicate pair/)).toBeVisible({ timeout: 30000 });
  await expect(page.getByText("No likely duplicates found.")).not.toBeVisible();
});
