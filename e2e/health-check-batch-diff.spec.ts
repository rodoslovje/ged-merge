import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// A fix run from the picked batch has to reach the save preview with its
// "before": the batch once marked its records dirty ahead of the push, the
// changed record was snapshotted as its own pre-edit state, and the GEDCOM
// lines view said "no line changes" on every record the fix had rewritten.
const FILE = path.join(tmpdir(), "health-check-batch-diff.ged");

writeFileSync(FILE, [
  "0 HEAD", "1 GEDC", "2 VERS 7.0",
  "0 @I1@ INDI", "1 NAME Janez /Kos/", "1 SEX M",
  "1 BIRT", "2 DATE 1880", "2 CHAN", "3 DATE 8 NOV 2026",
  "0 TRLR", "",
].join("\n"), "utf-8");

test("a batched fix shows its lines in the save preview", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor();

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Health check", { exact: true }).first().click();
  await page.getByRole("tab", { name: /GEDCOM .* compliance/ }).click();

  const stamps = page.locator(".tools-issue", { hasText: "CHAN is allowed only on the record itself" });
  await stamps.locator(".tools-pick").check();
  await page.getByRole("button", { name: "Fix selected (1)" }).click();
  await page.getByRole("button", { name: "Apply fix" }).click();

  const saveBtn = page.locator(".app-head-actions .export-btn");
  await expect(saveBtn).toBeEnabled();
  await saveBtn.click();
  await page.getByRole("tab", { name: "GEDCOM lines" }).click();

  const diff = page.locator(".preview-diff");
  await expect(diff.locator(".diff-line.is-del", { hasText: "2 CHAN" })).toBeVisible();
  await expect(diff.locator(".diff-line.is-add", { hasText: "1 CHAN" })).toBeVisible();
});
