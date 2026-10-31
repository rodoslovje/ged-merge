import {
  downloadBuiltPng,
  downloadBuiltSvg,
  parseRgba,
  withLightPalette,
  wrapWithBands,
  type SvgExportOptions,
} from "../exportSvg";

/**
 * Statistics draws its charts in HTML — bars are boxes, labels are text — so
 * the SVG exports of the other charts cannot clone them. This paints what the
 * page shows instead: every box with a background or a border becomes a
 * rectangle, every line of text a <text> at the place the layout put it, read
 * with the light palette in force, so a card or the whole page exports as it
 * looks on paper. It knows only what the statistics are made of (no images,
 * gradients or transforms), which keeps it short.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

const visible = (color: string) => parseRgba(color)[3] > 0;

/** Paint `root` and what it holds, leaving out the elements `skip` names. */
function paint(root: HTMLElement, skip: (node: Element) => boolean): { svg: SVGSVGElement; width: number; height: number } {
  const origin = root.getBoundingClientRect();
  const width = Math.ceil(origin.width);
  const height = Math.ceil(origin.height);
  const svg = el("svg", { xmlns: SVG_NS, width, height, viewBox: `0 0 ${width} ${height}` });
  const defs = el("defs", {});
  svg.appendChild(defs);
  let clips = 0;
  const x = (v: number) => Math.round((v - origin.left) * 10) / 10;
  const y = (v: number) => Math.round((v - origin.top) * 10) / 10;

  const text = (node: Text, cs: CSSStyleDeclaration, into: SVGElement) => {
    const value = node.data;
    if (!value.trim()) return;
    // Word by word, so a wrapped line comes out as the lines it was laid out in.
    const range = document.createRange();
    const lines: { left: number; top: number; bottom: number; from: number; to: number }[] = [];
    for (const m of value.matchAll(/\S+/g)) {
      range.setStart(node, m.index!);
      range.setEnd(node, m.index! + m[0].length);
      const r = range.getBoundingClientRect();
      if (!r.width) continue;
      const line = lines[lines.length - 1];
      if (line && Math.abs(line.top - r.top) < 2) line.to = m.index! + m[0].length;
      else lines.push({ left: r.left, top: r.top, bottom: r.bottom, from: m.index!, to: m.index! + m[0].length });
    }
    const size = parseFloat(cs.fontSize);
    for (const line of lines) {
      const t = el("text", {
        x: x(line.left),
        // The baseline sits about a quarter of the line box above its bottom.
        y: y(line.bottom - (line.bottom - line.top - size) / 2 - size * 0.22),
        "font-size": cs.fontSize,
        "font-family": cs.fontFamily,
        "font-weight": cs.fontWeight,
        fill: cs.color,
      });
      t.textContent = value.slice(line.from, line.to);
      into.appendChild(t);
    }
  };

  const visit = (node: Element, into: SVGElement) => {
    if (skip(node) || node instanceof SVGElement) return;
    const cs = getComputedStyle(node);
    if (cs.display === "none" || cs.visibility === "hidden") return;
    const r = node.getBoundingClientRect();
    const box = { x: x(r.left), y: y(r.top), width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10 };
    const radius = parseFloat(cs.borderTopLeftRadius) || 0;
    if (r.width && r.height && visible(cs.backgroundColor)) {
      into.appendChild(el("rect", { ...box, rx: radius, fill: cs.backgroundColor }));
    }
    // A legend's swatch is a ::before box at the start of its label.
    const before = getComputedStyle(node, "::before");
    if (before.content !== "none" && before.display !== "none" && visible(before.backgroundColor)) {
      const w = parseFloat(before.width) || 0;
      const h = parseFloat(before.height) || 0;
      into.appendChild(el("rect", {
        x: box.x, y: Math.round((box.y + (box.height - h) / 2) * 10) / 10, width: w, height: h,
        rx: parseFloat(before.borderTopLeftRadius) || 0, fill: before.backgroundColor,
      }));
    }
    // A tile's sex stripe is an inset shadow along its left edge.
    const stripe = /(rgba?\([^)]*\))\s+(\d+(?:\.\d+)?)px\s+0px\s+0px\s+0px\s+inset/.exec(cs.boxShadow);
    if (stripe && visible(stripe[1])) {
      // Cut to the tile's own rounded outline, as the page draws it.
      const id = `c${clips++}`;
      const clip = el("clipPath", { id });
      clip.appendChild(el("rect", { ...box, rx: radius }));
      defs.appendChild(clip);
      const g = el("g", { "clip-path": `url(#${id})` });
      g.appendChild(el("rect", { x: box.x, y: box.y, width: parseFloat(stripe[2]), height: box.height, fill: stripe[1] }));
      into.appendChild(g);
    }
    const border = parseFloat(cs.borderTopWidth);
    if (border > 0 && cs.borderTopStyle !== "none" && visible(cs.borderTopColor)) {
      into.appendChild(el("rect", {
        x: box.x + border / 2, y: box.y + border / 2, width: box.width - border, height: box.height - border,
        rx: radius, fill: "none", stroke: cs.borderTopColor, "stroke-width": border,
      }));
    }
    // What the page cuts off (a label's ellipsis, a bar's rounded track), the
    // export cuts off too.
    let children: SVGElement = into;
    if (cs.overflowX !== "visible" || cs.overflowY !== "visible") {
      const id = `c${clips++}`;
      const clip = el("clipPath", { id });
      clip.appendChild(el("rect", { ...box, rx: radius }));
      defs.appendChild(clip);
      children = el("g", { "clip-path": `url(#${id})` });
      into.appendChild(children);
    }
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) text(child as Text, cs, children);
      else if (child.nodeType === Node.ELEMENT_NODE) visit(child as Element, children);
    }
  };

  visit(root, svg);
  return { svg, width, height };
}

/** What the export leaves out: the card's own buttons and the lists of people. */
const SKIP = (node: Element) =>
  node.matches(".stats-card-tools, .stats-pick, .stats-relate, button.stats-info, .export-menu");

/** The margin around the drawing, inside the title and footer bands. */
const PAD_X = 24;
const PAD_Y = 16;

/** Draw `root` as a standalone, banded SVG and download it as SVG or PNG. */
export async function exportStats(root: HTMLElement, format: "svg" | "png", fileName: string, opts: SvgExportOptions): Promise<void> {
  const painted = withLightPalette(() => ({
    ...paint(root, SKIP),
    foreground: getComputedStyle(document.body).color,
  }));
  // The cards would otherwise touch the image's edges.
  const width = painted.width + 2 * PAD_X;
  const height = painted.height + 2 * PAD_Y;
  const svg = el("svg", { xmlns: SVG_NS, width, height, viewBox: `0 0 ${width} ${height}` });
  const inner = el("g", { transform: `translate(${PAD_X} ${PAD_Y})` });
  for (const child of [...painted.svg.childNodes]) inner.appendChild(child);
  svg.appendChild(inner);
  const built = wrapWithBands(svg, width, height, opts, painted.foreground);
  if (format === "svg") downloadBuiltSvg(built, fileName);
  else await downloadBuiltPng(built, fileName);
}
