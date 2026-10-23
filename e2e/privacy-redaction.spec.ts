import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// Tools → Privacy end to end: the redacted download replaces the living
// person's name, drops the shared note only they cited, keeps the dead people
// whole — and the file open in the app is not touched.
const FILE = path.join(tmpdir(), "privacy-redaction.ged");

writeFileSync(FILE, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Petra /Zorman/", "1 SEX F",
  "1 BIRT", "2 DATE 12 MAR 1990", "2 PLAC Kranj,Slovenia",
  "1 NOTE @N1@",
  "1 FAMC @F1@",
  "0 @I2@ INDI", "1 NAME Franc /Zorman/", "1 SEX M",
  "1 BIRT", "2 DATE 3 JAN 1890", "2 PLAC Škofja Loka,Slovenia",
  "1 DEAT", "2 DATE 7 JUL 1960",
  "1 FAMS @F1@",
  "0 @I3@ INDI", "1 NAME Ivana /Bergant/", "1 SEX F",
  "1 BIRT", "2 DATE 1895",
  "1 DEAT", "2 DATE 1970",
  "1 FAMS @F1@",
  "0 @F1@ FAM", "1 HUSB @I2@", "1 WIFE @I3@", "1 CHIL @I1@",
  "1 MARR", "2 DATE 1920",
  "0 @N1@ NOTE Petra works at the Kranj hospital, phone 041 123 456.",
  "0 TRLR", "",
].join("\n"), "utf-8");

function record(text: string, xref: string): string {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => l.startsWith(`0 ${xref} `));
  if (at < 0) return "";
  const end = lines.findIndex((l, i) => i > at && l.startsWith("0 "));
  return lines.slice(at, end < 0 ? undefined : end).join("\n");
}

test("privacy download redacts the living and leaves the open file alone", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor();

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Privacy", { exact: true }).first().click();
  await expect(page.locator(".tools-privacy")).toContainText("1 living person flagged");
  await page.locator(".tools-privacy .tools-issue-link").click();
  const flagged = page.locator(".tools-privacy .tools-issue");
  await expect(flagged).toHaveCount(1);
  await expect(flagged.first()).toContainText("Petra");

  const ged = page.waitForEvent("download", (d) => d.suggestedFilename().endsWith(".ged"));
  const report = page.waitForEvent("download", (d) => d.suggestedFilename().endsWith(".report.txt"));
  await page.getByRole("button", { name: "Download redacted GEDCOM" }).click();
  const text = readFileSync((await (await ged).path())!, "utf-8");
  const audit = readFileSync((await (await report).path())!, "utf-8");

  // The living person: name replaced, details and the note link gone, the
  // tree link kept, the record stamped as private.
  const petra = record(text, "@I1@");
  expect(petra).not.toBe("");
  expect(petra).not.toContain("Petra");
  expect(petra).not.toContain("1990");
  expect(petra).not.toContain("Kranj");
  expect(petra).not.toContain("@N1@");
  expect(petra).toMatch(/1 NAME Living/);
  expect(petra).toContain("1 FAMC @F1@");
  expect(petra).toContain("1 RESN privacy");
  // Her note was hers alone: the record leaves with her.
  expect(text).not.toContain("0 @N1@ NOTE");
  expect(text).not.toContain("hospital");

  // The dead parents are untouched.
  const franc = record(text, "@I2@");
  expect(franc).toContain("1 NAME Franc /Zorman/");
  expect(franc).toContain("2 DATE 3 JAN 1890");
  expect(franc).toContain("2 PLAC Škofja Loka,Slovenia");
  expect(franc).toContain("2 DATE 7 JUL 1960");
  expect(record(text, "@I3@")).toContain("1 NAME Ivana /Bergant/");
  const fam = record(text, "@F1@");
  expect(fam).toContain("1 CHIL @I1@");
  expect(fam).toContain("2 DATE 1920");

  expect(audit).toContain("Flagged living people (1)");
  expect(audit).toContain("@I1@");

  // The open file still has everything: Petra's record and her note.
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator(".edit-name-input").first()).toHaveValue("Petra");
  await expect(page.locator(".edit-person").first()).toContainText("Kranj");
  await expect(page.locator(".edit-person").first()).toContainText("hospital");

  expect(errors).toEqual([]);
});
