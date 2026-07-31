// One-off capture of landing-page screenshots from the live dev server.
// Usage: node capture-shots.mjs <baseURL> <outDir>
import { chromium } from "@playwright/test";
import { mkdirSync } from "fs";

const [base = "http://localhost:5175", outDir = "shots"] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();

for (const theme of ["dark", "light"]) {
  const ctx = await browser.newContext({
    viewport: { width: 1240, height: 820 },
    deviceScaleFactor: 2,
    colorScheme: theme,
    locale: "en-US",
  });
  const page = await ctx.newPage();
  await page.addInitScript((t) => {
    localStorage.setItem("gedmerge.theme", t);
  }, theme);

  await page.goto(base);
  // Load the Tudor sample (second sample row).
  await page.locator(".lb-sample-row").nth(2).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();
  await page.locator(".charts-open-btn").click();
  await page.locator("svg.tree-svg").waitFor();
  await page.addStyleTag({ content: ".tree-zoom{display:none!important}" });

  const wrap = page.locator(".tree-canvas-wrap");
  const shot = async (name) => {
    await page.waitForTimeout(600);
    await page.keyboard.press("f");
    await page.waitForTimeout(600);
    // Clip to the drawn content (the svg's root group), padded, kept inside the canvas.
    const PAD = 20;
    const box = await wrap.boundingBox();
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
    await page.screenshot({ path: `${outDir}/${name}-${theme}.png`, clip });
  };

  await shot("tree");
  await page.getByRole("tab", { name: "Fan" }).click();
  await shot("fan");
  await page.getByRole("tab", { name: "Circle" }).click();
  await shot("circle");

  await ctx.close();
}

await browser.close();
console.log("done");
