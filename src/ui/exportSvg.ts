// Export a live on-screen diagram (Edit Tree / Compare Tree / Relationship
// chart) as a standalone .svg file. The diagrams are already real SVG, but they
// lean on the app's stylesheet (CSS classes + `var(--…)` tokens + `color-mix`)
// and on photos served from object URLs — none of which survive once the markup
// leaves the page. So we clone the node, bake every visual property into inline
// styles (getComputedStyle resolves tokens and color-mix to plain rgb), embed
// the photos as data URIs, and paint the canvas background behind it.

// The presentation properties worth baking in. Deliberately omits `transform`
// (kept as the element's attribute — a CSS matrix would fight it) and layout
// props, so we copy only what paints.
const STYLE_PROPS = [
  "fill",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "opacity",
  "color",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "text-anchor",
  "dominant-baseline",
  "letter-spacing",
  "filter",
] as const;

function inlineComputedStyles(live: Element, clone: Element): void {
  // The clone is a deep copy of `live`, so a flat walk over both lists stays in
  // lockstep (same elements, same order, including foreignObject HTML).
  const liveEls = [live, ...live.querySelectorAll("*")];
  const cloneEls = [clone, ...clone.querySelectorAll("*")];
  for (let i = 0; i < liveEls.length; i++) {
    const cs = getComputedStyle(liveEls[i]);
    const out = cloneEls[i] as HTMLElement;
    let decl = out.getAttribute("style") ?? "";
    for (const prop of STYLE_PROPS) {
      const v = cs.getPropertyValue(prop);
      if (v) decl += `${decl && !decl.endsWith(";") ? ";" : ""}${prop}:${v};`;
    }
    out.setAttribute("style", decl);
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

// Node photos render as <img> inside <foreignObject> with an object-URL src,
// which is meaningless outside this page session — inline each as a data URI.
async function embedImages(clone: SVGSVGElement): Promise<void> {
  const imgs = Array.from(clone.querySelectorAll("img"));
  const cache = new Map<string, string>();
  await Promise.all(
    imgs.map(async (img) => {
      const src = img.getAttribute("src");
      if (!src || src.startsWith("data:")) return;
      let data = cache.get(src);
      if (data === undefined) {
        try {
          const blob = await (await fetch(src)).blob();
          data = await blobToDataUrl(blob);
        } catch {
          data = ""; // unresolvable — drop the broken reference
        }
        cache.set(src, data);
      }
      if (data) img.setAttribute("src", data);
      else img.remove();
    }),
  );
}

/**
 * Serialize a live diagram SVG to a standalone file and trigger its download.
 * @param live the on-screen `<svg>` element
 * @param fileName download name (`.svg` appended if missing)
 * @param opts colours plus the header title / footer text band
 */
export interface SvgExportOptions {
  /** Canvas colour painted behind everything (resolved, e.g. rgb). */
  background: string;
  /** Title / footer text colour (resolved). */
  foreground: string;
  /** Diagram title shown centred in the header band. */
  title: string;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const SANS = "'IBM Plex Sans', system-ui, -apple-system, sans-serif";
const SITE = "gedmerge.com";
const SITE_URL = "https://gedmerge.com";

// Brand badge colours, fixed so the footer logo stays on-brand regardless of the
// diagram's (theme-dependent) export colours. Mirrors public/app-icon.svg.
const BADGE_BG = "#31715b";
const BADGE_FG = "#ffffff";

/**
 * The GED Merge badge: a green rounded square with the white Node-M mark inside,
 * scaled from the canonical 100×100 app-icon into a `size`-px box at (x, y).
 */
function svgLogoBadge(x: number, y: number, size: number): SVGGElement {
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("transform", `translate(${x},${y}) scale(${size / 100})`);
  g.innerHTML =
    `<rect width="100" height="100" rx="23" fill="${BADGE_BG}"></rect>` +
    `<g transform="translate(50 50) scale(2.3) translate(-20 -21)" fill="none" stroke="${BADGE_FG}" ` +
    `stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">` +
    `<line x1="9" y1="31" x2="9" y2="11"></line>` +
    `<line x1="9" y1="11" x2="20" y2="23.5"></line>` +
    `<line x1="31" y1="11" x2="20" y2="23.5"></line>` +
    `<line x1="31" y1="31" x2="31" y2="11"></line>` +
    `<circle cx="9" cy="11" r="3.3"></circle>` +
    `<circle cx="31" cy="11" r="3.3"></circle>` +
    `<circle cx="20" cy="23.5" r="3.3" fill="${BADGE_FG}" stroke="none"></circle>` +
    `</g>`;
  return g;
}

// Header / footer band geometry and side margin.
const HEADER_H = 52;
const FOOTER_H = 34;
const MARGIN_X = 20;

function svgText(text: string, x: number, y: number, attrs: Record<string, string>): SVGTextElement {
  const el = document.createElementNS(SVG_NS, "text");
  el.setAttribute("x", String(x));
  el.setAttribute("y", String(y));
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.textContent = text;
  return el;
}

function svgRect(x: number, y: number, w: number, h: number, fill: string): SVGRectElement {
  const r = document.createElementNS(SVG_NS, "rect");
  r.setAttribute("x", String(x));
  r.setAttribute("y", String(y));
  r.setAttribute("width", String(w));
  r.setAttribute("height", String(h));
  r.setAttribute("fill", fill);
  return r;
}

interface BuiltSvg {
  svg: SVGSVGElement;
  width: number;
  height: number;
}

/**
 * Clone a live diagram SVG into a standalone document: styles inlined, photos
 * embedded, wrapped in a titled header + site/timestamp footer. Shared by the
 * `.svg` download and the print-to-PDF path.
 */
async function buildExportSvg(live: SVGSVGElement, opts: SvgExportOptions): Promise<BuiltSvg> {
  const clone = live.cloneNode(true) as SVGSVGElement;
  inlineComputedStyles(live, clone);

  const diagramW = parseFloat(live.getAttribute("width") ?? "") || live.clientWidth;
  const diagramH = parseFloat(live.getAttribute("height") ?? "") || live.clientHeight;
  const totalW = diagramW;
  const totalH = HEADER_H + diagramH + FOOTER_H;

  // Move the diagram into a group shifted below the header band, leaving the
  // root svg free to host the background, header and footer.
  const content = document.createElementNS(SVG_NS, "g");
  content.setAttribute("transform", `translate(0,${HEADER_H})`);
  while (clone.firstChild) content.appendChild(clone.firstChild);

  // Bottom-most: the canvas background, so the export isn't transparent (text /
  // edges are tuned for the panel colour behind them).
  clone.appendChild(svgRect(0, 0, totalW, totalH, opts.background));
  clone.appendChild(content);

  // Header: hairline divider + centred title.
  const headLine = document.createElementNS(SVG_NS, "line");
  headLine.setAttribute("x1", "0");
  headLine.setAttribute("y1", String(HEADER_H));
  headLine.setAttribute("x2", String(totalW));
  headLine.setAttribute("y2", String(HEADER_H));
  headLine.setAttribute("stroke", opts.foreground);
  headLine.setAttribute("stroke-opacity", "0.15");
  clone.appendChild(headLine);
  clone.appendChild(
    svgText(opts.title, totalW / 2, HEADER_H / 2 + 6, {
      "text-anchor": "middle",
      "font-family": SANS,
      "font-size": "18",
      "font-weight": "600",
      fill: opts.foreground,
    }),
  );

  // Footer: hairline divider, site on the left, timestamp on the right.
  const footY = HEADER_H + diagramH;
  const footLine = headLine.cloneNode() as SVGLineElement;
  footLine.setAttribute("y1", String(footY));
  footLine.setAttribute("y2", String(footY));
  clone.appendChild(footLine);
  const footTextY = footY + FOOTER_H / 2 + 4;
  // Small green brand badge, vertically centred in the footer band, with the
  // site name as a clickable link beside it (works in browsers and print-to-PDF).
  const badgeSize = 18;
  const link = document.createElementNS(SVG_NS, "a");
  link.setAttributeNS(XLINK_NS, "xlink:href", SITE_URL);
  link.setAttribute("href", SITE_URL);
  link.setAttribute("target", "_blank");
  link.appendChild(svgLogoBadge(MARGIN_X, footY + (FOOTER_H - badgeSize) / 2, badgeSize));
  link.appendChild(
    svgText(SITE, MARGIN_X + badgeSize + 8, footTextY, {
      "font-family": SANS,
      "font-size": "12",
      "font-weight": "600",
      fill: opts.foreground,
      "text-decoration": "underline",
    }),
  );
  clone.appendChild(link);
  clone.appendChild(
    svgText(new Date().toLocaleString(), totalW - MARGIN_X, footTextY, {
      "text-anchor": "end",
      "font-family": SANS,
      "font-size": "12",
      fill: opts.foreground,
      "fill-opacity": "0.7",
    }),
  );

  await embedImages(clone);

  clone.setAttribute("width", String(totalW));
  clone.setAttribute("height", String(totalH));
  clone.setAttribute("viewBox", `0 0 ${totalW} ${totalH}`);
  clone.setAttribute("xmlns", SVG_NS);
  clone.setAttribute("xmlns:xlink", XLINK_NS);

  return { svg: clone, width: totalW, height: totalH };
}

function serialize(svg: SVGSVGElement): string {
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(svg);
}

/** Build a standalone diagram SVG and trigger its download as a `.svg` file. */
export async function downloadSvg(live: SVGSVGElement, fileName: string, opts: SvgExportOptions): Promise<void> {
  const { svg } = await buildExportSvg(live, opts);
  const blob = new Blob([serialize(svg)], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName.endsWith(".svg") ? fileName : `${fileName}.svg`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Build the standalone diagram SVG and open it in the browser's print dialog,
 * sized so the whole diagram lands on one page — the user picks "Save as PDF".
 * Uses a hidden iframe (not window.open) to dodge popup blockers.
 */
export async function printSvg(live: SVGSVGElement, opts: SvgExportOptions): Promise<void> {
  const { svg, width, height } = await buildExportSvg(live, opts);
  // Make the SVG fill the print page; the @page size matches its pixel extent.
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  svg.setAttribute("style", "display:block;width:100%;height:100%;");

  const doc = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(opts.title)}</title>
<style>
  @page { size: ${width}px ${height}px; margin: 0; }
  html, body { margin: 0; padding: 0; }
  svg { display: block; }
</style></head><body>${serialize(svg)}</body></html>`;

  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;";
  document.body.appendChild(iframe);

  const cleanup = () => iframe.remove();
  iframe.onload = () => {
    const win = iframe.contentWindow;
    if (!win) { cleanup(); return; }
    // Give the data-URI images a frame to decode before printing.
    requestAnimationFrame(() => {
      win.focus();
      win.print();
      // Tear down after the dialog returns; afterprint isn't reliable everywhere.
      win.addEventListener("afterprint", cleanup);
      setTimeout(cleanup, 60000);
    });
  };
  iframe.srcdoc = doc;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

/**
 * Find the diagram SVG inside a `.tree-canvas` element and export it, wrapping it
 * in a titled header + site/timestamp footer and painting the canvas's own
 * (resolved) colours behind it. No-op if the SVG is absent.
 */
export function exportCanvasSvg(canvas: HTMLElement | null, fileName: string, title: string): void {
  const svg = canvas?.querySelector("svg.tree-svg") as SVGSVGElement | null;
  if (!svg || !canvas) return;
  void downloadSvg(svg, fileName, canvasExportOptions(canvas, title));
}

/**
 * Find the diagram SVG inside a `.tree-canvas` element and open it in the print
 * dialog (whole diagram on one page) for "Save as PDF". No-op if absent.
 */
export function exportCanvasPdf(canvas: HTMLElement | null, title: string): void {
  const svg = canvas?.querySelector("svg.tree-svg") as SVGSVGElement | null;
  if (!svg || !canvas) return;
  void printSvg(svg, canvasExportOptions(canvas, title));
}

function canvasExportOptions(canvas: HTMLElement, title: string): SvgExportOptions {
  const cs = getComputedStyle(canvas);
  return {
    background: cs.backgroundColor || "#ffffff",
    foreground: cs.color || "#000000",
    title,
  };
}

/**
 * Filesystem-safe slug for a diagram file name; falls back to `diagram`.
 * Accented letters are transliterated to ASCII (Č→C, Š→S, Ž→Z, Ä→A, …) so the
 * download name stays plain ASCII instead of dropping those characters.
 */
export function diagramSlug(...parts: (string | undefined)[]): string {
  const s = parts
    .filter(Boolean)
    .join("-")
    // Decompose accents (é → e +  ́) then drop the combining marks; map the few
    // stroked letters NFD can't split (đ, ł).
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d")
    .replace(/[łŁ]/g, "l")
    .replace(/[\s/\\]+/g, "-")
    .replace(/[^\w.\-]+/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return s || "diagram";
}
