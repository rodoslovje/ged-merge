import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { enablePersist, waitForCache } from "./persist-util";
import { tmpdir } from "./tmpdir";

// Replacing the loaded main file with a *different* GEDCOM must not leak any of
// the previous file's data into the UI or into the persistence cache.
//
// Regression tests for a real-world report: after loading a second main file,
// the Edit view showed the OLD file's name and birth event mixed into the new
// person. Two files exported by the same software typically reuse xref ids
// (both roots are @I1@), and Edit kept per-person input state keyed by xref —
// so React reused the name/birth inputs (whose local state still held the old
// file's values) while nodeId-keyed event rows remounted with the new data.

const uid = `${process.pid}`;
const FILE_A = path.join(tmpdir(), `reload-a-${uid}.ged`);
const FILE_B = path.join(tmpdir(), `reload-b-${uid}.ged`);
const FILE_C = path.join(tmpdir(), `reload-c-${uid}.ged`);
const FILE_BIG = path.join(tmpdir(), `reload-big-${uid}.ged`);

// The "old" main: root @I1@ Janko Plesina.
writeFileSync(FILE_A, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Janko /Plesina/", "1 SEX M",
  "1 BIRT", "2 DATE 1 JAN 1900", "2 PLAC Kranj",
  "0 TRLR", "",
].join("\n"), "utf-8");

// The replacement main: the SAME xref @I1@ is a different person with a
// different birth plus an extra event.
writeFileSync(FILE_B, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Luka /Renko/", "1 SEX M",
  "1 BIRT", "2 DATE 5 MAY 1980", "2 PLAC Ljubljana",
  "1 RESI", "2 DATE 2010", "2 PLAC Ljubljana",
  "0 TRLR", "",
].join("\n"), "utf-8");

// A replacement whose xrefs do NOT overlap with FILE_A at all.
writeFileSync(FILE_C, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I7@ INDI", "1 NAME Marko /Kovac/", "1 SEX M",
  "1 BIRT", "2 DATE 2 FEB 1950", "2 PLAC Celje",
  "0 TRLR", "",
].join("\n"), "utf-8");

// A large replacement main (~20 MB): its parse takes well over the persistence
// writer's 800 ms debounce, which is the window in which the pre-fix writer
// cached the OLD dataset and then skipped caching the new one for good.
{
  const lines = [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Luka /Bigfile/", "1 SEX M",
    "1 BIRT", "2 DATE 5 MAY 1980", "2 PLAC Ljubljana",
  ];
  for (let n = 2; n <= 150000; n++) {
    lines.push(
      `0 @I${n}@ INDI`,
      `1 NAME Given${n} /Filler${n}/`,
      "1 SEX M",
      "1 BIRT",
      `2 DATE 1 JAN ${1600 + (n % 400)}`,
      "2 PLAC Kraj",
    );
  }
  lines.push("0 TRLR", "");
  writeFileSync(FILE_BIG, lines.join("\n"), "utf-8");
}

/** Load `file` as the replacement main via the header file pill → info panel. */
async function replaceMain(page: import("@playwright/test").Page, file: string) {
  await page.locator(".header-file-btn.main").click();
  await page.locator("input.file-input").first().setInputFiles(file);
  await expect(page.locator(".header-file-btn.main")).toContainText(path.basename(file), { timeout: 30000 });
}

test("replacing the main shows the new file's person even when xrefs collide", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE_A);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();
  await expect(page.locator(".edit-name-input").first()).toHaveValue("Janko");
  await expect(page.locator(".edit-event .edit-event-date").first()).toHaveValue("1 JAN 1900");

  await replaceMain(page, FILE_B);

  // Both files call their root @I1@ — every field must now show the NEW file's
  // person. Pre-fix, the name and birth inputs kept the old file's values
  // ("Janko", "1 JAN 1900") because their React keys collided across files.
  await page.locator(".edit-person").waitFor();
  await expect(page.locator(".edit-name-input").first()).toHaveValue("Luka", { timeout: 15000 });
  await expect(page.locator(".edit-name-input").nth(1)).toHaveValue("Renko");
  await expect(page.locator(".edit-event .edit-event-date").first()).toHaveValue("5 MAY 1980");
  await expect(page.locator(".edit-event .edit-event-place").first()).toHaveValue("Ljubljana");
});

test("replacing the main with non-overlapping xrefs lands on a real person, not an empty view", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE_A);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  await replaceMain(page, FILE_C);

  // The previously-shown @I1@ does not exist in the new file; the view must
  // fall back to the new file's default person instead of a dead id.
  await page.locator(".edit-person").waitFor();
  await expect(page.locator(".edit-name-input").first()).toHaveValue("Marko", { timeout: 15000 });
});

test("after replacing the main, a reload restores the NEW file (cache not poisoned by the old one)", async ({ page }) => {
  test.setTimeout(120000); // large-file parse runs three times (load, cache, restore)
  await enablePersist(page);
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE_A);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();
  await waitForCache(page, { mainContains: "Plesina" }); // old main cached

  // Replace with a file large enough that its parse outlives the 800 ms
  // persistence debounce — pre-fix, the writer fired mid-parse, re-cached the
  // OLD dataset, marked the main "already cached", and the new file was never
  // written; a reload then silently restored the old file.
  await replaceMain(page, FILE_BIG);
  await waitForCache(page, { mainContains: "Bigfile" });

  await page.reload();
  await page.locator(".edit-person").waitFor({ timeout: 60000 });
  await expect(page.locator(".header-file-btn.main")).toContainText(path.basename(FILE_BIG));
  await expect(page.locator(".edit-name-input").first()).toHaveValue("Luka", { timeout: 15000 });
});
