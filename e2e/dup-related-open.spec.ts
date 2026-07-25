import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import os from "os";
import path from "path";

// The "these relatives are a separate record on each side" hint inside an open
// duplicate comparison links to that relative's own pair. Regression guard: the
// linked pair must open AND land in view. It used to clear the search box and
// reset the score floor unconditionally, which flooded the list and left the
// opened comparison far below the fold — the click looked like a no-op.

const FILE = path.join(os.tmpdir(), "dup-related-open.ged");

const lines: string[] = ["0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8"];

// Filler duplicate pairs (day-exact births and shared parents, so they clear
// the default >=85 floor) — enough of them that the list is long and the target
// pair is nowhere near the viewport once a filter is lifted.
for (let i = 0; i < 120; i++) {
  lines.push(`0 @FA${i}@ INDI`, `1 NAME Ata${i} /Priimek${i}/`, "1 SEX M");
  lines.push(`0 @MO${i}@ INDI`, `1 NAME Mama${i} /Priimek${i}/`, "1 SEX F");
  for (let c = 0; c < 2; c++) {
    lines.push(
      `0 @P${i}_${c}@ INDI`,
      `1 NAME Filler${i} /Priimek${i}/`,
      "1 SEX M",
      "1 BIRT",
      `2 DATE 12 JAN ${1700 + i}`,
      "2 PLAC Kranj, Gorenjska, Slovenija",
      `1 FAMC @F${i}@`,
    );
  }
  lines.push(`0 @F${i}@ FAM`, `1 HUSB @FA${i}@`, `1 WIFE @MO${i}@`, `1 CHIL @P${i}_0@`, `1 CHIL @P${i}_1@`);
}

// A duplicated couple: each husband record is married to his own copy of the
// wife, which is what the related-records hint surfaces. Both share the token
// "Stopar", so one search term isolates the two pairs.
for (const n of [1, 2]) {
  lines.push(
    `0 @FR${n}@ INDI`,
    "1 NAME Franc /Stopar/",
    "1 SEX M",
    "1 BIRT",
    "2 DATE 22 NOV 1862",
    "2 PLAC Kranj, Gorenjska, Slovenija",
    `1 FAMS @FT${n}@`,
  );
  lines.push(
    `0 @NZ${n}@ INDI`,
    "1 NAME Neža /Stopar Gutovnik/",
    "1 SEX F",
    "1 BIRT",
    "2 DATE 3 JAN 1866",
    "2 PLAC Kranj, Gorenjska, Slovenija",
    `1 FAMS @FT${n}@`,
  );
  lines.push(`0 @FT${n}@ FAM`, `1 HUSB @FR${n}@`, `1 WIFE @NZ${n}@`);
}
lines.push("0 TRLR", "");
writeFileSync(FILE, lines.join("\n"), "utf-8");

test("a related-records link opens that pair and scrolls to it", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 700 });
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor({ timeout: 60000 });

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Find duplicates").click();
  await expect(page.locator(".tools-pairs")).toBeVisible({ timeout: 120000 });

  // Narrow the list to the couple, the way a user hunting one family would.
  await page.locator(".tools-search-input").fill("Stopar");
  await expect(page.locator("li.tools-pair")).toHaveCount(2);

  // Open the husband's pair, then follow the hint to the wife's pair.
  const husband = page.locator("li.tools-pair", { hasText: "Franc" }).first();
  await husband.locator(".tools-pair-toggle").click();
  const hint = page.locator(".tools-related-hint");
  await expect(hint).toBeVisible();
  await hint.getByRole("button", { name: /Neža/ }).click();

  // The wife's comparison is the open one now …
  const open = page.locator("li.tools-pair", { has: page.locator(".tools-pair-compare") });
  await expect(open).toHaveCount(1);
  await expect(open).toContainText("Neža");
  // … the search that still matches it is untouched (no flood back to the
  // full list) …
  await expect(page.locator(".tools-search-input")).toHaveValue("Stopar");

  // … and it is pinned into view, not left below the fold.
  await page.waitForTimeout(400);
  const box = await open.locator(".tools-pair-row").first().boundingBox();
  const view = await page.locator(".tools-view").boundingBox();
  expect(box).not.toBeNull();
  expect(view).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(view!.y - 2);
  expect(box!.y).toBeLessThan(view!.y + view!.height);
});
