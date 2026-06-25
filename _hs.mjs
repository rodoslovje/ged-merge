import { chromium } from "playwright";
import path from "path";
const F = path.resolve("test-data/Trstenjak.ged");
const OUT = "/private/tmp/claude-501/-Users-lukarenko-rodoslovje-ged-merge/c7b9d759-a6b1-436d-ba14-306f3d358ecc/scratchpad/";
const url = "http://localhost:5174/";
const browser = await chromium.launch();
for (const w of [1400, 950, 760, 600]) {
  const page = await browser.newPage({ viewport: { width: w, height: 700 } });
  await page.goto(url);
  await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles(F);
  await page.locator(".edit-person").waitFor();
  await page.waitForTimeout(300);
  const sel = await page.locator(".app-head-controls .home-selector").boundingBox();
  const tabs = await page.locator(".mode-tabs").boundingBox();
  console.log(`w=${w} selector=${Math.round(sel.width)}px selTop=${Math.round(sel.y)} tabsTop=${Math.round(tabs.y)} sameRow=${Math.abs(sel.y-tabs.y)<10}`);
  await page.locator("header.app-head").screenshot({ path: OUT + `hs_${w}.png` });
  await page.close();
}
await browser.close();
console.log("done");
