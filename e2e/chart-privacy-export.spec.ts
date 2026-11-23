import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";

// With "living people private" on, an exported chart names a living person
// nowhere: not in a box, nor in the header, an accessible label or the file's
// own name. The dead stay whole.
const GED = [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Petra /Zorman/", "1 SEX F", "1 BIRT", "2 DATE 12 MAR 1990", "1 FAMC @F1@",
  "0 @I2@ INDI", "1 NAME Franc /Zorman/", "1 SEX M", "1 BIRT", "2 DATE 3 JAN 1890", "1 DEAT", "2 DATE 7 JUL 1960", "1 FAMS @F1@",
  "0 @I3@ INDI", "1 NAME Ivana /Bergant/", "1 SEX F", "1 BIRT", "2 DATE 1895", "1 DEAT", "2 DATE 1970", "1 FAMS @F1@",
  "0 @F1@ FAM", "1 HUSB @I2@", "1 WIFE @I3@", "1 CHIL @I1@",
  "0 TRLR", "",
].join("\n");

test("an exported chart does not name the living when they are private", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("gedmerge.chartSettings", JSON.stringify({ privacyLiving: true })));
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles({ name: "zorman.ged", mimeType: "text/plain", buffer: Buffer.from(GED) });
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();
  await page.locator(".charts-open-btn").click();
  await page.locator("svg.tree-svg").waitFor();
  // The chart is Petra's: her box is drawn without her name, her father's with his.
  await expect(page.locator("svg.tree-svg")).toContainText("Franc");
  await expect(page.locator("svg.tree-svg")).not.toContainText("Petra");

  await page.locator(".export-menu .tree-export-btn").click();
  const pending = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "SVG image" }).click();
  const download = await pending;
  const svg = readFileSync((await download.path())!, "utf-8");
  expect(svg).toContain("Franc");
  expect(svg).not.toContain("Petra");
  expect(svg).not.toContain("1990");
  expect(download.suggestedFilename()).not.toMatch(/petra/i);
});
