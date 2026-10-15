import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// The Compare Tree keeps the people it was re-rooted on the way the Charts hub
// does: ‹ › and the ▾ list retrace them inside the tree's one history entry,
// and Back leaves the tree for Merge in one press however many re-roots
// came before.

const MAIN = path.join(tmpdir(), "compare-trail-main.ged");
const COMPARE = path.join(tmpdir(), "compare-trail-compare.ged");

const family = [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Janez /Kovač/", "1 SEX M", "1 BIRT", "2 DATE 1820", "1 FAMS @F1@", "1 FAMC @F2@",
  "0 @I2@ INDI", "1 NAME Marija /Novak/", "1 SEX F", "1 BIRT", "2 DATE 1824", "1 FAMS @F1@",
  "0 @I3@ INDI", "1 NAME Anton /Kovač/", "1 SEX M", "1 BIRT", "2 DATE 1850", "1 FAMC @F1@",
  "0 @F1@ FAM", "1 HUSB @I1@", "1 WIFE @I2@", "1 CHIL @I3@", "1 MARR", "2 DATE 1848",
  "0 @I4@ INDI", "1 NAME Jože /Kovač/", "1 SEX M", "1 BIRT", "2 DATE 1790", "1 FAMS @F2@",
  "0 @F2@ FAM", "1 HUSB @I4@", "1 CHIL @I1@",
  "0 TRLR", "",
].join("\n");

writeFileSync(MAIN, family, "utf-8");
writeFileSync(COMPARE, family, "utf-8");

test("the Compare Tree's trail retraces re-roots and Back leaves in one press", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(MAIN);
  await page.locator(".edit-person").first().waitFor();
  await page.getByRole("button", { name: "Merge", exact: true }).click();
  await page.locator("input.file-input").last().setInputFiles(COMPARE);
  await page.locator(".candidate").first().waitFor();
  await page.locator(".candidate-main", { hasText: "Anton" }).first().click();

  await page.keyboard.press("v");
  await page.locator("svg.tree-svg").waitFor();
  const title = page.locator(".tree-toolbar .tree-title-name");
  await expect(title).toHaveText(/Anton/);
  await expect(page.locator(".chart-trail")).toHaveCount(0);

  // Re-root up the line, father then grandfather, via the node panel's "Root".
  for (const name of ["Janez", "Jože"]) {
    await page.locator("svg.tree-svg").getByRole("button", { name: new RegExp(`^${name}`) }).first().click();
    await page.getByRole("button", { name: "Root", exact: true }).click();
    await expect(title).toHaveText(new RegExp(name));
  }

  // ‹ steps back a person, the list jumps to the newest.
  await page.getByRole("button", { name: /^Previous person/ }).click();
  await expect(title).toHaveText(/Janez/);
  await page.keyboard.press(",");
  await expect(title).toHaveText(/Anton/);
  await page.getByRole("button", { name: "People this chart was drawn for" }).click();
  await page.getByRole("option", { name: /^Jože/ }).click();
  await expect(title).toHaveText(/Jože/);

  // One Back leaves the tree for Merge.
  await page.goBack();
  await expect(page.locator("svg.tree-svg")).toHaveCount(0);
  await expect(page.locator(".candidate").first()).toBeVisible();
});
