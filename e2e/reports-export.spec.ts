import { test, expect, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// The Report chart end to end: the ancestor register (Ahnentafel) and the
// descendant register, in the list and the narrative style, downloaded as text
// and RTF — and a living descendant redacted once the privacy toggle is on.
const FILE = path.join(tmpdir(), "reports-export.ged");

writeFileSync(FILE, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Janez /Kos/", "1 SEX M",
  "1 BIRT", "2 DATE 4 MAY 1900", "2 PLAC Kranj,Slovenia",
  "1 DEAT", "2 DATE 1970",
  "1 FAMC @F1@", "1 FAMS @F3@",
  "0 @I2@ INDI", "1 NAME Anton /Kos/", "1 SEX M",
  "1 BIRT", "2 DATE 1870", "1 DEAT", "2 DATE 1940",
  "1 FAMC @F2@", "1 FAMS @F1@",
  "0 @I3@ INDI", "1 NAME Marija /Novak/", "1 SEX F",
  "1 BIRT", "2 DATE 1875", "1 DEAT", "2 DATE 1950",
  "1 FAMS @F1@",
  "0 @I4@ INDI", "1 NAME Jakob /Kos/", "1 SEX M",
  "1 BIRT", "2 DATE 1840", "1 DEAT", "2 DATE 1910",
  "1 FAMS @F2@",
  "0 @I5@ INDI", "1 NAME Mojca /Bergant/", "1 SEX F",
  "1 BIRT", "2 DATE 1905", "1 DEAT", "2 DATE 1985",
  "1 FAMS @F3@",
  // Living: born 1960, no death.
  "0 @I6@ INDI", "1 NAME Vesna /Kos/", "1 SEX F",
  "1 BIRT", "2 DATE 9 SEP 1960", "2 PLAC Ljubljana,Slovenia",
  "1 FAMC @F3@",
  "0 @F1@ FAM", "1 HUSB @I2@", "1 WIFE @I3@", "1 CHIL @I1@",
  "0 @F2@ FAM", "1 HUSB @I4@", "1 CHIL @I2@",
  "0 @F3@ FAM", "1 HUSB @I1@", "1 WIFE @I5@", "1 CHIL @I6@",
  "1 MARR", "2 DATE 1928",
  "0 TRLR", "",
].join("\n"), "utf-8");

const REPORT_KEY = "7";

async function exportAs(page: Page, item: "Text file" | "RTF document"): Promise<string> {
  await page.locator(".export-menu .tree-export-btn").click();
  const dl = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: item }).click();
  const d = await dl;
  expect(d.suggestedFilename()).toMatch(item === "Text file" ? /\.txt$/ : /\.rtf$/);
  return readFileSync((await d.path())!, "utf-8");
}

test("reports download as text and RTF, with the living redacted on request", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await expect(page.locator(".edit-name-input").first()).toHaveValue("Janez");
  await page.locator(".charts-open-btn").first().click();
  await page.keyboard.press(REPORT_KEY);
  await page.locator(".report-entry").first().waitFor();

  // Both registers at once (the page's default direction), as text: the root
  // opens each, the generations are numbered and named.
  const both = await exportAs(page, "Text file");
  expect(both).toContain("Janez Kos 1900–1970 — Ancestors Register (Ahnentafel)");
  expect(both).toContain("Janez Kos 1900–1970 — Descendant Register (NGSQ)");
  expect(both).toContain("1. Janez Kos (1900–1970)\n   * 4 MAY 1900, Kranj,Slovenia");
  expect(both).toContain("Generation 1 — Parents · nos. 2–3 · 2 of 2 known");
  expect(both).toContain("2. Anton Kos (1870–1940)");
  expect(both).toContain("3. Marija Novak (1875–1950)");
  expect(both).toContain("Generation 2 — Grandparents · no. 4 · 1 of 4 known");
  expect(both).toContain("4. Jakob Kos (1840–1910)");
  expect(both).toContain("Generation 1 — Children · no. 2");
  expect(both).toContain("2 I. Vesna Kos (1960)");

  // …and as RTF, the same numbering in RTF markup.
  const bothRtf = await exportAs(page, "RTF document");
  expect(bothRtf.startsWith("{\\rtf1")).toBe(true);
  expect(bothRtf).toContain("Ancestors Register (Ahnentafel)");
  expect(bothRtf).toContain("1.\\tab {\\b Janez Kos}");
  expect(bothRtf).toContain("{\\caps Generation 2 \\u8212? Grandparents}");
  expect(bothRtf).toContain("4.\\tab {\\b Jakob Kos}");
  expect(bothRtf).toContain("2 I.\\tab {\\b Vesna Kos}");

  // The descendant register alone, in the narrative style.
  await page.getByRole("tab", { name: /^Descendants/ }).click();
  await page.getByRole("tab", { name: "Narrative" }).click();
  const narr = await exportAs(page, "Text file");
  expect(narr).not.toContain("Ancestors Register");
  expect(narr).toContain("Janez Kos was born on 4 May 1900 in Kranj, Slovenia.");
  expect(narr).toContain("He married Mojca Bergant (1905–1985) in 1928.");
  expect(narr).toContain("Vesna Kos was born on 9 September 1960 in Ljubljana, Slovenia.");

  // Privacy on: the living daughter's entry keeps its number and loses the
  // name, the dates and the place, in the list text and in the RTF.
  await page.getByRole("tab", { name: "List" }).click();
  await page.locator(".chart-settings-btn").click();
  await page.getByRole("button", { name: "Hide living people" }).click();
  await expect(page.locator(".report-entry .report-name", { hasText: "Vesna" })).toHaveCount(0);
  const priv = await exportAs(page, "Text file");
  expect(priv).toContain("1. Janez Kos (1900–1970)");
  expect(priv).toContain("2 I. Daughter");
  expect(priv).not.toContain("Vesna");
  expect(priv).not.toContain("1960");
  expect(priv).not.toContain("Ljubljana");
  const privRtf = await exportAs(page, "RTF document");
  expect(privRtf).toContain("2 I.\\tab {\\b Daughter}");
  expect(privRtf).not.toContain("Vesna");
  expect(privRtf).not.toContain("1960");

  expect(errors).toEqual([]);
});
