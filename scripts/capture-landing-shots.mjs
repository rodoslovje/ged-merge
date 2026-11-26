// Capture of the landing-page screenshot strip from the live dev server.
// Six shots per theme: Edit view + Tree + Fan from the Tudor sample (the fan
// rooted on Margaret Tudor: ancestors, descendants and siblings at once), the
// Merge view matching Europe Royal Families against the Tudor file, the Map
// from scripts/capture-map-fixture.ged (a family moving across Austria-Hungary,
// coordinates embedded) with life paths on the self-hosted Spezialkarte overlay
// (needs network access to tiles.gedmerge.com and the CARTO tile CDN), and the
// front page of the family website Tools makes from the Tudor sample.
// The strip serves them 1600 px on the long side, the map as JPEG:
//   magick shot.png -resize 1600x1600 -strip public/landing/<name>.png|.jpg
// Usage: node scripts/capture-landing-shots.mjs <baseURL> <outDir> [only]
// `only` = "fan" stops each pass after the Edit, Tree and Fan shots.
import { chromium } from "@playwright/test";
import { mkdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(__dirname, "capture-map-fixture.ged");
const TUDOR = path.resolve(__dirname, "../public/samples/EnglishTudorRoyalFamily.ged");

const [base = "http://localhost:5173", outDir = "shots", only = ""] =process.argv.slice(2);
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
    // The fan's Siblings switch, on from the start.
    localStorage.setItem("gedmerge.chartSettings", JSON.stringify({ fanSiblings: true }));
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

/** The zoom readout is a field: read it, or type the zoom wanted into it. */
async function readZoom(page) {
  return parseInt(await page.locator(".tree-zoom-pct").first().inputValue(), 10);
}

async function setZoom(page, pct) {
  const field = page.locator(".tree-zoom-pct").first();
  await field.fill(String(pct));
  await field.press("Enter");
  await page.waitForTimeout(300);
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
      await setZoom(page, 51);
      await page.evaluate(() => { document.querySelector(".tree-canvas").scrollLeft = 0; });
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${outDir}/tree-${theme}${m}.png` });
    } else {
      await chartShot(page, `${outDir}/tree-${theme}${m}.png`);
    }
    await pickKind(page, phone, "Fan");
    // Back to Both (no key for it; a phone keeps the tabs in the ☰ menu) and
    // re-rooted on Henry's daughter Margaret: her ancestors above, her
    // descendants below, her brothers and sister beside.
    if (phone) await page.locator(".chart-menu-btn").click();
    await page.getByRole("tab", { name: /^Both/ }).click();
    if (phone) await page.locator(".chart-menu-btn").click();
    await page.locator("g.fan-node:not(.fan-spouse)").filter({ hasText: /^Margaret ?Tudor/ }).first().click();
    await page.getByRole("button", { name: "Root", exact: true }).click();
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
    await setZoom(page, Math.floor((await readZoom(page)) * factor));
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
    if (only === "fan") { await ctx.close(); continue; }

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

  // Family website: the Tudor sample published from Tools, then the page it
  // downloads opened from disk the way a relative would — its front page.
  {
    const { ctx, page } = await makePage(theme, false, phone);
    // The page is the same whatever window built it, so build it in a desktop
    // one (the Tools tabs) and give the phone its own size back for the shot.
    const size = page.viewportSize();
    await page.setViewportSize({ width: 1240, height: 820 });
    await page.goto(base);
    await page.locator(".lp-sample-tile").nth(1).click();
    await page.locator(".landing-b").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Tools", exact: true }).click();
    await page.locator(".tools-tab", { hasText: "Family website" }).click();
    await page.locator(".tools-publish-field input").first().fill("The Tudors");
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download website (.html)" }).click();
    const site = path.join(tmpdir(), "landing-shot-website.html");
    await (await download).saveAs(site);
    await page.setViewportSize(size);
    await page.goto(pathToFileURL(site).href);
    await page.locator(".site-hero h1").waitFor();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${outDir}/website-${theme}${m}.png` });
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
