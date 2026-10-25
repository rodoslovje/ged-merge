import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// Tools → Health check, standard conformance: a citation pointing at a
// repository instead of a source and a pedigree value in the wrong case are
// both listed; the value fix rewrites the pedigree, the pointer stays reported.
const FILE = path.join(tmpdir(), "health-check-conformance.ged");

writeFileSync(FILE, [
  "0 HEAD", "1 SOUR TEST", "1 GEDC", "2 VERS 5.5.1", "2 FORM LINEAGE-LINKED", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Janez /Kos/", "1 SEX M",
  "1 BIRT", "2 DATE 1880", "2 SOUR @R1@",
  "1 FAMC @F1@", "2 PEDI Adopted",
  "0 @I2@ INDI", "1 NAME Anton /Kos/", "1 SEX M", "1 FAMS @F1@",
  "0 @F1@ FAM", "1 HUSB @I2@", "1 CHIL @I1@",
  "0 @R1@ REPO", "1 NAME Nadškofijski arhiv",
  "0 TRLR", "",
].join("\n"), "utf-8");

const chip = (page: Page, name: string) => page.locator(".tools-chip", { hasText: name });

test("conformance findings: a wrong-type pointer and a mis-cased value, and the value fix", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor();

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Health check", { exact: true }).first().click();
  await page.getByRole("tab", { name: /GEDCOM .* compliance/ }).click();
  await expect(page.locator(".tools-issues").first()).toBeVisible();

  await expect(chip(page, "Pointers to the wrong record")).toBeVisible();
  await expect(chip(page, "Non-standard values")).toBeVisible();
  await expect(page.locator(".tools-issue.sev-error", { hasText: "SOUR points at @R1@, a REPO record" })).toBeVisible();
  const pedi = page.locator(".tools-issue", { hasText: "PEDI Adopted is written adopted" });
  await expect(pedi).toBeVisible();
  await expect(pedi.locator(".tools-issue-fix")).toHaveText("→ adopted");

  // Picked and run as a batch: the confirmation names the fix it makes.
  await chip(page, "Non-standard values").click();
  await pedi.locator(".tools-pick").check();
  await page.getByRole("button", { name: "Fix selected (1)" }).click();
  await expect(page.locator(".confirm-dialog")).toContainText("Fix value spelling (1)");
  await page.getByRole("button", { name: "Apply fix" }).click();
  await expect(page.locator(".tools-clean--ok")).toContainText("Fixed values in 1 record");
  await expect(chip(page, "Non-standard values")).toHaveCount(0);
  // The pointer has no safe repair and stays reported.
  await expect(chip(page, "Pointers to the wrong record")).toBeVisible();

  expect(errors).toEqual([]);
});
