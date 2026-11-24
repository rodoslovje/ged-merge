import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

/** A person with one short note and two long research notes. */
function writeFixture(): string {
  const long = (title: string) => [
    `1 NOTE ${title}`,
    ...["checked the baptism register", "nothing found before 1864", "census of 1910 names a son", "next: the death register"].map((l) => `2 CONT ${l}`),
  ];
  const ged = [
    "0 HEAD",
    "1 GEDC",
    "2 VERS 5.5.1",
    "1 CHAR UTF-8",
    "0 @I1@ INDI",
    "1 NAME Peter /Ales/",
    "1 SEX M",
    "1 NOTE short note",
    ...long("Research card one"),
    ...long("Research card two"),
    "0 TRLR",
    "",
  ].join("\n");
  const filePath = path.join(tmpdir(), `note-fold-${Date.now()}.ged`);
  writeFileSync(filePath, ged, "utf-8");
  return filePath;
}

test("edit mode: long notes fold to their first line, one by one or all at once", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(writeFixture());
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  // Only the long notes carry a fold arrow, and they open unfolded.
  const folds = page.locator(".edit-notes .note-fold");
  await expect(folds).toHaveCount(2);
  const folded = page.locator(".edit-note-item--collapsed");
  await expect(folded).toHaveCount(0);

  // One note folds on its own; folded, it is one line high.
  const second = page.locator(".edit-note-item--long").nth(1).locator("[contenteditable]");
  const openHeight = (await second.boundingBox())!.height;
  await folds.nth(1).click();
  await expect(folded).toHaveCount(1);
  await expect.poll(async () => (await second.boundingBox())!.height).toBeLessThan(openHeight / 3);

  // "Collapse notes" folds the rest and is remembered by the browser.
  await page.getByRole("button", { name: "Collapse notes" }).click();
  await expect(folded).toHaveCount(2);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("notesCollapsed"))).toBe("true");

  // Clicking into a folded note opens it for typing, and it stays open.
  await second.click();
  await expect(folded).toHaveCount(1);
  await expect(second).toContainText("next: the death register");

  await page.getByRole("button", { name: "Expand notes" }).click();
  await expect(folded).toHaveCount(0);
  await page.getByRole("button", { name: "Collapse notes" }).click();
  await expect(folded).toHaveCount(2);
});
