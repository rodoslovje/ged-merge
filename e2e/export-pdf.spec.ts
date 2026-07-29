import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(__dirname, "../src/__fixtures__/corpus/reunion-5.5.1-utf8.ged");

// No export may wrap the diagram in an SVG filter. The `.svg` download used to
// render through a white halo (feMorphology + feGaussianBlur + feComposite +
// feMerge) so it stayed legible on a dark viewer backdrop; the price was that a
// filtered group cannot stay vector, so every name in the chart was rasterized
// on the way into a PDF — measured at 275× slower, 40× larger, and with no fonts
// left in the file at all, which is a chart that dissolves the moment a reader
// zooms in. (The same filter also made Firefox's macOS "Save to PDF" output come
// out blank, which is why the print path already avoided it.)
//
// This test checks both exports: the downloaded .svg, and the HTML string handed
// to the hidden print iframe (the real OS print dialog isn't automatable).
test("chart exports carry no SVG filter, so text stays vector in the PDF", async ({ page }) => {
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
  expect(svgContent).not.toContain("feMorphology");
  expect(svgContent).not.toContain("<filter");
  // The names are still there, as text a PDF can keep as fonts.
  expect(svgContent).toContain("<text");

  await page.locator(".export-menu .tree-export-btn").click();
  await page.getByRole("menuitem", { name: "PDF (print)" }).click();

  await expect.poll(() => page.evaluate(() => (window as unknown as { __printDocs: string[] }).__printDocs.length)).toBeGreaterThan(0);
  const printDocs = await page.evaluate(() => (window as unknown as { __printDocs: string[] }).__printDocs);
  expect(printDocs).toHaveLength(1);
  expect(printDocs[0]).not.toContain("feMorphology");
  expect(printDocs[0]).not.toContain("<filter");
});
