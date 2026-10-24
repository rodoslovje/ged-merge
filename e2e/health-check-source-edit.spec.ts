import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

/** A source whose covered years run backwards — a finding the health check
 *  reports on the source itself. */
function writeFixture(): string {
  const ged = [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1",
    "0 @I1@ INDI", "1 NAME Ana /Novak/", "1 SEX F", "1 BIRT", "2 DATE 1760", "2 SOUR @S1@",
    "0 @S1@ SOUR", "1 TITL Krstna knjiga 03167", "1 DATA", "2 EVEN BIRT", "3 DATE FROM 1768 TO 1758",
    "0 TRLR", "",
  ].join("\n");
  const filePath = path.join(tmpdir(), `hc-source-${Date.now()}.ged`);
  writeFileSync(filePath, ged, "utf-8");
  return filePath;
}

// A finding on a source opens the source's editor from the row, so it can be
// settled where it is reported — the years it covers among the fields.
test("a source's finding opens its editor, and saving it settles the finding", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(writeFixture());
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Health check", { exact: true }).first().click();

  const row = page.locator(".tools-issue").filter({ hasText: "FROM 1768 TO 1758" });
  await expect(row).toHaveCount(1);
  // The row says where it is settled: its own button opens the source editor.
  await row.getByRole("button", { name: "Edit source" }).click();

  const dialog = page.getByRole("dialog");
  const years = dialog.locator("label.add-source-field").filter({ hasText: /^Date/ }).locator("input");
  await expect(years).toHaveValue("FROM 1768 TO 1758");
  await years.fill("FROM 1758 TO 1768");
  await years.press("Tab");
  await dialog.getByRole("button", { name: "Save" }).click();

  await expect(page.locator(".tools-issue").filter({ hasText: "FROM 1768 TO 1758" })).toHaveCount(0);
});
