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

/** New context; overlays=true switches the Spezialkarte layer on by default;
 *  phone=true captures the portrait mobile layout (suffix `-m`). */
async function makePage(theme, overlays, phone) {
  const ctx = await browser.newContext({
    viewport: phone ? { width: 390, height: 844 } : { width: 1240, height: 820 },
    deviceScaleFactor: 2,
    colorScheme: theme,
    locale: "en-US",
    isMobile: !!phone,
    hasTouch: !!phone,
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

/** Switch chart kind: desktop tabs, or the phone's picker dropdown. */
async function pickKind(page, phone, name) {
  if (phone) {
    await page.locator(".charts-kind-picker .picker-menu-btn").click();
    await page.locator(".picker-menu-popover").getByText(name, { exact: true }).click();
  } else {
    await page.getByRole("tab", { name }).click();
  }
}

async function openMap(page, phone) {
  await page.goto(base);
  await page.locator("input.file-input").first().setInputFiles(FIXTURE);
  await openCharts(page);
  await pickKind(page, phone, "Map");
  await page.locator(".map-canvas.leaflet-container").waitFor();
  await page.getByRole("button", { name: "Descendants" }).click();
  await page.locator(".map-paths-chip:not(.active)").click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

for (const [theme, phone] of [["dark", false], ["light", false], ["dark", true], ["light", true]]) {
  const m = phone ? "-m" : "";
  // Tudor sample: Edit view, Tree, Fan; then Europe-vs-Tudor Merge view.
  {
    const { ctx, page } = await makePage(theme, true, phone);
    await page.goto(base);
    await page.locator(".lb-sample-row").nth(2).click();
    await page.locator(".landing-b").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.locator(".edit-person").waitFor();
    await page.waitForTimeout(1200);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${outDir}/edit-${theme}${m}.png` });

    await page.locator(".charts-open-btn").click();
    await page.locator("svg.tree-svg").waitFor();
    if (phone) {
      // Zoom out to ~50% and pin the root at the left: root, parents and the
      // grandparents' half-cut column — 2½ readable generations.
      for (let i = 0; i < 3; i++) {
        await page.locator(".tree-zoom-btn:has-text('−')").first().click();
        await page.waitForTimeout(150);
      }
      await page.evaluate(() => { document.querySelector(".tree-canvas").scrollLeft = 0; });
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${outDir}/tree-${theme}${m}.png` });
    } else {
      await chartShot(page, `${outDir}/tree-${theme}${m}.png`);
    }
    await pickKind(page, phone, "Fan");
    // The fan's layout reserves its empty lower half, so plain fit leaves it
    // small — zoom (with the app's own stepper) until the drawn content nearly
    // fills the canvas height, then centre on it.
    await page.waitForTimeout(600);
    await page.keyboard.press("f");
    await page.waitForTimeout(600);
    const factor = await page.evaluate((ph) => {
      const canvas = document.querySelector(".tree-canvas");
      const r = canvas.querySelector("svg g").getBoundingClientRect();
      const byHeight = (ph ? 0.7 : 0.9) * canvas.clientHeight / r.height;
      return ph ? byHeight : Math.min(0.94 * canvas.clientWidth / r.width, byHeight);
    }, phone);
    const steps = Math.round(Math.log(factor) / Math.log(1.25));
    for (let i = 0; i < Math.abs(steps); i++) {
      await page.locator(steps > 0 ? ".tree-zoom-btn:has-text('+')" : ".tree-zoom-btn:has-text('−')").first().click();
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      const canvas = document.querySelector(".tree-canvas");
      const r = canvas.querySelector("svg g").getBoundingClientRect();
      const c = canvas.getBoundingClientRect();
      canvas.scrollLeft += (r.left + r.width / 2) - (c.left + c.width / 2);
      canvas.scrollTop += (r.top + r.height / 2) - (c.top + c.height / 2);
    });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${outDir}/fan-${theme}${m}.png` });

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
    // Desktop shows list + compare side by side from the top; the phone page
    // is one long scroll, so bring the compare dialog itself into frame,
    // clearing the sticky header.
    await page.evaluate((ph) => {
      if (!ph) { window.scrollTo(0, 0); return; }
      const panel = document.querySelector(".section-head.compare-head") ?? document.querySelector(".compare-panel");
      const head = document.querySelector(".app-head");
      const inset = head ? head.getBoundingClientRect().height + 8 : 0;
      window.scrollTo(0, panel.getBoundingClientRect().top + window.scrollY - inset);
    }, phone);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${outDir}/merge-${theme}${m}.png` });
    await ctx.close();
  }

  // Plain base-map shot: the Slovenian/Austrian core of the family's travels,
  // with the Ljubljana cluster's place panel open (birth + death listed).
  {
    const { ctx, page } = await makePage(theme, false, phone);
    await openMap(page, phone);
    await page.evaluate(() => {
      document.querySelector(".map-canvas")._leafletMap.setView([46.55, 15.2], 8, { animate: false });
    });
    await page.waitForFunction(() => document.querySelectorAll('.map-canvas .leaflet-tile-loaded').length >= (window.innerWidth < 721 ? 4 : 8), null, { timeout: 30000 });
    await page.waitForTimeout(1000);
    const pt = await page.evaluate(() => {
      const map = document.querySelector(".map-canvas")._leafletMap;
      const p = map.latLngToContainerPoint([46.0459, 14.5038]);
      const r = document.querySelector(".map-canvas").getBoundingClientRect();
      return { x: r.left + p.x, y: r.top + p.y };
    });
    await page.mouse.click(pt.x, pt.y);
    await page.mouse.move(200, 700); // park the pointer so no hover tooltip shows
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${outDir}/map-${theme}${m}.png` });
    await ctx.close();
  }

  // Historical-overlay shot: town-level detail — Ljubljana at the overlay's
  // native max zoom, with the fixture's two in-town locations (Trnovo birth,
  // centre death) over the engraved street grid. Uses the map's automation
  // hook for a precise view.
  {
    const { ctx, page } = await makePage(theme, true, phone);
    await openMap(page, phone);
    await page.evaluate(() => {
      const el = document.querySelector(".map-canvas");
      el._leafletMap.setView([46.0485, 14.504], 14, { animate: false });
    });
    await page.waitForFunction(() => document.querySelectorAll('.map-canvas .leaflet-tile-loaded').length >= (window.innerWidth < 721 ? 5 : 12), null, { timeout: 30000 });
    await page.locator(".map-overlays-chip").click(); // show which overlay is on
    await page.mouse.move(200, 700);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${outDir}/maphist-${theme}${m}.png` });
    await ctx.close();
  }
}

await browser.close();
console.log("done");
