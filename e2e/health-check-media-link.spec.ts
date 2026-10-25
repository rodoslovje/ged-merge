import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// Tools → Health check, a media file whose name says no form: a label typed in
// front of the address. Its row opens the link editor; the corrected address
// joins the others whose form the fix can add.
const FILE = path.join(tmpdir(), "health-check-media-link.ged");

writeFileSync(FILE, [
  "0 HEAD", "1 SOUR TEST", "1 GEDC", "2 VERS 7.0", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Janez /Kos/", "1 SEX M", "1 OBJE @O1@", "1 OBJE @O2@",
  "0 @O1@ OBJE", "1 FILE #018 - https://data.matricula-online.eu/sl/slovenia/ljubljana/sencur/03164/?pg=18",
  "2 TITL Krstna knjiga 03164",
  "0 @O2@ OBJE", "1 FILE https://en.geneanet.org/cemetery/view/13234512",
  "0 TRLR", "",
].join("\n"), "utf-8");

test("a media link with a label in front opens the link editor, and the corrected one joins the form fix", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor();

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Health check", { exact: true }).first().click();
  await page.getByRole("tab", { name: /GEDCOM .* compliance/ }).click();

  const missing = page.locator(".tools-issue", { hasText: "no FORM line" });
  await expect(missing).toHaveCount(2);
  await missing.getByRole("button", { name: "Edit Link" }).click();

  const field = page.locator(".media-link-dialog input");
  await expect(field).toHaveValue(/^#018 - https:/);
  await field.fill("https://data.matricula-online.eu/sl/slovenia/ljubljana/sencur/03164/?pg=18");
  await page.locator(".media-link-dialog").getByRole("button", { name: "Save" }).click();

  // Both addresses now read as web pages: one row, one form to add.
  const grouped = page.locator(".tools-issue", { hasText: "missing the FORM line" });
  await expect(grouped).toContainText("(2×)");
  await expect(grouped.getByRole("button", { name: "+ FORM text/html" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit Link" })).toHaveCount(0);

  expect(errors).toEqual([]);
});
