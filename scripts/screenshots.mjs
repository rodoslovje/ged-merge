// Regenerates the README screenshots in docs/screenshots/.
//
//   npm run dev            # in another terminal (or pass --url)
//   node scripts/screenshots.mjs
//
// Deliberately a script and not an e2e spec: it is run by hand when the UI
// changes enough that the README looks dated, and a failure here must never
// fail CI. The sample trees under public/samples are used as the data, so no
// real family's names end up in a committed image.
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "docs", "screenshots");
const url = process.argv.includes("--url") ? process.argv[process.argv.indexOf("--url") + 1] : "http://localhost:5173/";

const MAIN = path.join(root, "public", "samples", "EnglishTudorRoyalFamily.ged");
const COMPARE = path.join(root, "public", "samples", "EuropeRoyalFamilies.ged");

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch();
// 1440 wide at 1× : still well over the width GitHub renders a README image at,
// and a third of the bytes a 2× capture would add to the repository.
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const shot = async (name) => {
  await page.waitForTimeout(600); // let fonts settle and any layout animation finish
  await page.screenshot({ path: path.join(outDir, `${name}.png`) });
  console.log(`docs/screenshots/${name}.png`);
};

await page.goto(url);
await page.locator("input.file-input").first().setInputFiles(MAIN);
await page.locator(".edit-person").waitFor({ timeout: 30_000 });
await shot("edit");

// Merge: the compare slot only exists in Merge mode; a second file there
// produces the scored candidate list.
await page.getByRole("button", { name: "Merge", exact: true }).click();
await page.locator("input.file-input").last().setInputFiles(COMPARE);
await page.locator(".candidate").first().waitFor({ timeout: 60_000 });
await page.locator(".candidate").first().click();
await shot("merge");

// A chart: the fan, which fits a whole ancestry into one frame rather than
// panning off the side of the viewport the way the layered tree does.
await page.getByRole("button", { name: "Edit", exact: true }).click();
await page.locator(".edit-person").waitFor();
await page.locator(".charts-open-btn").click();
await page.locator("svg.tree-svg").waitFor({ timeout: 30_000 });
await page.locator(".charts-kind button", { hasText: /^Fan$/ }).click();
await page.waitForTimeout(1200);
await shot("chart");

await browser.close();
