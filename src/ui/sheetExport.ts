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
  LABEL_LINE_H,
  ANCESTOR_KEY_PREFIX,
  PAD,
  NODE_W,
  flatten,
  flattenBowtie,
  layout,
  layoutBowtie,
  layoutGrid,
  mirrorDepth,
  type ChartAlignment,
  type Flat,
} from "../chart/treeLayout";
import type { TreeNode } from "../chart/personTree";
import { PANEL_TITLE_H, type CompleteTree } from "../chart/completeTree";
import { planBowtiePages, planCompletePages, type CompletePage, type PagePiece } from "../chart/completeSheets";
import { APPROX_YEAR } from "../chart/nodeDisplay";
import { yearsSegments } from "../gedcom/lifespan";
import {
  fillScale,
  pageBox,
  printedPage,
  printedScale,
  scaleCap,
  sheetBudget,
  splitIntoSheets,
  type PrintPaper,
  type PrintSize,
  type Sheet,
} from "../chart/sheets";
import {
  BADGE_BG,
  BADGE_FG,
  FOOTER_H,
  HEADER_H,
  SANS,
  legendHeight,
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
  /** The Complete Tree, when that is the chart: it prints as its numbered
   *  trees packed onto pages instead of one tree cut up. */
  complete?: CompleteTree;
  /** The descendant half, when the chart is a bowtie; `tree` is then the
   *  ancestor half, both starting from the same person. */
  bowtie?: TreeNode;
}

export interface SheetPaper extends PrintPaper {
  /** How small the print may go — what really decides the sheet count. */
  size: PrintSize;
}

/**
 * The bands every sheet carries, in canvas px: the header and footer, and the
 * colour key when the chart has one — each sheet is a page of its own and gets
 * the key, so the split and the preview have to allow for it exactly as
 * `wrapWithBands` will draw it. Measured at the width one sheet may span,
 * which the key's own height cannot change.
 */
export function sheetBandsHeight(legend: SvgExportOptions["legend"], { paper, orientation, size }: SheetPaper): number {
  const { w } = sheetBudget(paper, orientation, 0, size);
  return HEADER_H + FOOTER_H + legendHeight(legend, w);
}

/** Plan the split for `src` on the chosen paper, leaving `bandsH` of each sheet
 *  to the export frame (see {@link sheetBandsHeight}). */
export function planSheets(src: SheetChartSource, { paper, orientation, size }: SheetPaper, bandsH = HEADER_H + FOOTER_H): Sheet[] {
  return splitIntoSheets(src.tree, {
    grid: src.grid,
    alignment: src.alignment,
    nodeH: src.nodeH,
    budget: sheetBudget(paper, orientation, bandsH, size),
  });
}

/** What the print will come out at, for the dialog to show before committing to
 *  it — a chart shrunk to 8% is a chart nobody can read, and the user should
 *  hear that from the dialog rather than from the printer. Measured on the
 *  diagram alone, so it is a hair optimistic for a diagram narrower than the
 *  header title. */
export function planPrintScale(src: SheetChartSource, paper: SheetPaper, sheets: Sheet[], bandsH = HEADER_H + FOOTER_H): number {
  const laid = sheets.map((s) => {
    const { width, height } = laySheet(src, s);
    return { width, height: height + bandsH };
  });
  return printedScale(laid, paper);
}

// ─── The plan the dialog shows ────────────────────────────────────────────────

/** What a print on one paper comes to — everything the dialog says about it
 *  before anything is drawn. */
export interface PrintPlan {
  paper: SheetPaper;
  /** The chart prints as pieces packed onto pages (see {@link packedTrees}). */
  packed?: PackedTrees;
  /** The chart prints as it stands on screen, whole on one sheet. */
  whole?: boolean;
  count: number;
  /** The scale the set prints at. */
  scale: number;
  /** Packed pages that print smaller than the rest. */
  smaller: number;
  /** On a roll: how much of it the print takes, in px, margins included. */
  length?: number;
}

/**
 * Plan a print of `src` on `paper`. A chart that cannot be cut (`src` absent)
 * is one sheet of the diagram's own size, `whole`, as measured off the canvas.
 */
export function planPrint(
  src: SheetChartSource | undefined,
  paper: SheetPaper,
  legend: SvgExportOptions["legend"],
  whole?: { w: number; h: number } | null,
): PrintPlan {
  const bandsH = sheetBandsHeight(legend, paper);
  const done = (extents: { width: number; height: number }[], scale: number, rest: Partial<PrintPlan> = {}): PrintPlan => {
    const page = extents.length ? printedPage(extents, scale, paper) : undefined;
    return {
      paper,
      count: extents.length || 1,
      scale,
      smaller: 0,
      length: paper.roll && page ? Math.max(page.w, page.h) : undefined,
      ...rest,
    };
  };
  if (!src) {
    const extents = whole ? [{ width: whole.w, height: whole.h + bandsH }] : [];
    return done(extents, extents.length ? printedScale(extents, paper) : 1, { whole: true });
  }
  if (src.bowtie && !planBowtiePages(src.tree, src.bowtie, splitOptions(src, paper, bandsH))) {
    // A bowtie that fits the sheet: the chart as it stands.
    const laid = layoutBowtie(src.tree, src.bowtie, src.alignment, src.nodeH, src.grid);
    const extents = [{ width: laid.width, height: laid.height + bandsH }];
    return done(extents, printedScale(extents, paper), { whole: true });
  }
  const sheets = src.complete || src.bowtie ? [] : planSheets(src, paper, bandsH);
  const packed = src.bowtie ? BOWTIE_PIECES : packedTrees(src, sheets);
  if (packed) {
    const pages = planCompleteSheets(packed, src, paper, bandsH);
    const extents = pages.map((p) => ({ width: p.width, height: p.height + bandsH }));
    const { common } = completePrintScales(pages.map((p, i) => ({ ...extents[i], oversized: p.oversized })), paper);
    return done(extents, common, { packed, smaller: pages.filter((p) => p.oversized).length });
  }
  const extents = sheets.map((s) => {
    const { width, height } = laySheet(src, s);
    return { width, height: height + bandsH };
  });
  return done(extents, printedScale(extents, paper));
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

  const sheets = planSheets(src, paper, sheetBandsHeight(opts.legend, paper)).map((s) => laySheet(src, s));
  const prepared = await prepareDiagram(live);
  const built = sheets.map(({ sheet, flat, width, height }) =>
    wrapWithBands(
      drawSheet(prepared, flat, src),
      width,
      height,
      { ...opts, subtitle: opts.subtitle(sheet, sheets.length) },
      prepared.foreground,
    ),
  );

  const scale = printedScale(built, paper);
  const docTitle = opts.fileName ? `${opts.fileName}.gedmerge` : opts.title;
  printSheetSet(built, printedPage(built, scale, paper), scale, docTitle);
}

// ─── Pieces packed onto pages ─────────────────────────────────────────────────

/** What prints as framed pieces packed onto pages: the Complete Tree, or a
 *  single tree that needs more than one sheet (see {@link packedTrees}). */
export type PackedTrees = Pick<CompleteTree, "panels">;

/**
 * The trees `src` prints as packed pieces, when it does: the Complete Tree
 * always, any other chart once it is cut — a set of `sheets` — so its branches
 * share the paper. A chart that fits one sheet prints plain, with no frame.
 */
export function packedTrees(src: SheetChartSource, sheets: Sheet[]): PackedTrees | undefined {
  return src.complete ?? (sheets.length > 1 ? { panels: [{ number: 1, tree: src.tree }] } : undefined);
}

/** A bowtie's pieces come from its two halves, not from a list of trees: this
 *  stands in for them where a plan says "packed". */
const BOWTIE_PIECES: PackedTrees = { panels: [] };

function splitOptions(src: SheetChartSource, { paper, orientation, size }: SheetPaper, bandsH: number) {
  return {
    grid: src.grid,
    alignment: src.alignment,
    nodeH: src.nodeH,
    budget: sheetBudget(paper, orientation, bandsH, size),
  };
}

/** Plan the packed pages (see `completeSheets.ts`). The parts of a single
 *  tree or a bowtie are numbered plainly; the Complete Tree's by tree and part. */
export function planCompleteSheets(
  trees: PackedTrees,
  src: SheetChartSource,
  paper: SheetPaper,
  bandsH = HEADER_H + FOOTER_H,
): CompletePage[] {
  const opts = splitOptions(src, paper, bandsH);
  if (src.bowtie) return planBowtiePages(src.tree, src.bowtie, opts) ?? [];
  return planCompletePages(trees, opts, !src.complete);
}

/**
 * The scales the planned pages print at. One for the whole set, as for sheets
 * ({@link planPrintScale}) — except a page holding a family too big to cut
 * down to the page: shrinking every page to its size would cost the whole set
 * its legibility for a handful of pages, so that page alone comes out smaller.
 */
export function completePrintScales(
  pages: (Pick<CompletePage, "oversized"> & { width: number; height: number })[],
  paper: PrintPaper & { size?: PrintSize },
): { common: number; scales: number[] } {
  const box = pageBox(paper.paper, paper.orientation);
  const regular = pages.filter((p) => !p.oversized);
  const common = Math.min(fillScale(regular.length ? regular : pages, box), scaleCap(paper));
  return {
    common,
    scales: pages.map((p) => (p.oversized ? Math.min(common, fillScale([p], box)) : common)),
  };
}

/** Print the packed pages: the pieces each in its frame, titled by
 *  `pieceTitle` (the caller words and translates it). */
export async function printCompleteSheets(
  canvas: HTMLElement | null,
  complete: PackedTrees,
  src: SheetChartSource,
  paper: SheetPaper,
  opts: Omit<SvgExportOptions, "subtitle"> & {
    subtitle: (page: CompletePage, total: number) => string;
    pieceTitle: (piece: PagePiece) => string;
  },
): Promise<void> {
  const live = canvas?.querySelector("svg.tree-svg") as SVGSVGElement | null;
  if (!live) return;
  const pages = planCompleteSheets(complete, src, paper, sheetBandsHeight(opts.legend, paper));
  const prepared = await prepareDiagram(live);
  const parts = liveParts(prepared);
  const built = pages.map((page) =>
    wrapWithBands(
      drawPage(parts, page, src, prepared.foreground, opts.pieceTitle),
      page.width,
      page.height,
      { ...opts, subtitle: opts.subtitle(page, pages.length) },
      prepared.foreground,
    ),
  );
  const { scales } = completePrintScales(
    built.map((b, i) => ({ ...b, oversized: pages[i].oversized })),
    paper,
  );
  printSheetSet(built, printedPage(built, scales, paper), scales, opts.fileName ? `${opts.fileName}.gedmerge` : opts.title);
}

/** One page: each piece's frame and title, its tree inside. Colours are
 *  explicit, as everything in the print document is. */
function drawPage(
  parts: LiveParts,
  page: CompletePage,
  src: SheetChartSource,
  foreground: string,
  pieceTitle: (piece: PagePiece) => string,
): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const piece of page.pieces) {
    const frame = document.createElementNS(SVG_NS, "rect");
    frame.setAttribute("x", String(piece.x));
    frame.setAttribute("y", String(piece.y));
    frame.setAttribute("width", String(piece.w));
    frame.setAttribute("height", String(piece.h));
    frame.setAttribute("rx", "12");
    frame.setAttribute("fill", "none");
    frame.setAttribute("stroke", foreground);
    frame.setAttribute("stroke-opacity", "0.3");
    svg.appendChild(frame);

    const title = document.createElementNS(SVG_NS, "text");
    title.setAttribute("x", String(piece.x + 16));
    title.setAttribute("y", String(piece.y + PANEL_TITLE_H / 2 + 4));
    title.setAttribute("dominant-baseline", "central");
    title.setAttribute("font-family", SANS);
    title.setAttribute("fill", foreground);
    const num = document.createElementNS(SVG_NS, "tspan");
    num.setAttribute("font-size", "18");
    num.setAttribute("font-weight", "700");
    num.setAttribute("fill", BADGE_BG);
    num.textContent = piece.label;
    const name = document.createElementNS(SVG_NS, "tspan");
    name.setAttribute("dx", "10");
    name.setAttribute("font-size", "14");
    name.setAttribute("font-weight", "600");
    name.textContent = pieceTitle(piece);
    title.append(num, name);
    svg.appendChild(title);

    const connector = src.grid ? "elbow" : "curve";
    let flat: Flat;
    const mirrored = !piece.other && !!piece.ancestors;
    if (piece.other) {
      // The bowtie's own piece: both halves, as the screen joins them.
      flat = flattenBowtie(layoutBowtie(piece.root, piece.other, src.alignment, src.nodeH, src.grid), src.alignment, connector, src.nodeH, src.marriageLabel);
    } else {
      const laid = src.grid ? layoutGrid(piece.root, src.alignment, src.nodeH) : layout(piece.root, src.alignment, src.nodeH);
      // A branch cut off a bowtie's ancestors grows the way they do on part 1.
      if (mirrored) mirrorDepth(laid, src.alignment, src.nodeH);
      flat = flatten(laid.root, src.alignment, connector, src.nodeH, src.marriageLabel, piece.ancestors ?? src.ancestors, mirrored);
    }
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("transform", `translate(${piece.x + PAD},${piece.y + PANEL_TITLE_H + PAD})`);
    drawTree(g, parts, flat, src, piece.markerLabel, piece.keyPrefix, !!piece.other, mirrored);
    svg.appendChild(g);
  }
  return svg;
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
  drawTree(g, liveParts(prepared), flat, src, String);
  return svg;
}

/** What every drawn tree lifts from the live chart: its boxes by key, and the
 *  connector styles. Indexed once per print, however many trees it draws. */
interface LiveParts {
  boxes: Map<string, SVGGElement>;
  templates: ReturnType<typeof edgeTemplates>;
}

function liveParts(prepared: PreparedDiagram): LiveParts {
  return { boxes: nodeIndex(prepared.clone), templates: edgeTemplates(prepared.clone, prepared.foreground) };
}

/** Draw one laid tree into `g`: connectors, marriage labels, then the boxes —
 *  a cut-off person with the marker `markerLabel` words for its sheet. */
function drawTree(
  g: SVGGElement,
  { boxes, templates }: LiveParts,
  flat: Flat,
  src: SheetChartSource,
  markerLabel: (part: number) => string,
  /** What the live chart's keys carry before this tree's own (a bowtie's
   *  ancestor half, drawn here as a tree by itself). */
  keyPrefix = "",
  /** The tree is a bowtie: its ancestor half grows the other way, and a
   *  marker there sits on the box's leading side. */
  bowtie = false,
  /** The whole tree is a branch of a bowtie's ancestors, drawn mirrored. */
  mirrored = false,
): void {
  for (const e of flat.edges) {
    const path = (e.partner ? templates.partner : templates.edge).cloneNode(true) as SVGPathElement;
    path.setAttribute("d", e.d);
    g.appendChild(path);
  }
  for (const e of flat.edges) {
    if (!e.label) continue;
    // The template's attributes only; its lines are this label's, as TreeSvg wraps them.
    const text = templates.label.cloneNode(false) as SVGTextElement;
    text.setAttribute("x", String(e.label.x));
    text.setAttribute("y", String(e.label.y));
    e.label.lines.forEach((line, i) => {
      const span = document.createElementNS(SVG_NS, "tspan");
      span.setAttribute("x", String(e.label!.x));
      span.setAttribute("dy", String(i ? LABEL_LINE_H : (-(e.label!.lines.length - 1) / 2) * LABEL_LINE_H));
      // The approximate marriage year in italics, as TreeSvg sets it.
      for (const seg of yearsSegments(line, i === e.label!.approxLine ? APPROX_YEAR : undefined)) {
        if (!seg.approx) { span.appendChild(document.createTextNode(seg.text)); continue; }
        const run = document.createElementNS(SVG_NS, "tspan");
        run.setAttribute("class", "gm-approx");
        run.textContent = seg.text;
        span.appendChild(run);
      }
      text.appendChild(span);
    });
    g.appendChild(text);
  }
  for (const n of flat.nodes) {
    const box = boxes.get(keyPrefix + n.key);
    if (!box) continue; // a position the live chart isn't drawing — nothing to lift
    const node = box.cloneNode(true) as SVGGElement;
    node.setAttribute("transform", `translate(${n.x},${n.y})`);
    if (n.continuesOn !== undefined) {
      node.appendChild(continuationMarker(markerLabel(n.continuesOn), src, mirrored || (bowtie && n.key.startsWith(ANCESTOR_KEY_PREFIX))));
    }
    g.appendChild(node);
  }
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
function continuationMarker(label: string, src: SheetChartSource, mirrored = false): SVGGElement {
  // Stub + disc together span exactly PAD, so a marker on the last generation
  // still lands inside the sheet's own margin instead of being clipped.
  const r = 9;
  const gap = PAD - 2 * r;
  const lr = src.alignment === "lr";
  // Just past the box's trailing edge — right in left→right, below in top→down
  // — or, mirrored, just before its leading one.
  const depth = lr ? NODE_W : src.nodeH;
  const edge = mirrored ? 0 : depth;
  const centre = mirrored ? -(gap + r) : depth + gap + r;
  const cx = lr ? centre : NODE_W / 2;
  const cy = lr ? src.nodeH / 2 : centre;
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("class", "gm-sheet-marker");

  const stub = document.createElementNS(SVG_NS, "path");
  stub.setAttribute(
    "d",
    lr ? `M${edge},${cy} H${mirrored ? cx + r : cx - r}` : `M${cx},${edge} V${mirrored ? cy + r : cy - r}`,
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
  // A Complete Tree part ("15.2") gets the smallest type the disc takes.
  text.setAttribute("font-size", label.length > 3 ? "6" : label.length > 2 ? "8" : "11");
  text.setAttribute("font-weight", "700");
  text.setAttribute("fill", BADGE_FG);
  text.textContent = label;
  g.appendChild(text);
  return g;
}
