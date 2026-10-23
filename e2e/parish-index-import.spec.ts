import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// A Slovenian parish-register index (a Matricula K sheet — baptisms) loaded
// into the compare slot: the indexed child is matched to the person already
// in the tree, and merging the pair brings the register's facts in.
const MAIN = path.join(tmpdir(), "parish-index-main.ged");
const CSV = path.join(tmpdir(), "parish-index-k.csv");

writeFileSync(MAIN, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Matija /Šega/", "1 SEX M",
  "1 BIRT", "2 DATE 1837",
  "1 FAMC @F1@",
  "0 @I2@ INDI", "1 NAME Anton /Šega/", "1 SEX M", "1 FAMS @F1@",
  "0 @I3@ INDI", "1 NAME Elizabeta /Gornik/", "1 SEX F", "1 FAMS @F1@",
  "0 @F1@ FAM", "1 HUSB @I2@", "1 WIFE @I3@", "1 CHIL @I1@",
  "0 TRLR", "",
].join("\n"), "utf-8");

const K_HEADER =
  "zp. št.;župnija;datum rojstva;datum krsta;naslov;ime otroka;alt.ime otroka;ime očeta;" +
  "priimek očeta;alt.priimek očeta;ime matere;priimek matere;alt.priimek matere;url naslov;opombe;interpret";
const MATRICULA = "https://data.matricula-online.eu/sl/slovenia/ljubljana/grahovo/04455/?pg=2";
writeFileSync(CSV, "﻿" + [
  K_HEADER,
  `1;Grahovo;1837-02-21;1837-02-24;Žerovnica 31;Matija;;Anton;Šega;;Elizabeta;Gornik;;${MATRICULA};;Modic_Mojca`,
  `2;Grahovo;1839-06-02;1839-06-02;Bločice 14;Ana;;Jurij;Krašovic;;Marjeta;Lavrič;;${MATRICULA};;Modic_Mojca`,
  "",
].join("\r\n"), "utf-8");

test("a parish-register index merges a register's facts into the tree", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(MAIN);
  await page.locator(".edit-person").first().waitFor();

  await page.getByRole("button", { name: "Merge", exact: true }).click();
  await page.locator("input.file-input").last().setInputFiles(CSV);
  // The indexed child and both parents named on the row are matched to the
  // tree's three people; the unrelated second row matches nobody.
  const candidates = page.locator(".candidate");
  await expect(candidates).toHaveCount(3);
  const matija = candidates.filter({ hasText: "Matija Šega" });
  await expect(matija).toHaveCount(1);
  await expect(matija).toContainText("99.9");
  await expect(candidates.filter({ hasText: "Anton Šega" })).toContainText("Father");
  await expect(candidates.filter({ hasText: "Elizabeta Gornik" })).toContainText("Mother");
  await expect(candidates.filter({ hasText: "Ana" })).toHaveCount(0);

  // The pair's comparison shows what the register adds.
  await matija.locator(".candidate-main").click();
  const panel = page.locator(".compare-panel").first();
  await expect(panel).toContainText("21 FEB 1837");
  await expect(panel).toContainText("Christening");
  await expect(panel).toContainText("24 FEB 1837");
  await expect(panel).toContainText("Grahovo");
  await page.locator(".decision-bar button").first().click();

  await page.locator(".app-head-actions .export-btn").click();
  const ged = page.waitForEvent("download", (d) => d.suggestedFilename().endsWith(".ged"));
  await page.locator(".preview-actions .export-btn").click();
  const text = readFileSync((await (await ged).path())!, "utf-8");

  // The register's full birth date replaces the bare year, the baptism comes
  // in cited to the Matricula book, and the family is unchanged.
  expect(text).toContain("0 @I1@ INDI\n1 NAME Matija /Šega/\n1 SEX M\n1 BIRT\n2 DATE 21 FEB 1837");
  expect(text).not.toContain("2 DATE 1837\n");
  expect(text).toMatch(/1 CHR\n2 DATE 24 FEB 1837\n2 PLAC Grahovo\n2 SOUR (@\w+@)\n3 PAGE 2/);
  const sour = /1 CHR\n(?:[2-9] .*\n)*?2 SOUR (@\w+@)/.exec(text)![1];
  expect(text).toContain(`0 ${sour} SOUR\n1 TITL Matricula 04455 | Grahovo`);
  expect(text).toContain(`1 FILE ${MATRICULA}`);
  expect(text).toContain("0 @F1@ FAM\n1 HUSB @I2@\n1 WIFE @I3@\n1 CHIL @I1@\n");
  // Nobody from the index was added on their own.
  expect(text.split("\n").filter((l) => / INDI$/.test(l))).toHaveLength(3);
  expect(text).not.toContain("Krašovic");

  expect(errors).toEqual([]);
});
