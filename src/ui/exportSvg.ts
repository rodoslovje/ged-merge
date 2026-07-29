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
// export is painted on an opaque white sheet. Light-theme ink on a transparent
// background is a gamble on whatever the next program puts behind it — a dark
// viewer, a coloured slide, a document theme — and losing it means an invisible
// chart. White is what the paper it is headed for looks like anyway.

import { fillScale, pageBox, paperPx, type PrintPaper } from "../chart/sheets";

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
  /** Second, smaller header line under the title — the sheet export's "Sheet 3
   *  of 7 · continues Janez Novak from sheet 1". */
  subtitle?: string;
}

/** Append the shared `.gedmerge.<ext>` stem so chart exports sit alongside the
 *  `.gedmerge.*` save files; tolerates a base that already carries the extension. */
function withExportStem(base: string, ext: string): string {
  const stem = base.endsWith(`.${ext}`) ? base.slice(0, -(ext.length + 1)) : base;
  return `${stem}.gedmerge.${ext}`;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
// Band geometry/branding constants are exported: the map's PNG export draws
// the same header/footer on canvas.
export const SANS = "'IBM Plex Sans', system-ui, -apple-system, sans-serif";
export const SITE = "gedmerge.com";
const SITE_URL = "https://gedmerge.com";

// Brand badge colours, fixed so the footer logo stays on-brand regardless of the
// diagram's (theme-dependent) export colours. Mirrors public/app-icon.svg.
export const BADGE_BG = "#31715b";
export const BADGE_FG = "#ffffff";

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
export const HEADER_H = 52;
export const FOOTER_H = 34;
export const MARGIN_X = 20;
export const BADGE_SIZE = 18;
// Minimum gap between the footer's site link and timestamp.
export const FOOTER_GAP = 24;
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

/** The sheet the export is painted on. Also what makes the diagram legible in a
 *  dark-themed viewer — the job the halo filter below used to do, for nothing. */
export const PAPER_WHITE = "#ffffff";

// The exported diagram carries no SVG filter of its own — deliberately. It used
// to render through a white-halo filter, so that a transparent-background export
// stayed legible on a dark viewer backdrop. The cost was out of all proportion:
// a filtered group cannot stay vector in a PDF, so every name in the chart was
// rasterized. Measured on a 400-box diagram printed through Chromium, the halo
// turned a 31 KB, 56 ms, fully selectable PDF into a 1.3 MB, 15 s one holding
// two bitmaps and no fonts at all — text that dissolves the moment the reader
// zooms in, on exactly the wall charts people zoom into. (It also made Firefox's
// macOS "Save to PDF" come out blank.) Legibility on a dark backdrop is the
// viewer's business; sharp text is ours.

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

/** A live diagram cloned and made standalone — styles inlined, photos embedded,
 *  tooltips dropped — but not yet banded. The `.svg`/PDF exports band it whole;
 *  the sheet export picks pieces out of it (see `sheetSvg.ts`). */
export interface PreparedDiagram {
  /** The styled clone, still holding the diagram's own content. */
  clone: SVGSVGElement;
  /** Header/footer ink: the canvas text colour in the light palette. */
  foreground: string;
  /** The diagram's native size, ignoring the on-screen zoom. */
  width: number;
  height: number;
}

/**
 * Clone a live diagram SVG into a standalone one: every painted property baked
 * into inline styles (with the light palette forced, so a dark UI exports the
 * same file), photos inlined as data URIs, and the on-screen hover tooltips
 * dropped.
 */
export async function prepareDiagram(live: SVGSVGElement): Promise<PreparedDiagram> {
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

  await embedImages(clone);
  return { clone, foreground, width: diagramW, height: diagramH };
}

/**
 * Wrap a standalone diagram in the export frame: a titled header band above and
 * a site/timestamp footer below, sized so neither is squeezed by a narrow
 * diagram. `svg`'s existing children become the diagram content, shifted below
 * the header — so it takes a whole prepared clone (the `.svg`/PDF exports) or a
 * freshly assembled one (a printed sheet) alike.
 */
export function wrapWithBands(
  svg: SVGSVGElement,
  diagramW: number,
  diagramH: number,
  opts: SvgExportOptions,
  foreground: string,
): BuiltSvg {
  const clone = svg;

  // A narrow diagram must not squeeze the bands: keep the export at least wide
  // enough for the header title and the footer's badge + site link + timestamp.
  const timestamp = new Date().toLocaleString();
  const titleNeeds = Math.max(
    textWidth(opts.title, `600 18px ${SANS}`),
    opts.subtitle ? textWidth(opts.subtitle, `12px ${SANS}`) : 0,
  ) + 2 * MARGIN_X;
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

  // The sheet, first so everything else paints over it.
  const sheet = document.createElementNS(SVG_NS, "rect");
  sheet.setAttribute("x", "0");
  sheet.setAttribute("y", "0");
  sheet.setAttribute("width", String(totalW));
  sheet.setAttribute("height", String(totalH));
  sheet.setAttribute("fill", PAPER_WHITE);
  clone.appendChild(sheet);

  // Diagram, header and footer all hang off one plain group — no filter on it
  // (see the note above the band constants).
  const frame = document.createElementNS(SVG_NS, "g");
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
  // With a second line (the sheet number and where it continues from) the title
  // rides higher to make room; on its own it stays centred in the band.
  frame.appendChild(
    svgText(opts.title, totalW / 2, opts.subtitle ? HEADER_H / 2 : HEADER_H / 2 + 6, {
      "text-anchor": "middle",
      "font-family": SANS,
      "font-size": "18",
      "font-weight": "600",
      fill: foreground,
    }),
  );
  if (opts.subtitle) {
    frame.appendChild(
      svgText(opts.subtitle, totalW / 2, HEADER_H / 2 + 16, {
        "text-anchor": "middle",
        "font-family": SANS,
        "font-size": "12",
        fill: foreground,
        "fill-opacity": "0.7",
      }),
    );
  }

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

  clone.setAttribute("width", String(totalW));
  clone.setAttribute("height", String(totalH));
  clone.setAttribute("viewBox", `0 0 ${totalW} ${totalH}`);
  clone.setAttribute("xmlns", SVG_NS);
  clone.setAttribute("xmlns:xlink", XLINK_NS);

  return { svg: clone, width: totalW, height: totalH };
}

/** The whole live diagram as a standalone, banded SVG — the `.svg` download and
 *  the one-page print both start here. */
async function buildExportSvg(live: SVGSVGElement, opts: SvgExportOptions): Promise<BuiltSvg> {
  const { clone, foreground, width, height } = await prepareDiagram(live);
  return wrapWithBands(clone, width, height, opts, foreground);
}

export function serialize(svg: SVGSVGElement): string {
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
 * Build the standalone diagram SVG and print the whole of it on one sheet of
 * `paper`, scaled to fill the page — the user picks "Save as PDF".
 *
 * The page used to be sized to the diagram itself, which asked the printer for
 * a sheet metres across. A driver can't make one: it falls back to its own
 * paper, and what comes out is one page holding a fraction of the chart. So the
 * paper is the user's choice and the diagram is fitted to it, exactly as the
 * sheet print does — this is the same call with a set of one.
 */
export async function printSvg(live: SVGSVGElement, opts: SvgExportOptions, paper: PrintPaper): Promise<void> {
  const built = await buildExportSvg(live, opts);
  // Browsers seed the "Save as PDF" filename from the document <title>, so use
  // the export base name there (extension auto-appended) rather than the heading.
  const docTitle = opts.fileName ? `${opts.fileName}.gedmerge` : opts.title;
  printSheetSet(
    [built],
    paperPx(paper.paper, paper.orientation),
    fillScale([built], pageBox(paper.paper, paper.orientation)),
    docTitle,
  );
}

/**
 * Open the print dialog on a set of diagram sheets, one per page: each SVG is
 * centred on a real paper-sized page and every sheet is drawn at the same
 * `scale`, so boxes come out the same size across the whole printed set (a
 * sparse sheet blown up to fill its page would look like a different chart).
 */
export function printSheetSet(
  sheets: { svg: SVGSVGElement; width: number; height: number }[],
  page: { w: number; h: number },
  scale: number,
  docTitle: string,
): void {
  const pages = sheets
    .map(
      (s) =>
        `<div class="gm-sheet"><div class="gm-fit" style="width:${s.width * scale}px;height:${s.height * scale}px">` +
        `${serialize(s.svg)}</div></div>`,
    )
    .join("");
  printDocument(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(docTitle)}</title>
<style>
  @page { size: ${page.w}px ${page.h}px; margin: 0; }
  html, body { margin: 0; padding: 0; }
  .gm-sheet {
    width: ${page.w}px; height: ${page.h}px; box-sizing: border-box;
    display: flex; align-items: center; justify-content: center;
    break-after: page; page-break-after: always; overflow: hidden;
  }
  .gm-sheet:last-child { break-after: auto; page-break-after: auto; }
  .gm-fit svg { display: block; width: 100%; height: 100%; }
</style></head><body>${pages}</body></html>`,
  );
}

/**
 * Open the print dialog on a complete HTML document, via a hidden iframe (not
 * window.open) to dodge popup blockers. Also used by the report pages, which
 * print styled HTML instead of an SVG.
 *
 * The iframe holds the *source* the printer renders from, so it has to outlive
 * the whole dialog — and a print dialog can be a long visit: picking a PDF
 * printer and defining a custom paper size for a wall chart takes minutes, and
 * the page is only laid out for that paper once it is chosen. Tearing the iframe
 * down on a short timer produced exactly the reported symptom — a PDF holding
 * one incomplete page — so the teardown now waits for `afterprint`, with only a
 * far-away timer as a backstop for browsers that never fire it. A previous
 * document is dropped when the next print starts, so at most one lingers.
 */
let printFrame: HTMLIFrameElement | null = null;

export function printDocument(doc: string): void {
  printFrame?.remove();
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;";
  document.body.appendChild(iframe);
  printFrame = iframe;

  const cleanup = () => {
    if (printFrame === iframe) printFrame = null;
    iframe.remove();
  };
  iframe.onload = () => {
    const win = iframe.contentWindow;
    if (!win) { cleanup(); return; }
    // Give the data-URI images a frame to decode before printing.
    requestAnimationFrame(() => {
      win.focus();
      win.print();
      win.addEventListener("afterprint", cleanup);
      setTimeout(cleanup, 30 * 60_000);
    });
  };
  iframe.srcdoc = doc;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

/**
 * Find the diagram SVG inside a `.tree-canvas` element and export it, wrapped in
 * a titled header + site/timestamp footer (light palette on a white sheet).
 * No-op if the SVG is absent.
 */
export function exportCanvasSvg(canvas: HTMLElement | null, fileName: string, title: string): void {
  const svg = canvas?.querySelector("svg.tree-svg") as SVGSVGElement | null;
  if (!svg) return;
  void downloadSvg(svg, fileName, { title, fileName });
}

/**
 * Find the diagram SVG inside a `.tree-canvas` element and print the whole of it
 * on one sheet of the chosen paper. No-op if absent.
 */
export function printCanvasPdf(canvas: HTMLElement | null, opts: SvgExportOptions, paper: PrintPaper): void {
  const svg = canvas?.querySelector("svg.tree-svg") as SVGSVGElement | null;
  if (!svg) return;
  void printSvg(svg, opts, paper);
}

/**
 * The diagram's own size in a `.tree-canvas`, ignoring the on-screen zoom — what
 * the print dialog needs to say how far a chart will be scaled, without building
 * the export first. `null` when the canvas holds no diagram.
 */
export function canvasDiagramSize(canvas: HTMLElement | null): { w: number; h: number } | null {
  const svg = canvas?.querySelector("svg.tree-svg") as SVGSVGElement | null;
  const box = (svg?.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
  if (box.length !== 4 || !(box[2] > 0) || !(box[3] > 0)) return null;
  return { w: box[2], h: box[3] };
}

/**
 * Filesystem-safe slug for a diagram file name; falls back to `diagram`.
 * Accented letters are transliterated to ASCII (Č→C, Š→S, Ž→Z, Ä→A, …) so the
 * download name stays plain ASCII instead of dropping those characters.
 */
export function chartSlug(...parts: (string | undefined)[]): string {
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
