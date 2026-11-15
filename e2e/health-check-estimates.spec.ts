import { test, expect, type Page } from "@playwright/test";
import path from "path";

// The health-check video's demo file: a copy of the Prešeren tree with errors
// put in on purpose. Its undated rows offer the estimates Batch writes, and one
// "fix all" leaves only what needs a person's judgment in Edit.
const FILE = path.join(import.meta.dirname, "..", "videos", "demo", "preseren-hawlina-pregled.ged");

const chip = (page: Page, name: string) => page.locator(".tools-chip", { hasText: name });

test("the demo file's estimates match Batch, and one fix-all leaves the judgment calls", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor();
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Health check", { exact: true }).first().click();

  await chip(page, "No vital dates").click();
  await expect(page.locator(".tools-issue", { hasText: "Marija" })).toContainText("→ ABT 1670");
  await chip(page, "Undated marriage").click();
  await expect(page.locator(".tools-issue", { hasText: "Jernej Prešeren" })).toContainText("→ BEF 23 OCT 1762");

  await chip(page, "Fixable").click();
  await page.getByRole("button", { name: /^Select all fixable/ }).click();
  await page.getByRole("button", { name: /^Fix selected/ }).click();
  await page.getByRole("button", { name: "Apply fix" }).click();
  await expect(page.locator(".tools-clean--ok")).toContainText("Fixes made:");

  // Left for Edit: the mistyped death (and what it drags along) and the
  // disconnected daughter. New: Marija's estimated birth makes her over 99.
  for (const left of ["Death before birth", "Event outside lifespan", "Born after a parent's death", "Disconnected", "Living over 99"]) {
    await expect(chip(page, left)).toBeVisible();
  }
  for (const gone of ["Broken links", "Duplicate pointers", "Same couple twice", "Sex vs. role", "No sex", "No vital dates", "Undated marriage", "Unparseable dates", "Dangling references"]) {
    await expect(chip(page, gone)).toHaveCount(0);
  }
});
