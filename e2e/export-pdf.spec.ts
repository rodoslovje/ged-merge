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
  // …on an opaque white sheet, so light-theme ink can't land on a dark backdrop.
  expect(svgContent).toMatch(/<rect x="0" y="0" width="\d+" height="\d+" fill="#ffffff"/);

  await page.locator(".export-menu .tree-export-btn").click();
  await page.getByRole("menuitem", { name: "PDF (print)" }).click();
  // Printing always asks for the paper first — a page sized to the diagram is a
  // page no printer can make.
  await page.locator(".sheet-dialog").waitFor();
  await page.locator(".sheet-dialog .confirm-dialog-confirm").click();

  await expect.poll(() => page.evaluate(() => (window as unknown as { __printDocs: string[] }).__printDocs.length)).toBeGreaterThan(0);
  const printDocs = await page.evaluate(() => (window as unknown as { __printDocs: string[] }).__printDocs);
  expect(printDocs).toHaveLength(1);
  expect(printDocs[0]).not.toContain("feMorphology");
  expect(printDocs[0]).not.toContain("<filter");
  // A4 landscape, the dialog's default — real paper, not the diagram's extent.
  expect(printDocs[0]).toContain("size: 1123px 794px");
});

// A radial chart has no rectangular branches to cut, so it never had a paper
// choice at all: its PDF asked for a page the size of the fan. It now goes
// through the same dialog, minus the print-size row, and prints whole on the
// paper chosen.
test("a chart that can't be split still prints on real paper", async ({ page }) => {
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

  await page.locator(".charts-kind").getByRole("tab", { name: "Fan" }).click();
  await page.locator("svg.tree-svg").waitFor();

  await page.locator(".export-menu .tree-export-btn").click();
  await page.getByRole("menuitem", { name: "PDF (print)" }).click();
  const dialog = page.locator(".sheet-dialog");
  await dialog.waitFor();
  // Nothing to cut, so nothing is asked about cutting.
  await expect(dialog.getByText("Print size")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "One sheet", exact: true })).toHaveCount(0);
  // Pick A2 portrait, to prove the choice reaches the page.
  await dialog.getByRole("button", { name: "A2", exact: true }).click();
  await dialog.getByRole("button", { name: "Portrait", exact: true }).click();
  await dialog.locator(".confirm-dialog-confirm").click();

  await expect.poll(() => page.evaluate(() => (window as unknown as { __printDocs: string[] }).__printDocs.length)).toBeGreaterThan(0);
  const printDocs = await page.evaluate(() => (window as unknown as { __printDocs: string[] }).__printDocs);
  expect(printDocs[0]).toContain("size: 1587px 2245px"); // A2 portrait, 420 × 594 mm
  expect(printDocs[0]).not.toContain("<filter");
});
