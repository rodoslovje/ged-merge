import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(__dirname, "../test-data/Senen.ged");

// The chart print/PDF path (ChartExportMenu → exportCanvasPdf → printSvg)
// wraps the diagram in a white "halo" SVG filter (feMorphology + feGaussianBlur
// + feComposite + feMerge) — needed only so the standalone .svg download stays
// legible if opened on a dark background. Confirmed by hand: that exact filter
// combination makes Firefox's macOS "Save to PDF" pipeline rasterize the page
// as fully blank, even though it renders fine on-screen and in Firefox's own
// print preview. printSvg must never re-include it. This test intercepts the
// HTML string handed to the hidden print iframe (rather than driving the real
// OS print dialog, which isn't automatable) and checks for the filter's
// fingerprint; a companion assertion confirms the .svg download still keeps it,
// so a fix here can't just delete the halo outright.
test("chart PDF export omits the halo filter that blanks Firefox print output; SVG export keeps it", async ({ page }) => {
  // Capture every `iframe.srcdoc` write before the app can act on it (print()
  // is synchronous-ish and Chromium may tear the iframe down again quickly).
  await page.addInitScript(() => {
    (window as unknown as { __printDocs: string[] }).__printDocs = [];
    const proto = HTMLIFrameElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "srcdoc")!;
    Object.defineProperty(proto, "srcdoc", {
      configurable: true,
      get() {
        return desc.get!.call(this);
      },
      set(v: string) {
        (window as unknown as { __printDocs: string[] }).__printDocs.push(v);
        desc.set!.call(this, v);
      },
    });
  });

  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(SAMPLE);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  await page.locator(".charts-open-btn").click();
  await page.locator("svg.tree-svg").waitFor();

  await page.locator(".export-menu .tree-export-btn").click();

  const svgDownloadPromise = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "SVG image" }).click();
  const svgDownload = await svgDownloadPromise;
  const svgPath = await svgDownload.path();
  const svgContent = readFileSync(svgPath!, "utf-8");
  expect(svgContent).toContain("feMorphology");

  await page.locator(".export-menu .tree-export-btn").click();
  await page.getByRole("menuitem", { name: "PDF (print)" }).click();

  await expect.poll(() => page.evaluate(() => (window as unknown as { __printDocs: string[] }).__printDocs.length)).toBeGreaterThan(0);
  const printDocs = await page.evaluate(() => (window as unknown as { __printDocs: string[] }).__printDocs);
  expect(printDocs).toHaveLength(1);
  expect(printDocs[0]).not.toContain("feMorphology");
  expect(printDocs[0]).not.toContain("gm-halo");
});
