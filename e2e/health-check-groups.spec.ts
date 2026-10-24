import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

/** A 7.0 file with one data issue (a person with no sex) and one GEDCOM
 *  issue (text on an event line, which 7.0 allows only as Y). */
function writeFixture(): string {
  const ged = [
    "0 HEAD", "1 GEDC", "2 VERS 7.0",
    "0 @I1@ INDI", "1 NAME Ana /Novak/", "1 BIRT Kranj", "2 DATE 1900",
    "0 TRLR", "",
  ].join("\n");
  const filePath = path.join(tmpdir(), `health-groups-${Date.now()}.ged`);
  writeFileSync(filePath, ged, "utf-8");
  return filePath;
}

// The health check keeps the family data apart from the file's format, so a
// file full of format findings doesn't bury the few real data problems.
test("the health check lists data issues and GEDCOM issues on their own tabs", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(writeFixture());
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Health check", { exact: true }).first().click();

  const data = page.getByRole("tab", { name: /Data issues/ });
  const gedcom = page.getByRole("tab", { name: /GEDCOM .* issues/ });
  await expect(data).toHaveAttribute("aria-selected", "true");
  const list = page.locator(".tools-issues");
  await expect(list).toContainText("Sex not recorded");
  await expect(list).not.toContainText("may hold only Y");
  await expect(page.getByRole("button", { name: /Move event text into notes/ })).toHaveCount(0);

  await gedcom.click();
  await expect(gedcom).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".tools-group-intro")).toContainText("departs from GEDCOM 7.0");
  await expect(list).toContainText("may hold only Y");
  await expect(list).not.toContainText("Sex not recorded");
  await expect(page.getByRole("button", { name: /Move event text into notes/ })).toBeVisible();
  // Text on event lines is a chip of its own, carved out of the values.
  await page.locator(".tools-chip", { hasText: "Text on event lines" }).click();
  await expect(list).toContainText("may hold only Y");

  // A page of its own: Back returns to the data issues.
  await page.goBack();
  await expect(data).toHaveAttribute("aria-selected", "true");
});
