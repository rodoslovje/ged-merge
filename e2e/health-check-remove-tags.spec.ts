import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// On the custom-tags list the removals can be picked together: a file with
// thirty extension tags to clear out is otherwise thirty buttons and thirty
// confirmations. Elsewhere a removal stays the row's own button.
const FILE = path.join(tmpdir(), "health-check-remove-tags.ged");

writeFileSync(FILE, [
  "0 HEAD", "1 GEDC", "2 VERS 7.0",
  "0 @I1@ INDI", "1 NAME Janez /Kos/", "1 SEX M",
  "1 _FOO one", "1 _BAR two", "1 _BAZ three",
  "1 BIRT", "2 DATE 1880",
  "0 TRLR", "",
].join("\n"), "utf-8");

test("extension tags are removed together from the custom-tags list", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor();

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Health check", { exact: true }).first().click();
  await page.getByRole("tab", { name: /GEDCOM .* compliance/ }).click();

  // Not offered for picking on the whole list: a removal is no repair.
  await expect(page.locator(".tools-issue", { hasText: "_FOO" })).toBeVisible();
  await expect(page.locator(".tools-issue .tools-pick:not(.tools-pick--blank)")).toHaveCount(0);

  await page.locator(".tools-chip", { hasText: "Custom tags" }).click();
  await expect(page.locator(".tools-issue .tools-pick:not(.tools-pick--blank)")).toHaveCount(3);
  await page.locator(".tools-issue", { hasText: "_FOO" }).locator(".tools-pick").check();
  await page.locator(".tools-issue", { hasText: "_BAZ" }).locator(".tools-pick").check();
  await page.getByRole("button", { name: "Fix selected (2)" }).click();
  // The confirmation names what goes.
  await expect(page.locator(".confirm-dialog")).toContainText("_FOO, _BAZ");
  await page.getByRole("button", { name: "Apply fix" }).click();

  await page.locator(".tools-chip", { hasText: "Custom tags" }).click();
  await expect(page.locator(".tools-issue", { hasText: "_BAR" })).toBeVisible();
  await expect(page.locator(".tools-issue", { hasText: "_FOO" })).toHaveCount(0);
  await expect(page.locator(".tools-issue", { hasText: "_BAZ" })).toHaveCount(0);
});
