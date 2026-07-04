// Export a live on-screen diagram (Edit Tree / Compare Tree / Relationship
// chart) as a standalone .svg file. The diagrams are already real SVG, but they
// lean on the app's stylesheet (CSS classes + `var(--…)` tokens + `color-mix`)
// and on photos served from object URLs — none of which survive once the markup
// leaves the page. So we clone the node, bake every visual property into inline
// styles (getComputedStyle resolves tokens and color-mix to plain rgb) and embed
// the photos as data URIs.
//
// Exports are theme-independent: styles are resolved with the light palette
// temporarily forced (so the same file comes out of a dark or light UI) and the
// background stays transparent — light-theme ink reads fine on white paper and
// on the white/checker canvas of most SVG viewers.

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
  // Halo'd labels (timeline marks, tree edge labels) paint their stroke *under*
  // the fill; without this the exported halo covers the glyph ink entirely.
  "paint-order",
  "filter",
] as const;

// Colour-bearing properties whose value may be `var()`/`color-mix()`. These get
// resolved to a concrete rgb(a) for the export — external SVG renderers (Inkscape,
// Pixelmator) understand none/transparent/hex/rgb but not `var()`/`color-mix()`.
const COLOR_PROPS = new Set<string>(["fill", "stroke", "color"]);

/** A throwaway probe element plus a per-export memo, used to resolve colours. */
interface ColorCtx {
  probe: HTMLElement;
  cache: Map<string, string>;
}

/** Does a CSS value need resolving, or is it already portable as-is? */
function needsResolve(v: string): boolean {
  return v.includes("var(") || v.includes("color-mix(");
}

// Split on a top-level separator, ignoring ones nested inside parentheses
// (so `rgb(1, 2, 3)` and `color-mix(in srgb, …)` stay intact).
function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === sep && depth === 0) { out.push(s.slice(last, i)); last = i + 1; }
  }
  out.push(s.slice(last));
  return out;
}

export function parseRgba(s: string): [number, number, number, number] {
  if (/^transparent$/i.test(s.trim())) return [0, 0, 0, 0];
  const m = s.match(/-?\d*\.?\d+/g);
  if (!m || m.length < 3) return [0, 0, 0, 1];
  return [+m[0], +m[1], +m[2], m.length >= 4 ? +m[3] : 1];
}

// Split a color-mix component like `var(--x) 16%` into its colour and percentage.
function splitColorPct(seg: string): { color: string; pct: number | null } {
  let pct: number | null = null;
  const colorToks: string[] = [];
  for (const tok of splitTopLevel(seg.trim(), " ")) {
    const t = tok.trim();
    if (!t) continue;
    if (/^\d*\.?\d+%$/.test(t)) pct = parseFloat(t);
    else colorToks.push(t);
  }
  return { color: colorToks.join(" "), pct };
}

// Evaluate `color-mix(in <space>, A p1%, B p2%)` ourselves, in sRGB with
// premultiplied alpha (matching the CSS spec closely enough for export fidelity;
// every mix the app uses is `in srgb`). The components are plain colours / `var()`,
// which the browser resolves reliably even when it won't resolve the whole mix.
function mixSrgb(expr: string, ctx: ColorCtx): string {
  const inner = expr.slice(expr.indexOf("(") + 1, expr.lastIndexOf(")"));
  const colorSegs = splitTopLevel(inner, ",").map((s) => s.trim()).filter(Boolean).slice(1); // drop "in srgb"
  if (colorSegs.length < 2) return resolveColorExpr(colorSegs[0] ?? "", ctx) || expr;
  const a = splitColorPct(colorSegs[0]);
  const b = splitColorPct(colorSegs[1]);
  let p1 = a.pct;
  let p2 = b.pct;
  if (p1 == null && p2 == null) { p1 = 50; p2 = 50; }
  else if (p1 == null) p1 = 100 - (p2 as number);
  else if (p2 == null) p2 = 100 - p1;
  let w1 = p1 / 100;
  let w2 = (p2 as number) / 100;
  const sum = w1 + w2;
  if (sum <= 0) return "rgba(0, 0, 0, 0)";
  w1 /= sum; w2 /= sum;
  const c1 = parseRgba(resolveColorExpr(a.color, ctx));
  const c2 = parseRgba(resolveColorExpr(b.color, ctx));
  const al = w1 * c1[3] + w2 * c2[3];
  const ch = (i: number) => (al <= 0 ? 0 : Math.round((w1 * c1[3] * c1[i] + w2 * c2[3] * c2[i]) / al));
  const [r, g, bl] = [ch(0), ch(1), ch(2)];
  return al >= 1 ? `rgb(${r}, ${g}, ${bl})` : `rgba(${r}, ${g}, ${bl}, ${+al.toFixed(4)})`;
}

/**
 * Resolve a CSS colour expression to a concrete rgb(a). Values already portable
 * (none/transparent/hex/rgb/named) pass through untouched. `var()`/`color-mix()`
 * are first handed to the browser as a real `color` (which resolves custom
 * properties, and `color-mix` where supported); if that still comes back
 * unresolved, `color-mix()` is evaluated by hand.
 */
function resolveColorExpr(value: string, ctx: ColorCtx): string {
  const v = (value ?? "").trim();
  if (!v || !needsResolve(v)) return v;
  const cached = ctx.cache.get(v);
  if (cached !== undefined) return cached;
  ctx.probe.style.color = "";
  ctx.probe.style.color = v; // an invalid value leaves it empty
  const browser = ctx.probe.style.color ? getComputedStyle(ctx.probe).color : "";
  let out: string;
  if (browser && !needsResolve(browser)) out = browser;
  else if (v.startsWith("color-mix(")) out = mixSrgb(v, ctx);
  else out = browser || v;
  ctx.cache.set(v, out);
  return out;
}

/** Replace every `color-mix(…)` expression inside a CSS value with a resolved colour. */
function bakeColorMix(value: string, ctx: ColorCtx): string {
  if (!value.includes("color-mix(")) return value;
  let out = "";
  let i = 0;
  while (i < value.length) {
    const start = value.indexOf("color-mix(", i);
    if (start === -1) { out += value.slice(i); break; }
    out += value.slice(i, start);
    let depth = 0;
    let j = start + "color-mix".length; // points at the opening "("
    for (; j < value.length; j++) {
      if (value[j] === "(") depth++;
      else if (value[j] === ")" && --depth === 0) { j++; break; }
    }
    out += resolveColorExpr(value.slice(start, j), ctx);
    i = j;
  }
  return out;
}

function inlineComputedStyles(live: Element, clone: Element): void {
  // A probe in the live document inherits the theme's custom properties (defined
  // on :root), so `var(--…)` resolves to the colours currently on screen.
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none";
  document.body.appendChild(probe);
  const ctx: ColorCtx = { probe, cache: new Map() };
  try {
    // The clone is a deep copy of `live`, so a flat walk over both lists stays in
    // lockstep (same elements, same order, including foreignObject HTML).
    const liveEls = [live, ...live.querySelectorAll("*")];
    const cloneEls = [clone, ...clone.querySelectorAll("*")];
    for (let i = 0; i < liveEls.length; i++) {
      const liveEl = liveEls[i] as HTMLElement;
      const cs = getComputedStyle(liveEl);
      const out = cloneEls[i] as HTMLElement;
      let decl = out.getAttribute("style") ?? "";
      for (const prop of STYLE_PROPS) {
        let v: string;
        if (COLOR_PROPS.has(prop)) {
          // getComputedStyle collapses an unresolved `color-mix()` fill to black,
          // so resolve from the *authored* expression (inline style or the SVG
          // presentation attribute) instead, falling back to the computed value.
          const authored = liveEl.style?.getPropertyValue(prop) || liveEl.getAttribute(prop) || "";
          v = authored ? resolveColorExpr(authored, ctx) : bakeColorMix(cs.getPropertyValue(prop), ctx);
        } else {
          v = bakeColorMix(cs.getPropertyValue(prop), ctx);
        }
        if (!v) continue;
        decl += `${decl && !decl.endsWith(";") ? ";" : ""}${prop}:${v};`;
        // Overwrite any matching presentation attribute (e.g. the rect's
        // color-mix `fill`) so attribute-preferring renderers also get rgb.
        if (COLOR_PROPS.has(prop) && out.hasAttribute(prop)) out.setAttribute(prop, v);
      }
      out.setAttribute("style", decl);
    }
  } finally {
    probe.remove();
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
  /** Diagram title shown centred in the header band. */
  title: string;
  /** Download base name (no extension); used as the print-to-PDF default name. */
  fileName?: string;
}

/** Append the shared `.gedmerge.<ext>` stem so chart exports sit alongside the
 *  `.gedmerge.*` save files; tolerates a base that already carries the extension. */
function withExportStem(base: string, ext: string): string {
  const stem = base.endsWith(`.${ext}`) ? base.slice(0, -(ext.length + 1)) : base;
  return `${stem}.gedmerge.${ext}`;
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
const BADGE_SIZE = 18;
// Minimum gap between the footer's site link and timestamp.
const FOOTER_GAP = 24;
// Narrow diagrams (e.g. a single relationship card) still get a visible band.
const MIN_DIAGRAM_H = 80;

let measureCtx: CanvasRenderingContext2D | null = null;

/** Rendered width of `text` at the given CSS font, for sizing the export bands. */
function textWidth(text: string, font: string): number {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return text.length * 8;
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

// The export background is transparent, so hairlines and text would vanish on a
// dark backdrop. A soft white halo behind everything keeps them readable there
// while staying invisible on white. Built from core SVG 1.1 primitives (dilate +
// blur + flood) rather than feDropShadow for maximum viewer compatibility.
const HALO_ID = "gm-halo";

function svgHaloFilter(): SVGDefsElement {
  const defs = document.createElementNS(SVG_NS, "defs");
  defs.innerHTML =
    `<filter id="${HALO_ID}" x="-2%" y="-2%" width="104%" height="104%">` +
    `<feMorphology in="SourceAlpha" operator="dilate" radius="1.5" result="spread"></feMorphology>` +
    `<feGaussianBlur in="spread" stdDeviation="1" result="blurred"></feGaussianBlur>` +
    `<feFlood flood-color="#ffffff" flood-opacity="0.85"></feFlood>` +
    `<feComposite in2="blurred" operator="in" result="halo"></feComposite>` +
    `<feMerge>` +
    `<feMergeNode in="halo"></feMergeNode>` +
    `<feMergeNode in="SourceGraphic"></feMergeNode>` +
    `</feMerge>` +
    `</filter>`;
  return defs;
}

function svgText(text: string, x: number, y: number, attrs: Record<string, string>): SVGTextElement {
  const el = document.createElementNS(SVG_NS, "text");
  el.setAttribute("x", String(x));
  el.setAttribute("y", String(y));
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.textContent = text;
  return el;
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

  // Resolve every colour with the light palette forced, so the export looks the
  // same whichever scheme the UI is in. The attribute flip, the style reads and
  // the restore all happen synchronously (before any await), so the page never
  // paints a frame in the wrong theme.
  const root = document.documentElement;
  const prevTheme = root.getAttribute("data-theme");
  root.setAttribute("data-theme", "light");
  let foreground: string;
  try {
    inlineComputedStyles(live, clone);
    // Header/footer ink: the canvas text colour as the light theme resolves it.
    foreground = getComputedStyle(live).color || "#000000";
  } finally {
    if (prevTheme === null) root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", prevTheme);
  }

  // SVG <title> children surface as hover tooltips (the on-screen nodes carry a
  // "click to…" hint). In a static export they're useless and misleading, so
  // drop them. Must run after inlineComputedStyles, which walks live/clone in
  // lockstep and would desync if the clone lost nodes first.
  clone.querySelectorAll("title").forEach((el) => el.remove());

  // Export at the diagram's native size, ignoring the on-screen zoom: the live
  // SVG carries a native-sized `viewBox` (its width/height attributes are scaled
  // by the current zoom), so read dimensions from there when present.
  const viewBox = (live.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
  const diagramW = viewBox.length === 4 && viewBox[2] > 0
    ? viewBox[2]
    : parseFloat(live.getAttribute("width") ?? "") || live.clientWidth;
  const diagramH = viewBox.length === 4 && viewBox[3] > 0
    ? viewBox[3]
    : parseFloat(live.getAttribute("height") ?? "") || live.clientHeight;

  // A narrow diagram must not squeeze the bands: keep the export at least wide
  // enough for the header title and the footer's badge + site link + timestamp.
  const timestamp = new Date().toLocaleString();
  const titleNeeds = textWidth(opts.title, `600 18px ${SANS}`) + 2 * MARGIN_X;
  const footerNeeds =
    2 * MARGIN_X + BADGE_SIZE + 8 + textWidth(SITE, `600 12px ${SANS}`) +
    FOOTER_GAP + textWidth(timestamp, `12px ${SANS}`);
  const totalW = Math.ceil(Math.max(diagramW, titleNeeds, footerNeeds));
  const bandH = Math.max(diagramH, MIN_DIAGRAM_H);
  const totalH = HEADER_H + bandH + FOOTER_H;

  // Move the diagram into a group shifted below the header band (centred when
  // the bands force a larger canvas), leaving the root svg free to host the
  // header and footer.
  const content = document.createElementNS(SVG_NS, "g");
  content.setAttribute(
    "transform",
    `translate(${(totalW - diagramW) / 2},${HEADER_H + (bandH - diagramH) / 2})`,
  );
  while (clone.firstChild) content.appendChild(clone.firstChild);

  // Everything renders through the white-halo filter so the export stays
  // legible on dark backdrops despite the transparent background.
  const frame = document.createElementNS(SVG_NS, "g");
  frame.setAttribute("filter", `url(#${HALO_ID})`);
  clone.appendChild(svgHaloFilter());
  clone.appendChild(frame);
  frame.appendChild(content);

  // Header: hairline divider + centred title.
  const headLine = document.createElementNS(SVG_NS, "line");
  headLine.setAttribute("x1", "0");
  headLine.setAttribute("y1", String(HEADER_H));
  headLine.setAttribute("x2", String(totalW));
  headLine.setAttribute("y2", String(HEADER_H));
  headLine.setAttribute("stroke", foreground);
  headLine.setAttribute("stroke-opacity", "0.15");
  frame.appendChild(headLine);
  frame.appendChild(
    svgText(opts.title, totalW / 2, HEADER_H / 2 + 6, {
      "text-anchor": "middle",
      "font-family": SANS,
      "font-size": "18",
      "font-weight": "600",
      fill: foreground,
    }),
  );

  // Footer: hairline divider, site on the left, timestamp on the right.
  const footY = HEADER_H + bandH;
  const footLine = headLine.cloneNode() as SVGLineElement;
  footLine.setAttribute("y1", String(footY));
  footLine.setAttribute("y2", String(footY));
  frame.appendChild(footLine);
  const footTextY = footY + FOOTER_H / 2 + 4;
  // Small green brand badge, vertically centred in the footer band, with the
  // site name as a clickable link beside it (works in browsers and print-to-PDF).
  const link = document.createElementNS(SVG_NS, "a");
  link.setAttributeNS(XLINK_NS, "xlink:href", SITE_URL);
  link.setAttribute("href", SITE_URL);
  link.setAttribute("target", "_blank");
  link.appendChild(svgLogoBadge(MARGIN_X, footY + (FOOTER_H - BADGE_SIZE) / 2, BADGE_SIZE));
  link.appendChild(
    svgText(SITE, MARGIN_X + BADGE_SIZE + 8, footTextY, {
      "font-family": SANS,
      "font-size": "12",
      "font-weight": "600",
      fill: foreground,
      "text-decoration": "underline",
    }),
  );
  frame.appendChild(link);
  frame.appendChild(
    svgText(timestamp, totalW - MARGIN_X, footTextY, {
      "text-anchor": "end",
      "font-family": SANS,
      "font-size": "12",
      fill: foreground,
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
  a.download = withExportStem(fileName, "svg");
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

  // Browsers seed the "Save as PDF" filename from the document <title>, so use
  // the export base name there (extension auto-appended) rather than the heading.
  const docTitle = opts.fileName ? `${opts.fileName}.gedmerge` : opts.title;
  const doc = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(docTitle)}</title>
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
 * Find the diagram SVG inside a `.tree-canvas` element and export it, wrapped in
 * a titled header + site/timestamp footer (light palette, transparent
 * background). No-op if the SVG is absent.
 */
export function exportCanvasSvg(canvas: HTMLElement | null, fileName: string, title: string): void {
  const svg = canvas?.querySelector("svg.tree-svg") as SVGSVGElement | null;
  if (!svg) return;
  void downloadSvg(svg, fileName, { title, fileName });
}

/**
 * Find the diagram SVG inside a `.tree-canvas` element and open it in the print
 * dialog (whole diagram on one page) for "Save as PDF". No-op if absent.
 */
export function exportCanvasPdf(canvas: HTMLElement | null, fileName: string, title: string): void {
  const svg = canvas?.querySelector("svg.tree-svg") as SVGSVGElement | null;
  if (!svg) return;
  void printSvg(svg, { title, fileName });
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
