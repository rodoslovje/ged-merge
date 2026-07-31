// Capture of the landing-page screenshot strip from the live dev server.
// Six shots per theme: Edit view + Tree + Fan from the Tudor sample, the
// Merge view matching Europe Royal Families against the Tudor file, and two
// Map shots from scripts/capture-map-fixture.ged (a family moving across
// Austria-Hungary, coordinates embedded): one on the plain base map, one with
// life paths on the self-hosted Spezialkarte overlay (needs network access
// to tiles.gedmerge.com and the CARTO tile CDN).
// Usage: node scripts/capture-landing-shots.mjs <baseURL> <outDir>
import { chromium } from "@playwright/test";
import { mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(__dirname, "capture-map-fixture.ged");
const TUDOR = path.resolve(__dirname, "../public/samples/EnglishTudorRoyalFamily.ged");

const [base = "http://localhost:5173", outDir = "shots"] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();

/** New context; overlays=true switches the Spezialkarte layer on by default. */
async function makePage(theme, overlays) {
  const ctx = await browser.newContext({
    viewport: { width: 1240, height: 820 },
    deviceScaleFactor: 2,
    colorScheme: theme,
    locale: "en-US",
  });
  const page = await ctx.newPage();
  await page.addInitScript(([t, ov]) => {
    localStorage.setItem("gedmerge.theme", t);
    localStorage.setItem("gedmerge.settings", JSON.stringify({
      allowMapTiles: true,
      mapOverlays: ov ? [{
        id: "capture-spezialkarte",
        name: "",
        url: "",
        presetKey: "settings.map.overlays.preset.spezialkarte",
        defaultOn: true,
      }] : [],
    }));
  }, [theme, overlays]);
  return { ctx, page };
}

async function openCharts(page) {
  await page.locator(".landing-b").waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();
  await page.locator(".charts-open-btn").click();
  await page.locator("svg.tree-svg").waitFor();
}

/** Fit, then screenshot the whole window — controls and header included. */
async function chartShot(page, file) {
  await page.waitForTimeout(600);
  await page.keyboard.press("f");
  await page.waitForTimeout(600);
  await page.screenshot({ path: file });
}

async function openMap(page) {
  await page.goto(base);
  await page.locator("input.file-input").first().setInputFiles(FIXTURE);
  await openCharts(page);
  await page.getByRole("tab", { name: "Map" }).click();
  await page.locator(".map-canvas.leaflet-container").waitFor();
  await page.getByRole("button", { name: "Descendants" }).click();
  await page.locator(".map-paths-chip:not(.active)").click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

for (const theme of ["dark", "light"]) {
  // Tudor sample: Edit view, Tree, Fan; then Europe-vs-Tudor Merge view.
  {
    const { ctx, page } = await makePage(theme, true);
    await page.goto(base);
    await page.locator(".lb-sample-row").nth(2).click();
    await page.locator(".landing-b").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.locator(".edit-person").waitFor();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${outDir}/edit-${theme}.png` });

    await page.locator(".charts-open-btn").click();
    await page.locator("svg.tree-svg").waitFor();
    await chartShot(page, `${outDir}/tree-${theme}.png`);
    await page.getByRole("tab", { name: "Fan" }).click();
    await chartShot(page, `${outDir}/fan-${theme}.png`);

    // Merge: Europe Royal Families as main, the Tudor file as compare.
    await page.goto(base);
    await page.locator(".lb-sample-row").nth(1).click();
    await page.locator(".landing-b").waitFor({ state: "detached", timeout: 60000 });
    await page.locator(".edit-person, .candidate, .merge-view, .match-results").first().waitFor({ timeout: 60000 }).catch(() => {});
    await page.getByRole("button", { name: "Merge", exact: true }).click();
    await page.locator("input.file-input").last().setInputFiles(TUDOR);
    await page.locator(".candidate").first().waitFor({ timeout: 90000 });
    await page.locator(".candidate").first().click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${outDir}/merge-${theme}.png` });
    await ctx.close();
  }

  // Plain base-map shot: fixture family, no overlay.
  {
    const { ctx, page } = await makePage(theme, false);
    await openMap(page);
    await page.waitForFunction(() => document.querySelectorAll('.map-canvas .leaflet-tile-loaded').length >= 12, null, { timeout: 30000 });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${outDir}/map-${theme}.png` });
    await ctx.close();
  }

  // Historical-overlay shot: town-level detail — Ljubljana at the overlay's
  // native max zoom, with the fixture's two in-town locations (Trnovo birth,
  // centre death) over the engraved street grid. Uses the map's automation
  // hook for a precise view.
  {
    const { ctx, page } = await makePage(theme, true);
    await openMap(page);
    await page.evaluate(() => {
      const el = document.querySelector(".map-canvas");
      el._leafletMap.setView([46.0485, 14.504], 14, { animate: false });
    });
    await page.waitForFunction(() => document.querySelectorAll('.map-canvas .leaflet-tile-loaded').length >= 12, null, { timeout: 30000 });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${outDir}/maphist-${theme}.png` });
    await ctx.close();
  }
}

await browser.close();
console.log("done");
