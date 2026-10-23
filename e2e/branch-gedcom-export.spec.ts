import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// Export → GEDCOM on the Tree chart cuts the branch on screen out of the file:
// the branch's people, the families joining them and the records they cite —
// nobody else, and no pointer left aiming at a record that stayed behind.
const FILE = path.join(tmpdir(), "branch-gedcom-export.ged");

writeFileSync(FILE, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Janez /Kos/", "1 SEX M",
  "1 BIRT", "2 DATE 4 MAY 1900", "2 PLAC Kranj,Slovenia", "2 SOUR @S1@", "3 PAGE fol. 7",
  "1 FAMC @F1@", "1 FAMS @F3@",
  "0 @I2@ INDI", "1 NAME Anton /Kos/", "1 SEX M",
  "1 BIRT", "2 DATE 1870", "1 NOTE @N2@",
  "1 FAMS @F1@",
  "0 @I3@ INDI", "1 NAME Marija /Novak/", "1 SEX F",
  "1 BIRT", "2 DATE 1875", "2 SOUR @S2@",
  "1 FAMS @F1@",
  "0 @I5@ INDI", "1 NAME Mojca /Bergant/", "1 SEX F",
  "1 BIRT", "2 DATE 1905",
  "1 FAMS @F3@",
  "0 @I6@ INDI", "1 NAME Tone /Kos/", "1 SEX M",
  "1 BIRT", "2 DATE 1930", "1 NOTE @N1@",
  "1 ASSO @I7@", "2 RELA Godfather",
  "1 FAMC @F3@", "1 FAMS @F4@",
  "0 @I8@ INDI", "1 NAME Katarina /Hribar/", "1 SEX F",
  "1 BIRT", "2 DATE 1932",
  "1 FAMS @F4@",
  "0 @I9@ INDI", "1 NAME Matej /Kos/", "1 SEX M",
  "1 BIRT", "2 DATE 1958",
  "1 FAMC @F4@",
  // Not related to the branch, only named by it.
  "0 @I7@ INDI", "1 NAME Polona /Tomc/", "1 SEX F", "1 BIRT", "2 DATE 1890",
  "0 @F1@ FAM", "1 HUSB @I2@", "1 WIFE @I3@", "1 CHIL @I1@",
  "0 @F3@ FAM", "1 HUSB @I1@", "1 WIFE @I5@", "1 CHIL @I6@", "1 MARR", "2 DATE 1928",
  "0 @F4@ FAM", "1 HUSB @I6@", "1 WIFE @I8@", "1 CHIL @I9@", "1 MARR", "2 DATE 1955",
  "0 @S1@ SOUR", "1 TITL Župnija Kranj, rojstna knjiga",
  "0 @S2@ SOUR", "1 TITL Župnija Šenčur, rojstna knjiga",
  "0 @N1@ NOTE Tone farmed the family land.",
  "0 @N2@ NOTE Anton was a blacksmith.",
  "0 TRLR", "",
].join("\n"), "utf-8");

test("a chart's GEDCOM export holds the branch and nothing that points outside it", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await expect(page.locator(".edit-name-input").first()).toHaveValue("Janez");
  await page.locator(".charts-open-btn").first().click();
  await page.locator("svg.tree-svg").waitFor();
  await page.getByRole("tab", { name: /^Descendants/ }).click();

  // Janez's descendants with their partners: five people.
  await page.locator(".export-menu .tree-export-btn").click();
  const item = page.getByRole("menuitem", { name: "GEDCOM (5 people)" });
  await expect(item).toBeVisible();
  const dl = page.waitForEvent("download");
  await item.click();
  const text = readFileSync((await (await dl).path())!, "utf-8");
  const lines = text.split(/\r?\n/).filter(Boolean);

  // The branch, its two families and what the branch cites — in file order.
  const records = lines.filter((l) => l.startsWith("0 "));
  expect(records).toEqual([
    "0 HEAD",
    "0 @I1@ INDI", "0 @I5@ INDI", "0 @I6@ INDI", "0 @I8@ INDI", "0 @I9@ INDI",
    "0 @F3@ FAM", "0 @F4@ FAM",
    "0 @S1@ SOUR",
    "0 @N1@ NOTE Tone farmed the family land.",
    "0 TRLR",
  ]);
  // Nobody from outside: not the parents, not the godmother, not their records.
  for (const outside of ["Anton", "Marija", "Polona", "blacksmith", "Šenčur", "@F1@", "@I2@", "@I3@", "@I7@", "@S2@", "@N2@"]) {
    expect(text).not.toContain(outside);
  }
  // Every pointer that is left resolves to a record in the file.
  const defined = new Set(records.map((l) => l.split(" ")[1]).filter((x) => x.startsWith("@")));
  const pointers = lines.flatMap((l) => {
    const m = /^\d+ \S+ (@[^@#][^@]*@)$/.exec(l);
    return m ? [m[1]] : [];
  });
  expect(pointers.length).toBeGreaterThan(0);
  expect(pointers.filter((p) => !defined.has(p))).toEqual([]);
  // The kept data is whole: the citation and its page came along.
  expect(text).toContain("2 SOUR @S1@\n3 PAGE fol. 7");
  expect(text).toContain("1 TITL Župnija Kranj, rojstna knjiga");
  expect(text).toContain("1 HUSB @I6@\n1 WIFE @I8@\n1 CHIL @I9@");

  expect(errors).toEqual([]);
});
