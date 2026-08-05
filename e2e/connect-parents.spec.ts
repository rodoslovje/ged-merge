import { test, expect, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "fs";
import os from "os";
import path from "path";

/** A child with no parents, beside a couple who already have a family of their
 *  own — the shape that produced a second family for that couple when the
 *  child's father and mother were attached one after the other. */
function writeCoupleFixture(): string {
  const ged = [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Jakob /Kalan/", "1 SEX M",
    "0 @P1@ INDI", "1 NAME Matevz /Kalan/", "1 SEX M", "1 FAMS @FX@",
    "0 @P2@ INDI", "1 NAME Marija /Drinovec/", "1 SEX F", "1 FAMS @FX@",
    "0 @S1@ INDI", "1 NAME Ana /Kalan/", "1 SEX F", "1 FAMC @FX@",
    "0 @FX@ FAM", "1 HUSB @P1@", "1 WIFE @P2@", "1 CHIL @S1@", "1 MARR", "2 DATE 23 NOV 1887",
    "0 TRLR", "",
  ].join("\n");
  const file = path.join(os.tmpdir(), `couple-${Date.now()}.ged`);
  writeFileSync(file, ged, "utf-8");
  return file;
}

/** Save the file and return what was written. */
async function saveAndRead(page: Page): Promise<string> {
  await page.locator(".app-head-actions .export-btn").click();
  const download = page.waitForEvent("download", (d) => d.suggestedFilename().endsWith(".ged"));
  await page.locator(".preview-actions .export-btn").click();
  const file = await (await download).path();
  return readFileSync(file!, "utf-8");
}

/** Every `FAMS`/`FAMC` on an individual that the named family does not answer
 *  with a matching `HUSB`/`WIFE`/`CHIL`, and vice versa — reported as pairs so
 *  a failure names the broken link. */
function pointerPairs(ged: string): string[] {
  const records = ged.split(/\n0 /).map((r) => (r.startsWith("0 ") ? r.slice(2) : r));
  const fams = new Map<string, string>();
  const indis = new Map<string, string>();
  for (const rec of records) {
    const xref = rec.match(/^(@[^@]+@)\s+(INDI|FAM)/);
    if (!xref) continue;
    (xref[2] === "FAM" ? fams : indis).set(xref[1], rec);
  }
  const broken: string[] = [];
  for (const [id, rec] of indis) {
    for (const [, tag, famId] of rec.matchAll(/\n1 (FAMS|FAMC) (@[^@]+@)/g)) {
      const fam = fams.get(famId);
      const answered = tag === "FAMS"
        ? fam?.includes(`HUSB ${id}`) || fam?.includes(`WIFE ${id}`)
        : fam?.includes(`CHIL ${id}`);
      if (!answered) broken.push(`${id} ${tag} ${famId}`);
    }
  }
  for (const [id, rec] of fams) {
    for (const [, tag, indiId] of rec.matchAll(/\n1 (HUSB|WIFE|CHIL) (@[^@]+@)/g)) {
      const indi = indis.get(indiId);
      const wanted = tag === "CHIL" ? "FAMC" : "FAMS";
      if (!indi?.includes(`${wanted} ${id}`)) broken.push(`${id} ${tag} ${indiId}`);
    }
  }
  return broken;
}

/** Fill an empty parent slot from the people already in the file. */
async function pickExistingParent(page: Page, slot: RegExp, name: string) {
  await page.locator(".edit-parents .person-card-add").filter({ hasText: slot }).first().click();
  const picker = page.locator(".relative-picker");
  await picker.locator(".relative-picker-input").fill(name);
  await picker.locator(".relative-picker-option", { hasText: name }).first().click();
  await expect(page.locator(".edit-parents")).toContainText(name);
}

test("attaching an existing father then mother joins their family, not a copy of it", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(writeCoupleFixture());
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();
  await expect(page.locator(".edit-name-input").first()).toHaveValue("Jakob");

  await pickExistingParent(page, /Add Father/i, "Matevz");
  await pickExistingParent(page, /Add Mother/i, "Marija");

  // Jakob landed in the couple's own family, so it brings that family's
  // marriage with it — a fresh duplicate would carry none.
  await expect(page.locator(".edit-parents")).toContainText("23 NOV 1887");

  // One step back and forward again, before any save clears the history.
  await page.keyboard.press("Control+z");
  await expect(page.locator(".edit-parents")).not.toContainText("Marija");
  await page.keyboard.press("Control+Shift+z");
  await expect(page.locator(".edit-parents")).toContainText("Marija");
  await expect(page.locator(".edit-parents")).toContainText("23 NOV 1887");

  const ged = await saveAndRead(page);
  expect(pointerPairs(ged)).toEqual([]);
  // The couple are recorded once: one FAM names them both, holding both children.
  const fams = ged.split(/\n0 /).filter((r) => r.startsWith("@") && r.includes(" FAM"));
  const theirs = fams.filter((f) => f.includes("HUSB @P1@") && f.includes("WIFE @P2@"));
  expect(theirs).toHaveLength(1);
  expect(theirs[0]).toContain("CHIL @I1@");
  expect(theirs[0]).toContain("CHIL @S1@");
});

test("undoing the mother restores the family the connect dissolved, pointers and all", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(writeCoupleFixture());
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  await pickExistingParent(page, /Add Father/i, "Matevz");
  await pickExistingParent(page, /Add Mother/i, "Marija");
  await page.keyboard.press("Control+z");
  await expect(page.locator(".edit-parents")).toContainText("Matevz");
  await expect(page.locator(".edit-parents")).not.toContainText("Marija");

  // The stub family comes back — and so does the father's FAMS into it. A
  // record restored without the pointers back looks right on every screen, so
  // this has to be read off the file.
  expect(pointerPairs(await saveAndRead(page))).toEqual([]);
});
