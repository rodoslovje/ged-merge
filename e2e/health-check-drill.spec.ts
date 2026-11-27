import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// A finding that counts several records names none of them. "Show records"
// opens it into a row per record, each leading to the record itself — the ones
// no fix settles have to be found to be settled by hand.
const FILE = path.join(tmpdir(), "health-check-drill.ged");

writeFileSync(FILE, [
  "0 HEAD", "1 GEDC", "2 VERS 7.0",
  "0 @I1@ INDI", "1 NAME Janez /Kos/", "1 SEX M",
  "1 BIRT", "2 DATE 1880", "2 SOUR @S1@",
  "0 @S1@ SOUR", "1 TITL Naše korenine", "1 PLAC Kranj",
  "0 @S2@ SOUR", "1 TITL Stražiše pa Strašan", "1 PLAC Kranj",
  "0 @S3@ SOUR", "1 TITL Leksikon priimkov",
  "0 TRLR", "",
].join("\n"), "utf-8");

test("a grouped finding opens into its records", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor();

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Health check", { exact: true }).first().click();
  await page.getByRole("tab", { name: /GEDCOM .* compliance/ }).click();

  const finding = page.locator(".tools-issue", { hasText: "PLAC is not allowed under SOUR" });
  await expect(finding).toContainText("(2×)");
  await finding.getByRole("button", { name: "Show records" }).click();

  const rows = page.locator(".tools-issue");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("Naše korenine");
  await expect(rows.nth(1)).toContainText("Stražiše pa Strašan");
  // Each row leads to its record, and carries no file-wide fix or checkbox.
  await expect(rows.nth(0).getByRole("button", { name: "Edit source" })).toBeVisible();
  await expect(page.locator(".tools-issue .tools-pick:not(.tools-pick--blank)")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Move into PUBL" })).toHaveCount(0);

  await page.getByRole("button", { name: "← All findings" }).click();
  await expect(finding).toContainText("(2×)");
});
