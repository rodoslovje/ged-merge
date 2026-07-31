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
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();
  await page.locator(".charts-open-btn").click();
  await page.locator("svg.tree-svg").waitFor();
  await page.addStyleTag({ content: ".tree-zoom{display:none!important}" });
}

/** Fit, then screenshot clipped to the drawn svg content, padded. */
async function chartShot(page, file) {
  await page.waitForTimeout(600);
  await page.keyboard.press("f");
  await page.waitForTimeout(600);
  const PAD = 20;
  const box = await page.locator(".tree-canvas-wrap").boundingBox();
  const rect = await page.evaluate(() => {
    const g = document.querySelector(".tree-canvas-wrap svg g");
    const r = g.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const x = Math.max(box.x, rect.x - PAD);
  const y = Math.max(box.y, rect.y - PAD);
  const clip = {
    x, y,
    width: Math.min(box.x + box.width, rect.x + rect.w + PAD) - x,
    height: Math.min(box.y + box.height, rect.y + rect.h + PAD) - y,
  };
  await page.screenshot({ path: file, clip });
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
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.locator(".edit-person").waitFor();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${outDir}/edit-${theme}.png` });

    await page.locator(".charts-open-btn").click();
    await page.locator("svg.tree-svg").waitFor();
    await page.addStyleTag({ content: ".tree-zoom{display:none!important}" });
    await chartShot(page, `${outDir}/tree-${theme}.png`);
    await page.getByRole("tab", { name: "Fan" }).click();
    await chartShot(page, `${outDir}/fan-${theme}.png`);

    // Merge: Europe Royal Families as main, the Tudor file as compare.
    await page.goto(base);
    await page.locator(".lb-sample-row").nth(1).click();
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
    await page.waitForTimeout(3500); // let base tiles arrive
    await page.locator(".map-canvas-wrap").screenshot({ path: `${outDir}/map-${theme}.png` });
    await ctx.close();
  }

  // Historical-overlay shot: same view on the Spezialkarte, zoomed in one
  // step past the fit so the engraving reads, nudged toward the path center.
  {
    const { ctx, page } = await makePage(theme, true);
    await openMap(page);
    await page.locator(".map-canvas .leaflet-control-zoom-in").click();
    await page.waitForTimeout(800);
    const box = await page.locator(".map-canvas").boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 60, cy + 35, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(4500); // let base + overlay tiles arrive
    await page.locator(".map-canvas-wrap").screenshot({ path: `${outDir}/maphist-${theme}.png` });
    await ctx.close();
  }
}

await browser.close();
console.log("done");
