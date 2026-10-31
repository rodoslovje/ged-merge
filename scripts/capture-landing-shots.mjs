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
  await showCharts(page);
}

/** The top bar's Charts button; a phone keeps it in the ☰ menu, so use V. */
async function showCharts(page) {
  const btn = page.locator(".charts-open-btn");
  if (await btn.isVisible()) await btn.click();
  else await page.keyboard.press("v");
  await page.locator("svg.tree-svg").waitFor();
}

/** Fit, then screenshot the whole window — controls and header included. */
async function chartShot(page, file) {
  await page.waitForTimeout(600);
  await page.keyboard.press("f");
  await page.waitForTimeout(600);
  await page.screenshot({ path: file });
}

/** The hub's digit keys, in its tab order (ChartsHub's HUB_KINDS). */
const KIND_KEY = { Tree: "1", Fan: "2", Map: "6" };

/** Switch chart kind: desktop tabs; a phone folds them into the ☰ menu, so
 *  use the hub's digit key instead. */
async function pickKind(page, phone, name) {
  if (phone) {
    await page.keyboard.press(KIND_KEY[name]);
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
  // A phone folds the direction into the ☰ menu; its default, Both, draws
  // the descendants too.
  const desc = page.getByRole("tab", { name: "Descendants" });
  if (await desc.isVisible()) await desc.click();
  await page.locator(".map-paths-chip:not(.active)").click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

for (const [theme, phone] of [["dark", false], ["light", false], ["dark", true], ["light", true]]) {
  const m = phone ? "-m" : "";
  // Tudor sample: Edit view, Tree, Fan; then Europe-vs-Tudor Merge view.
  {
    const { ctx, page } = await makePage(theme, true, phone);
    await page.goto(base);
    await page.locator(".lp-sample-tile").nth(1).click();
    await page.locator(".landing-b").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.locator(".edit-person").waitFor();
    // The first-open target-format notice is not what the shot is about.
    const later = page.getByRole("button", { name: "Later", exact: true });
    if (await later.isVisible()) await later.click();
    await page.waitForTimeout(1200);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${outDir}/edit-${theme}${m}.png` });

    await showCharts(page);
    // The hub opens on Both (a bowtie); the shots show the ancestors (A).
    await page.keyboard.press("a");
    if (phone) {
      // Zoom out to ~50% and pin the root at the left: root, parents and the
      // grandparents' half-cut column — 2½ readable generations.
      // Step from whatever the chart opened at, by the zoom readout.
      for (let i = 0; i < 12; i++) {
        const pct = parseInt(await page.locator(".tree-zoom-pct").first().textContent(), 10);
        if (Math.abs(Math.log(pct / 51)) < Math.log(1.25) / 2) break;
        await page.locator(pct > 51 ? ".tree-zoom-btn:has-text('−')" : ".tree-zoom-btn:has-text('+')").first().click();
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
    // The drawn wedges' union — the svg's first <g> is no longer the whole fan.
    await page.evaluate(() => {
      window.__fanBox = () => {
        const rs = [...document.querySelectorAll(".tree-canvas svg path")].map((p) => p.getBoundingClientRect()).filter((b) => b.width && b.height);
        const left = Math.min(...rs.map((b) => b.left)), top = Math.min(...rs.map((b) => b.top));
        const right = Math.max(...rs.map((b) => b.right)), bottom = Math.max(...rs.map((b) => b.bottom));
        return { left, top, width: right - left, height: bottom - top };
      };
    });
    const factor = await page.evaluate((ph) => {
      const canvas = document.querySelector(".tree-canvas");
      const r = window.__fanBox();
      const byHeight = (ph ? 0.7 : 0.9) * canvas.clientHeight / r.height;
      return ph ? byHeight : Math.min(0.94 * canvas.clientWidth / r.width, byHeight);
    }, phone);
    // Step by the zoom readout, not by an assumed step size: stop at the last
    // step that stays under the target.
    const readPct = async () => parseInt(await page.locator(".tree-zoom-pct").first().textContent(), 10);
    const target = (await readPct()) * factor;
    for (let i = 0; i < 12; i++) {
      const pct = await readPct();
      if (pct > target) {
        await page.locator(".tree-zoom-btn:has-text('−')").first().click();
        await page.waitForTimeout(120);
        if ((await readPct()) <= target) break;
        continue;
      }
      await page.locator(".tree-zoom-btn:has-text('+')").first().click();
      await page.waitForTimeout(120);
      if ((await readPct()) > target) {
        await page.locator(".tree-zoom-btn:has-text('−')").first().click();
        await page.waitForTimeout(120);
        break;
      }
    }
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      const canvas = document.querySelector(".tree-canvas");
      const r = window.__fanBox();
      const c = canvas.getBoundingClientRect();
      canvas.scrollLeft += (r.left + r.width / 2) - (c.left + c.width / 2);
      canvas.scrollTop += (r.top + r.height / 2) - (c.top + c.height / 2);
    });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${outDir}/fan-${theme}${m}.png` });

    // Merge: Europe Royal Families as main, the Tudor file as compare.
    await page.goto(base);
    await page.locator(".lp-sample-tile").nth(0).click();
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
