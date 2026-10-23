import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

/**
 * The whole app in Slovenian, end to end: a browser whose language is
 * Slovenian gets the Slovenian interface (no saved choice), and every screen
 * the walk reaches — Edit, a chart, Tools, Merge and the save preview — speaks
 * it. The labels asserted are copied from `src/locales/sl.ts`.
 *
 * The second half of each check is the one a translation slip actually
 * produces: a key missing from both bundles renders as its own name
 * (`tools.validate.clean`), which no English-locale spec would ever see.
 */
test.use({ locale: "sl-SI" });

const MAIN = path.join(tmpdir(), "sl-smoke-main.ged");
const COMPARE = path.join(tmpdir(), "sl-smoke-compare.ged");

writeFileSync(MAIN, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Janez /Novak/", "1 SEX M",
  "1 BIRT", "2 DATE 12 MAR 1850", "2 PLAC Kranj, Gorenjska, Slovenija",
  "1 FAMC @F1@",
  "0 @I2@ INDI", "1 NAME Jože /Novak/", "1 SEX M",
  "1 BIRT", "2 DATE 1820", "1 FAMS @F1@",
  "0 @I3@ INDI", "1 NAME Marija /Kos/", "1 SEX F",
  "1 BIRT", "2 DATE 1825", "1 FAMS @F1@",
  "0 @F1@ FAM", "1 HUSB @I2@", "1 WIFE @I3@", "1 CHIL @I1@",
  "0 TRLR", "",
].join("\n"), "utf-8");

writeFileSync(COMPARE, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @P1@ INDI", "1 NAME Janez /Novak/", "1 SEX M",
  "1 BIRT", "2 DATE 12 MAR 1850", "2 PLAC Kranj, Gorenjska, Slovenija",
  "1 DEAT", "2 DATE 4 APR 1910",
  "0 TRLR", "",
].join("\n"), "utf-8");

/** What a missing translation looks like on screen: a dotted lowercase key. */
const RAW_KEY = /^[a-z]+(\.[a-zA-Z0-9]+)+$/;

/** Every visible text node and every label-carrying attribute that reads as a
 *  raw i18n key. Retried by the caller, so a frame mid-render cannot pass. */
async function rawKeysOnScreen(page: Page): Promise<string[]> {
  return page.evaluate((src) => {
    const re = new RegExp(src);
    const found = new Set<string>();
    const visible = (el: Element | null) => !!el && (el as HTMLElement).offsetParent !== null;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = (n.textContent ?? "").trim();
      if (text && re.test(text) && visible(n.parentElement)) found.add(text);
    }
    for (const el of document.querySelectorAll("[title], [aria-label], [placeholder], [data-tip]")) {
      if (!visible(el)) continue;
      for (const attr of ["title", "aria-label", "placeholder", "data-tip"]) {
        const v = el.getAttribute(attr)?.trim();
        if (v && re.test(v)) found.add(`${attr}=${v}`);
      }
    }
    return [...found];
  }, RAW_KEY.source);
}

async function expectNoRawKeys(page: Page, where: string) {
  await expect.poll(() => rawKeysOnScreen(page), { message: `raw i18n keys on ${where}` }).toEqual([]);
}

test("the app walks through Edit, a chart, Tools, Merge and Save in Slovenian", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(MAIN);
  await page.locator(".edit-person").first().waitFor();

  // Edit — the mode switch and the person's own events.
  await expect(page.getByRole("button", { name: "Urejanje", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Združevanje", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Orodja", exact: true })).toBeVisible();
  // The birth row's fields are named after the event, and the date is shown
  // in the Slovenian long form.
  await expect(page.locator(".edit-person").getByRole("textbox", { name: /^Datum \(Rojstvo\)/ }).first()).toBeVisible();
  await expect(page.locator(".edit-person").getByRole("textbox", { name: /^Kraj \(Rojstvo\)/ }).first()).toBeVisible();
  await expectNoRawKeys(page, "Edit");

  // A chart, opened from Edit.
  await page.locator(".charts-open-btn").click();
  await page.locator("svg.tree-svg").waitFor();
  const kinds = page.getByRole("tablist", { name: "Vrsta diagrama" });
  await expect(kinds.getByRole("tab", { name: "Drevo", exact: true })).toBeVisible();
  await expect(kinds.getByRole("tab", { name: "Pahljača", exact: true })).toBeVisible();
  await expectNoRawKeys(page, "the chart");
  await page.keyboard.press("Escape");
  await page.locator(".edit-person").first().waitFor();

  // Tools — the health check, run over the file.
  await page.getByRole("button", { name: "Orodja", exact: true }).click();
  await page.getByText("Pregled", { exact: true }).first().click();
  await expect(page.locator(".tools-issues, .tools-clean").first()).toBeVisible();
  await expect(
    page.getByText("Pregled ni našel nobenih težav. 🎉").or(page.locator(".tools-chip", { hasText: "Vse" })).first(),
  ).toBeVisible();
  await expectNoRawKeys(page, "Tools");

  // Merge — an incoming file, its one candidate, confirmed.
  await page.getByRole("button", { name: "Združevanje", exact: true }).click();
  await page.locator("input.file-input").last().setInputFiles(COMPARE);
  await page.locator(".candidate").first().waitFor();
  await page.locator(".candidate-main").first().click();
  const confirm = page.locator(".decision-bar").getByRole("button", { name: "Potrdi", exact: true });
  await expect(confirm).toBeVisible();
  await expect(page.locator(".decision-bar").getByRole("button", { name: "Zavrni", exact: true })).toBeVisible();
  await expectNoRawKeys(page, "Merge");
  await confirm.click();
  await expect(page.locator(".decision-bar").getByRole("button", { name: "Potrjeno", exact: true })).toBeVisible();

  // The save preview.
  const saveBtn = page.locator(".app-head-actions .export-btn");
  await expect(saveBtn).toBeEnabled();
  await saveBtn.click();
  const actions = page.locator(".preview-actions");
  await expect(actions.getByRole("button", { name: "Prekliči", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Spremembe", exact: true })).toBeVisible();
  await expect(page.getByText("Prenesi tudi poročilo o spremembah v tekstovni datoteki")).toBeVisible();
  await expectNoRawKeys(page, "the save preview");

  expect(errors).toEqual([]);
});
