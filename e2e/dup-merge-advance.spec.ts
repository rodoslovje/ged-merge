import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// After a duplicate merge the panel opens the next pair. Regression guard: that
// pair's row must land at the top of the list. It used to stay where the long
// comparison above it had ended, so the next comparison opened mid-screen and
// it was unclear what had just happened.

const FILE = path.join(tmpdir(), "dup-merge-advance.ged");

const lines: string[] = ["0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8"];

// Duplicate pairs with day-exact births and shared parents. The first one's
// records carry many residences, so its comparison runs far below the fold.
for (let i = 0; i < 12; i++) {
  lines.push(`0 @FA${i}@ INDI`, `1 NAME Ata${i} /Priimek${i}/`, "1 SEX M");
  lines.push(`0 @MO${i}@ INDI`, `1 NAME Mama${i} /Priimek${i}/`, "1 SEX F");
  for (let c = 0; c < 2; c++) {
    lines.push(
      `0 @P${i}_${c}@ INDI`,
      `1 NAME ${i === 0 ? "Dolgi" : `Filler${i}`} /Priimek${i}/`,
      "1 SEX M",
      "1 BIRT",
      `2 DATE 12 JAN ${1700 + i}`,
      "2 PLAC Kranj, Gorenjska, Slovenija",
    );
    if (i === 0) {
      for (let r = 0; r < 30; r++) lines.push("1 RESI", `2 DATE ${1720 + r + c * 40}`, `2 PLAC Kraj${r}_${c}, Gorenjska, Slovenija`);
    }
    lines.push(`1 FAMC @F${i}@`);
  }
  lines.push(`0 @F${i}@ FAM`, `1 HUSB @FA${i}@`, `1 WIFE @MO${i}@`, `1 CHIL @P${i}_0@`, `1 CHIL @P${i}_1@`);
}
lines.push("0 TRLR", "");
writeFileSync(FILE, lines.join("\n"), "utf-8");

test("after a merge the next pair opens with its row at the top", async ({ page }) => {
  test.setTimeout(180_000); // the whole-file duplicate scan below waits up to 120 s
  await page.setViewportSize({ width: 1200, height: 700 });
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor({ timeout: 60000 });

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Find duplicates").click();
  // A small file scores its pairs under the default floor; show them all.
  await page.getByRole("button", { name: /weaker pairs? hidden/ }).click({ timeout: 120000 });
  await expect(page.locator(".tools-pairs")).toBeVisible();

  // Open the long pair and merge it from the bar under its comparison.
  const long = page.locator("li.tools-pair", { hasText: "Dolgi" }).first();
  await long.locator(".tools-pair-toggle").click();
  const merge = page.locator(".tools-merge-bar .nav-btn.primary");
  await merge.scrollIntoViewIfNeeded();
  await merge.click();
  await page.locator(".confirm-dialog-confirm").click();

  // The next pair is the open one now, and its row sits at the top of the list.
  const open = page.locator("li.tools-pair", { has: page.locator(".tools-pair-compare") });
  await expect(open).toHaveCount(1);
  await expect(open).not.toContainText("Dolgi");
  await expect.poll(async () => {
    const row = await open.locator(".tools-pair-row").first().boundingBox();
    const view = await page.locator(".tools-view").boundingBox();
    if (!row || !view) return "no box";
    return row.y >= view.y - 2 && row.y < view.y + 120 ? "at top" : `row at ${row.y}, view from ${view.y}`;
  }).toBe("at top");
});
