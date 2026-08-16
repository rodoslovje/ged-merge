import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "./tmpdir";

// The find box on the two surfaces that aren't charts: the Report (jump to a
// numbered entry) and the Map (fly to a point, found by person *or* place).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(__dirname, "../src/__fixtures__/corpus/reunion-5.5.1-utf8.ged");

// Chart kinds in hub order, for the digit shortcuts.
const MAP_KEY = "7";
const REPORT_KEY = "8";

// A tiny geocoded file: the corpus fixtures carry no MAP coordinates, so the
// map would draw nothing to find.
const MAPPED = path.join(tmpdir(), "find-map.ged");
const KRANJ = ["3 MAP", "4 LATI N46.239", "4 LONG E14.355"];
const DELNICE = ["3 MAP", "4 LATI N45.401", "4 LONG E14.801"];
writeFileSync(MAPPED, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Ana /Kovac/", "1 SEX F",
  "1 BIRT", "2 DATE 12 JAN 1900", "2 PLAC Kranj,Kranj,Slovenia", ...KRANJ,
  "1 DEAT", "2 DATE 1975", "2 PLAC Delnice,Gorski kotar,Croatia", ...DELNICE,
  "1 FAMC @F1@",
  "0 @I2@ INDI", "1 NAME Jozef /Kovac/", "1 SEX M",
  "1 BIRT", "2 DATE 1870", "2 PLAC Kranj,Kranj,Slovenia", ...KRANJ,
  "1 FAMS @F1@",
  "0 @I3@ INDI", "1 NAME Marija /Novak/", "1 SEX F",
  "1 BIRT", "2 DATE 1875", "2 PLAC Delnice,Gorski kotar,Croatia", ...DELNICE,
  "1 FAMS @F1@",
  "0 @F1@ FAM", "1 HUSB @I2@", "1 WIFE @I3@", "1 CHIL @I1@",
  "0 TRLR", "",
].join("\n"), "utf-8");

/** Does anything in the page claim ⌘/Ctrl+F? */
async function findChordPrevented(page: import("@playwright/test").Page): Promise<boolean> {
  return page.evaluate(() => {
    const e = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  });
}

async function openChart(page: import("@playwright/test").Page, file: string, kindKey: string) {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(file);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });
  await page.locator(".charts-open-btn").first().click();
  await page.keyboard.press(kindKey);
}

test("report find box scrolls to a person's entry", async ({ page }) => {
  await openChart(page, SAMPLE, REPORT_KEY);
  await page.locator(".report-entry").first().waitFor({ timeout: 15000 });

  const names = await page.locator(".report-entry .report-name").allTextContents();
  const target = names[Math.min(6, names.length - 1)].trim().split(/\s+/)[0];
  await page.locator(".chart-find input").fill(target);

  // The found entry is flashed, and the counter reads as entries, not "places".
  await expect(page.locator(".report-flash")).toHaveCount(1, { timeout: 5000 });
  await expect(page.locator(".report-flash")).toHaveAttribute("id", /^report-entry-\d+$/);
  await expect(page.locator(".chart-find-count")).toHaveAttribute("title", /entr(y|ies) in this report/);

  // Ctrl+F stays with the browser here — a report is plain text. Dispatched
  // synthetically: a real chord would open the browser's own find bar, which
  // the test can neither see nor dismiss. What matters is that nothing in the
  // page swallows it.
  expect(await findChordPrevented(page)).toBe(false);
});

test("map find box flies to a point, by person or by place", async ({ page }) => {
  await openChart(page, MAPPED, MAP_KEY);
  await page.locator(".map-count").first().waitFor({ timeout: 20000 });

  // A place name: the map's haystack carries place and address too.
  await page.keyboard.press("ControlOrMeta+f");
  await expect(page.locator(".chart-find input")).toBeFocused();
  await page.keyboard.type("Delnice");
  await expect(page.locator(".chart-find-count")).toHaveAttribute("title", /2 points on this map/, { timeout: 5000 });
  // The hit opens its event panel, so it says what was found.
  await expect(page.locator(".map-panel")).toBeVisible();

  // A person's name finds their events.
  await page.locator(".chart-find input").fill("Ana Kovac");
  await expect(page.locator(".chart-find-count")).toHaveAttribute("title", /2 points on this map/, { timeout: 5000 });

  // A miss says why nothing was found — the map has no re-root to offer.
  await page.locator(".chart-find input").fill("zzzznobody");
  await expect(page.locator(".chart-find-msg")).toContainText("places need coordinates", { timeout: 5000 });
});
