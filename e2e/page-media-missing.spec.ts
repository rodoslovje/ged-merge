import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// Organize sources could not see a citation that is *missing* its page image:
// the scan hunts for links to convert, and a finished citation carries none.
// This is the section that asks the other question.
const uid = `${process.pid}`;
const FILE = path.join(tmpdir(), `page-media-missing-${uid}.ged`);
const BOOK = "https://data.matricula-online.eu/sl/slovenia/maribor/sentjur-pri-celju/03869";

writeFileSync(
  FILE,
  [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    // Ana states the file's habit: her citation carries its page image.
    "0 @I1@ INDI", "1 NAME Ana /Kern/", "1 SEX F",
    "1 BIRT", "2 DATE 3 MAR 1880", "2 SOUR @S1@", "3 PAGE 11", "2 OBJE @M1@",
    // Cilka states it too, so the habit is the file's and not one record's.
    "0 @I3@ INDI", "1 NAME Cilka /Kern/", "1 SEX F",
    "1 BIRT", "2 DATE 5 MAY 1882", "2 SOUR @S1@", "3 PAGE 13", "2 OBJE @M3@",
    // Blaž cites the same book at another page — image under the source only.
    "0 @I2@ INDI", "1 NAME Blaž /Kern/", "1 SEX M",
    "1 BIRT", "2 DATE 7 JUL 1885", "2 SOUR @S1@", "3 PAGE 12",
    "0 @S1@ SOUR", "1 TITL Krstna knjiga - 03869", "1 OBJE @M1@", "1 OBJE @M2@", "1 OBJE @M3@",
    "0 @M1@ OBJE", `1 FILE ${BOOK}/?pg=11`, "2 FORM htm",
    "0 @M2@ OBJE", `1 FILE ${BOOK}/?pg=12`, "2 FORM htm",
    "0 @M3@ OBJE", `1 FILE ${BOOK}/?pg=13`, "2 FORM htm",
    "0 TRLR", "",
  ].join("\n"),
  "utf-8",
);

test("a citation missing its page image is listed, and the apply links it", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Sources", { exact: true }).click();
  await page.getByRole("button", { name: /Organize sources/ }).click();

  // The lists are tabs now; the pages one names itself and carries its count.
  await page.getByRole("tab", { name: /Pages/ }).click();
  const section = page.locator(".tools-cleanup-section", { hasText: "Cited pages without their image" });
  await expect(section).toBeVisible();
  const row = section.locator(".tools-tree-node", { hasText: "Krstna knjiga - 03869" }).first();
  await expect(row).toBeVisible();
  await expect(row.locator(".tools-chip-count").first()).toHaveText("1");

  // Opening it names the person and where the citation sits.
  await row.locator(".tools-tree-label").click();
  await expect(row.locator(".tools-dup-member")).toHaveCount(1);
  await expect(row.locator(".tools-dup-member").first()).toContainText("Blaž");
  await expect(row.locator(".tools-dup-member").first()).toContainText("BIRT");

  // Tick and apply: the run button stands with the tabs, and names this list's
  // own work while only its rows are ticked.
  await row.locator("input.tools-dup-check").check();
  const apply = page.getByRole("button", { name: /Link page images/ });
  await expect(apply).toBeEnabled();
  await apply.click();

  // The run reports what it changed, and the finding is gone from the page.
  await expect(page.locator(".tools-cleanup-status")).toContainText(/record/);
  await expect(page.locator(".tools-cleanup-section", { hasText: "Cited pages without their image" })).toHaveCount(0);

  // And the page image now sits beside Blaž's citation in Edit — reached by
  // search, since the section that linked to him is gone with the finding.
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.keyboard.press("/");
  const modal = page.locator(".global-search-modal");
  await modal.locator(".global-search-input").fill("blaz kern");
  await modal.locator(".global-search-row").first().locator(".global-search-open").click();
  await expect(page.locator(".edit-name-input").first()).toHaveValue(/Blaž/);
  const birth = page.locator(".edit-event", { hasText: /Birth/ }).first();
  await expect(birth.locator(".edit-event-extra--sources .source-ref")).toHaveCount(1);
  // The 🔗 chip is the page image the run linked beside that citation.
  await expect(birth.locator(".edit-event-extra--sources button.edit-link-icon")).toHaveCount(1);
});
