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
const SANS = "'IBM Plex Sans', system-ui, -apple-system, sans-serif";
const SITE = "gedmerge.com";

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

export async function downloadSvg(live: SVGSVGElement, fileName: string, opts: SvgExportOptions): Promise<void> {
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
  clone.appendChild(
    svgText(SITE, MARGIN_X, footTextY, {
      "font-family": SANS,
      "font-size": "12",
      "font-weight": "600",
      fill: opts.foreground,
    }),
  );
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
  clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");

  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone);
  const blob = new Blob([xml], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName.endsWith(".svg") ? fileName : `${fileName}.svg`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Find the diagram SVG inside a `.tree-canvas` element and export it, wrapping it
 * in a titled header + site/timestamp footer and painting the canvas's own
 * (resolved) colours behind it. No-op if the SVG is absent.
 */
export function exportCanvasSvg(canvas: HTMLElement | null, fileName: string, title: string): void {
  const svg = canvas?.querySelector("svg.tree-svg") as SVGSVGElement | null;
  if (!svg || !canvas) return;
  const cs = getComputedStyle(canvas);
  void downloadSvg(svg, fileName, {
    background: cs.backgroundColor || "#ffffff",
    foreground: cs.color || "#000000",
    title,
  });
}

/** Filesystem-safe slug for a diagram file name; falls back to `diagram`. */
export function diagramSlug(...parts: (string | undefined)[]): string {
  const s = parts
    .filter(Boolean)
    .join("-")
    .replace(/[\s/\\]+/g, "-")
    .replace(/[^\w.\-]+/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return s || "diagram";
}
