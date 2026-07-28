// Print a layered chart across several sheets of paper.
//
// The planning — where to cut the tree so each piece fits a page — is pure and
// lives in `src/chart/sheets.ts`. This is the rendering half: each planned sheet
// is laid out with the very same `layout`/`flatten` the on-screen chart uses,
// and then *drawn from the chart already on screen*. Rather than re-render the
// boxes (which would mean re-running React with every host page's colour,
// badge, photo and kinship callbacks), the export clones each rendered node
// group out of the live SVG — styles already baked in by `prepareDiagram` — and
// simply moves it to its position on the sheet. Connectors are rebuilt from the
// sheet's own `flatten`, styled from a template edge taken out of the same
// clone.
//
// A branch that continues on a later sheet is left as a numbered marker beside
// the person it was cut from; that sheet's header names the person and the sheet
// it came from, so the set reads as one chart.

import {
  PAD,
  NODE_W,
  flatten,
  layout,
  layoutGrid,
  type ChartAlignment,
  type Flat,
} from "../chart/treeLayout";
import type { TreeNode } from "../chart/personTree";
import {
  pageBox,
  paperPx,
  sheetBudget,
  splitIntoSheets,
  type Orientation,
  type PaperSize,
  type PrintSize,
  type Sheet,
} from "../chart/sheets";
import {
  BADGE_BG,
  BADGE_FG,
  FOOTER_H,
  HEADER_H,
  SANS,
  prepareDiagram,
  printSheetSet,
  wrapWithBands,
  type PreparedDiagram,
  type SvgExportOptions,
} from "./exportSvg";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Everything the sheet export needs to lay a chart out again, exactly as the
 *  page has it on screen. */
export interface SheetChartSource {
  /** The tree being drawn — after any generation limit, so the print matches
   *  what the user is looking at. */
  tree: TreeNode;
  alignment: ChartAlignment;
  /** `true` for the grid diagram, `false` for the tidy tree. */
  grid: boolean;
  nodeH: number;
  /** Marriage-label callback, as passed to the on-screen `flatten`. */
  marriageLabel?: (n: TreeNode) => string | undefined;
  /** Ancestor mode — moves the marriage label to the parent bracket. */
  ancestors: boolean;
}

export interface SheetPaper {
  paper: PaperSize;
  orientation: Orientation;
  /** How small the print may go — what really decides the sheet count. */
  size: PrintSize;
}

/** Plan the split for `src` on the chosen paper. */
export function planSheets(src: SheetChartSource, { paper, orientation, size }: SheetPaper): Sheet[] {
  return splitIntoSheets(src.tree, {
    grid: src.grid,
    alignment: src.alignment,
    nodeH: src.nodeH,
    budget: sheetBudget(paper, orientation, HEADER_H + FOOTER_H, size),
  });
}

/** A planned sheet, laid out and flattened ready to draw. */
interface LaidSheet {
  sheet: Sheet;
  flat: Flat;
  width: number;
  height: number;
}

function laySheet(src: SheetChartSource, sheet: Sheet): LaidSheet {
  const laid = src.grid
    ? layoutGrid(sheet.root, src.alignment, src.nodeH)
    : layout(sheet.root, src.alignment, src.nodeH);
  const flat = flatten(
    laid.root,
    src.alignment,
    src.grid ? "elbow" : "curve",
    src.nodeH,
    src.marriageLabel,
    src.ancestors,
  );
  return { sheet, flat, width: laid.width, height: laid.height };
}

/**
 * Split the chart in the given `.tree-canvas` across pages and open the print
 * dialog on the set. `subtitle` supplies each sheet's second header line (the
 * caller owns the wording, and its translation). No-op when the canvas holds no
 * diagram.
 */
export async function printChartSheets(
  canvas: HTMLElement | null,
  src: SheetChartSource,
  paper: SheetPaper,
  // Each sheet gets its own header second line, so the shared `subtitle` string
  // gives way to a per-sheet one the caller words (and translates).
  opts: Omit<SvgExportOptions, "subtitle"> & { subtitle: (sheet: Sheet, total: number) => string },
): Promise<void> {
  const live = canvas?.querySelector("svg.tree-svg") as SVGSVGElement | null;
  if (!live) return;

  const sheets = planSheets(src, paper).map((s) => laySheet(src, s));
  const prepared = await prepareDiagram(live);
  const built = sheets.map(({ sheet, flat, width, height }) =>
    wrapWithBands(
      drawSheet(prepared, flat, src),
      width,
      height,
      { ...opts, subtitle: opts.subtitle(sheet, sheets.length) },
      prepared.foreground,
      false, // print never wants the halo filter — see wrapWithBands
    ),
  );

  // One scale for the whole set, so a box is the same size on every sheet.
  const box = pageBox(paper.paper, paper.orientation);
  const scale = Math.min(1, ...built.map((b) => Math.min(box.w / b.width, box.h / b.height)));
  const docTitle = opts.fileName ? `${opts.fileName}.gedmerge` : opts.title;
  printSheetSet(built, paperPx(paper.paper, paper.orientation), scale, docTitle);
}

// ─── Drawing one sheet ────────────────────────────────────────────────────────

/**
 * Assemble one sheet's diagram: the connectors from its own layout, then each
 * person's box lifted straight out of the prepared clone of the live chart and
 * re-positioned. A person cut off here keeps their box and gains the numbered
 * marker pointing at the sheet that carries on.
 */
function drawSheet(prepared: PreparedDiagram, flat: Flat, src: SheetChartSource): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("transform", `translate(${PAD},${PAD})`);
  svg.appendChild(g);

  const boxes = nodeIndex(prepared.clone);
  const templates = edgeTemplates(prepared.clone, prepared.foreground);

  for (const e of flat.edges) {
    const path = (e.partner ? templates.partner : templates.edge).cloneNode(true) as SVGPathElement;
    path.setAttribute("d", e.d);
    g.appendChild(path);
  }
  for (const e of flat.edges) {
    if (!e.label) continue;
    const text = templates.label.cloneNode(true) as SVGTextElement;
    text.setAttribute("x", String(e.label.x));
    text.setAttribute("y", String(e.label.y));
    text.textContent = e.label.text;
    g.appendChild(text);
  }
  for (const n of flat.nodes) {
    const box = boxes.get(n.key);
    if (!box) continue; // a position the live chart isn't drawing — nothing to lift
    const node = box.cloneNode(true) as SVGGElement;
    node.setAttribute("transform", `translate(${n.x},${n.y})`);
    if (n.continuesOn !== undefined) node.appendChild(continuationMarker(n.continuesOn, src));
    g.appendChild(node);
  }
  return svg;
}

/** The rendered person boxes of the live chart, by node key (see TreeSvg). */
function nodeIndex(clone: SVGSVGElement): Map<string, SVGGElement> {
  const map = new Map<string, SVGGElement>();
  clone.querySelectorAll<SVGGElement>("g.tree-node[data-key]").forEach((g) => {
    const key = g.getAttribute("data-key");
    if (key && !map.has(key)) map.set(key, g);
  });
  return map;
}

/**
 * Style carriers for the rebuilt connectors: an actual edge from the live chart,
 * whose computed styling `prepareDiagram` has already baked into it. The chart a
 * sheet comes from draws the same kinds of edge, so a template is normally
 * there; the fallbacks keep a degenerate chart (a lone person, no connectors at
 * all) from exporting invisible lines.
 */
function edgeTemplates(clone: SVGSVGElement, foreground: string) {
  const find = <T extends SVGElement>(sel: string) => clone.querySelector<T>(sel);
  const plainEdge = find<SVGPathElement>("path.tree-edge:not(.tree-edge-partner)");
  const partnerEdge = find<SVGPathElement>("path.tree-edge-partner");
  const label = find<SVGTextElement>("text.tree-edge-label");

  const fallbackPath = () => {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", foreground);
    p.setAttribute("stroke-opacity", "0.45");
    p.setAttribute("stroke-width", "1.5");
    return p;
  };
  const fallbackLabel = () => {
    const t = document.createElementNS(SVG_NS, "text");
    t.setAttribute("text-anchor", "middle");
    t.setAttribute("dominant-baseline", "central");
    t.setAttribute("font-family", SANS);
    t.setAttribute("font-size", "10");
    t.setAttribute("fill", foreground);
    return t;
  };
  const edge = plainEdge ?? partnerEdge ?? fallbackPath();
  return {
    edge,
    partner: partnerEdge ?? edge,
    label: label ?? fallbackLabel(),
  };
}

/**
 * The "continues on sheet N" marker: a short stub leaving the box in the
 * direction the chart grows, ending in a numbered disc — where the reader's eye
 * expects the next generation, which is exactly where the branch was cut. Drawn
 * with explicit brand colours (like the export's footer badge) rather than a
 * themed class, so it survives into the standalone print document.
 */
function continuationMarker(number: number, src: SheetChartSource): SVGGElement {
  // Stub + disc together span exactly PAD, so a marker on the last generation
  // still lands inside the sheet's own margin instead of being clipped.
  const r = 9;
  const gap = PAD - 2 * r;
  const lr = src.alignment === "lr";
  // Just past the box's trailing edge — right in left→right, below in top→down.
  const cx = lr ? NODE_W + gap + r : NODE_W / 2;
  const cy = lr ? src.nodeH / 2 : src.nodeH + gap + r;
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("class", "gm-sheet-marker");

  const stub = document.createElementNS(SVG_NS, "path");
  stub.setAttribute(
    "d",
    lr ? `M${NODE_W},${cy} H${cx - r}` : `M${cx},${src.nodeH} V${cy - r}`,
  );
  stub.setAttribute("fill", "none");
  stub.setAttribute("stroke", BADGE_BG);
  stub.setAttribute("stroke-width", "1.5");
  g.appendChild(stub);

  const disc = document.createElementNS(SVG_NS, "circle");
  disc.setAttribute("cx", String(cx));
  disc.setAttribute("cy", String(cy));
  disc.setAttribute("r", String(r));
  disc.setAttribute("fill", BADGE_BG);
  g.appendChild(disc);

  const text = document.createElementNS(SVG_NS, "text");
  text.setAttribute("x", String(cx));
  text.setAttribute("y", String(cy));
  text.setAttribute("text-anchor", "middle");
  text.setAttribute("dominant-baseline", "central");
  text.setAttribute("font-family", SANS);
  // The disc is a fixed size, so a three-digit sheet number sets in smaller type
  // rather than pushing the marker out of the margin.
  text.setAttribute("font-size", String(number).length > 2 ? "8" : "11");
  text.setAttribute("font-weight", "700");
  text.setAttribute("fill", BADGE_FG);
  text.textContent = String(number);
  g.appendChild(text);
  return g;
}
