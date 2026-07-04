// Radial ancestor (pedigree) layout for the Fan and Circle chart types.
//
// Draws a person's ancestry as concentric rings: the root sits in a centre disk,
// parents fill the first ring (each spanning half the sweep), grandparents the
// next, and so on — every generation doubling the slot count. A "fan" uses a 230°
// sweep (empty notch at the bottom, ancestors fanning up); a "circle" uses 360°.
//
// Labels (Webtrees style): the lifespan is always on its own line beneath the
// name. Inner/mid generations curve a given-name line, surname line and lifespan
// line along their own concentric arcs (`<textPath>`); the narrow outer rings
// keep the full name on one radial line (which reads outward, so it uses ring
// depth, not angular width) with the lifespan beneath. Reading direction mirrors
// about the vertical, so every label on a side reads the same way. The font
// shrinks by generation so names are never truncated, and inner rings can carry a
// small photo rotated to the ring, sitting before the name. Input is the ancestor
// `TreeNode` from `buildPersonTree(..., "ancestors")`.

import { PAD } from "./treeLayout";
import type { TreeNode } from "./personTree";
import { ALL_DISPLAY, formatMarriage, nodeDisplay, type NodeDisplay, type NodeDisplayOptions } from "./nodeDisplay";

export type FanShape = "fan" | "circle";

const TAU = Math.PI * 2;
const HALF = Math.PI / 2;
const FAN_DEG = 230;

// Centre disk + ring thickness. Inner rings (those that may carry a photo) are
// drawn thicker than the text-only outer rings; the outermost ring gets extra
// depth so its (radial) full name + lifespan have room.
const ROOT_R = 64;
const PHOTO_RING_W = 96;
const RING_W = 86;
const LAST_RING_EXTRA = 22;

// Label font size per generation (px); shrinks outward so names always fit. The
// last entry is reused for any deeper rings.
const FONT_BY_GEN = [13, 13, 12.5, 12, 11, 9.5, 8.5, 7.5, 6.8, 6.2, 5.8];

const DEFAULT_MAX_GEN = 10;
const DEFAULT_PHOTO_RINGS = 3;
// A dedicated thin "collar" ring reserved between generations for the marriage
// label (only when a marriage field is shown). The couple's collar sits at the
// inner edge of their (the parents') ring, centred under husband + wife.
const COLLAR_W = 26;
// From this couple-generation the collar's narrow arc can't hold "year, place" on
// one line, so the year and place stack on two concentric lines instead.
const MARRIAGE_TWO_LINE_FROM = 6;
// The deep, narrow rings can't fit every line: from this generation the place is
// dropped (capping the label at two lines — the name plus the lifespan)…
const TWO_LINE_FROM = 7;
// …and from this one only the name remains, in a lighter weight.
const NAME_ONLY_FROM = 8;
// From this generation the label uses the lighter weight (also applied to the
// outermost two rings of any chart).
const LIGHT_FROM = 8;

/** One label line: a name part or the lifespan/place. */
export interface FanLine {
  text: string;
  kind: "name" | "years";
  /** Curved baseline (`<textPath>`); absent on straight radial / centre segments. */
  arc?: string;
  /** Straight-segment y offset within the rotated label group. */
  dy?: number;
}

export interface FanSegment {
  /** Unique by *position* (`gen:slot`) — pedigree collapse repeats a person in
   *  two slots, and each occurrence is its own segment. */
  key: string;
  /** The ancestor at this slot — name/years/sex/status/master/incoming. */
  node: TreeNode;
  gen: number;
  slot: number;
  /** Annular-sector path (or the centre circle for the root). */
  d: string;
  /** Segment centroid in canvas px (PAD-relative), for selection + the minimap. */
  x: number;
  y: number;
  /** Lines, outermost first (curved) or top-to-bottom (straight). */
  lines: FanLine[];
  /** Label font size (px); lifespan lines render a touch smaller. */
  fontPx: number;
  /** Lighter-weight label (the two outermost rings). */
  light?: boolean;
  /** True when the lines ride curved arcs; false for straight radial / centre. */
  curved: boolean;
  /** `translate(anchor) rotate(deg)` for straight (radial / centre) labels. */
  labelTransform?: string;
  /** Photo placed before the name (PAD-relative centre + rotation to the ring). */
  photo?: { size: number; cx: number; cy: number; rot: number };
  /** Anchor for a small status badge dot (PAD-relative), near the inner edge. */
  badge: { x: number; y: number };
}

/** A marriage "collar": a curved label riding the ring boundary between a child's
 *  wedge and its two parents' segments (so it sits centred under the couple). */
export interface FanMarriage {
  /** Unique by the child's position (`m:gen:slot`). */
  key: string;
  /** Thin collar band (annular sector) spanning the couple, filled behind the text. */
  d: string;
  /** One or two curved label lines (deep rings stack the year over the place), each
   *  a `<textPath>` baseline + its text. */
  lines: { text: string; arc: string }[];
  fontPx: number;
}

export interface FanChart {
  segments: FanSegment[];
  /** Marriage collars, one per couple whose marriage is recorded (when enabled). */
  marriages: FanMarriage[];
  cx: number;
  cy: number;
  r0: number;
  rootKey: string;
  width: number;
  height: number;
}

interface Placed {
  node: TreeNode;
  gen: number;
  slot: number;
}

/** Father/mother for the next ring: slot bit 0 = father, 1 = mother. Assign by
 *  sex first (so a lone parent stays in their half), then by order for any
 *  ambiguous remainder. */
function splitParents(kids: TreeNode[]): [TreeNode | undefined, TreeNode | undefined] {
  let father: TreeNode | undefined;
  let mother: TreeNode | undefined;
  for (const k of kids) {
    if (k.sex === "M" && !father) father = k;
    else if (k.sex === "F" && !mother) mother = k;
  }
  for (const k of kids) {
    if (k === father || k === mother) continue;
    if (!father) father = k;
    else if (!mother) mother = k;
  }
  return [father, mother];
}

/** Split a display name into a given-name line and a surname line. The last
 *  whitespace token is the surname; everything before it is the given name. */
function nameLines(name: string): string[] {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return [name.trim() || name];
  return [parts.slice(0, -1).join(" "), parts[parts.length - 1]];
}

export function buildFanChart(
  root: TreeNode,
  shape: FanShape,
  opts: {
    maxGen?: number;
    photoRings?: number;
    hasPhoto?: (node: TreeNode) => boolean;
    /** Which fields to show (and whether to redact living people). */
    display?: NodeDisplayOptions;
    /** Localized "Living" placeholder for redacted living people. */
    livingLabel?: string;
    /** Relationship of a node to the chart root ("Father", "Grandmother", …),
     *  shown in place of a redacted living person's name. */
    kinshipOf?: (node: TreeNode) => string | undefined;
  } = {},
): FanChart {
  const maxGen = opts.maxGen ?? DEFAULT_MAX_GEN;
  const photoRings = opts.photoRings ?? DEFAULT_PHOTO_RINGS;
  const display = opts.display ?? ALL_DISPLAY;
  const livingLabel = opts.livingLabel ?? "Living";
  // Only reserve photo space for people who actually have one — and only when the
  // photo field is shown (privacy hides it). Otherwise the text uses the full ring.
  const hasPhoto = (node: TreeNode) =>
    (opts.hasPhoto?.(node) ?? false) &&
    nodeDisplay(display, { name: node.name, living: node.living, livingLabel }).showPhoto;
  /** The fields a node actually shows under the current settings. A redacted living
   *  person shows their relationship to the root (the only time kinship is needed,
   *  so it's resolved lazily). */
  const dispOf = (node: TreeNode): NodeDisplay => {
    // Kinship is only used to label a redacted living person (the fan has no
    // kinship line of its own), so resolve it only then.
    const kinship = display.privacyLiving && node.living ? opts.kinshipOf?.(node) : undefined;
    return nodeDisplay(display, {
      name: node.name,
      years: node.years,
      place: node.place,
      kinship,
      living: node.living,
      livingLabel,
    });
  };

  // 1. Walk ancestors into positioned slots (positions are unique, so pedigree
  //    collapse repeats a person rather than being deduped).
  const placed: Placed[] = [];
  (function walk(node: TreeNode, gen: number, slot: number) {
    placed.push({ node, gen, slot });
    if (gen >= maxGen) return;
    const [father, mother] = splitParents(node.children);
    if (father) walk(father, gen + 1, slot * 2);
    if (mother) walk(mother, gen + 1, slot * 2 + 1);
  })(root, 0, 0);
  const usedMaxGen = placed.reduce((m, p) => Math.max(m, p.gen), 0);

  // 2. Inner radius per generation (root disk + cumulative ring widths; the
  //    outermost ring is deepened for its radial labels). Text-only rings taper
  //    with depth so deep charts stay compact without crowding the short names.
  const ringW = (g: number) => {
    const base = g <= photoRings ? PHOTO_RING_W : Math.max(58, RING_W - (g - photoRings - 1) * 6);
    // The outermost two rings (e.g. gen 9 & 10) both get the extra depth so the
    // second-to-last ring is as deep as the last — they carry the longest labels.
    const deepened = g > photoRings && g >= usedMaxGen - 1;
    return base + (deepened ? LAST_RING_EXTRA : 0);
  };
  // Reserve a collar lane before every ancestor ring when a marriage field is on,
  // so each couple's label has its own band between them and their child.
  const showMarriage = display.showMarriageDate || display.showMarriagePlace;
  const collarW = showMarriage ? COLLAR_W : 0;
  const rInnerOf: number[] = [0];
  let acc = ROOT_R;
  for (let g = 1; g <= maxGen; g++) {
    acc += collarW;
    rInnerOf[g] = acc;
    acc += ringW(g);
  }
  const rMax = usedMaxGen === 0 ? ROOT_R : rInnerOf[usedMaxGen] + ringW(usedMaxGen);
  const cx = rMax;
  const cy = rMax;

  // 3. Sweep geometry, centred on the upward vertical (notch at the bottom).
  const sweep = shape === "circle" ? TAU : (FAN_DEG / 360) * TAU;
  const start = -HALF - sweep / 2;

  const segments: FanSegment[] = placed.map(({ node, gen, slot }) => {
    // Deep rings get a smaller, lighter-weight label so the cramped deep rings stay
    // legible without dominating: from LIGHT_FROM outward, plus the outermost two
    // rings of any chart; the very last ring is smaller still.
    const light = gen > 0 && (gen >= LIGHT_FROM || gen >= usedMaxGen - 1);
    const fontScale = gen > 0 && gen === usedMaxGen ? 0.7 : light ? 0.82 : 1;
    const fontPx = (FONT_BY_GEN[Math.min(gen, FONT_BY_GEN.length - 1)] ?? 6.5) * fontScale;
    const lineGap = round(fontPx * 1.22);

    if (gen === 0) {
      // With a photo it sits in the upper half of the centre disk and the name
      // goes beneath; without one the name is centred in the disk.
      const texts = labelTexts(dispOf(node), true);
      const showPhoto = hasPhoto(node);
      const m = texts.length;
      return {
        key: "0:0",
        node,
        gen,
        slot,
        d: circlePath(cx, cy, ROOT_R),
        x: cx,
        y: cy,
        lines: texts.map((l, i) => ({
          ...l,
          dy: showPhoto ? round(i * lineGap) : round((i - (m - 1) / 2) * lineGap),
        })),
        fontPx,
        curved: false,
        labelTransform: `translate(${round(cx)},${round(showPhoto ? cy + 4 : cy)})`,
        photo: showPhoto ? { size: 42, cx, cy: round(cy - 32), rot: 0 } : undefined,
        badge: { x: cx, y: round(cy + (showPhoto ? ROOT_R - 13 : -ROOT_R + 13)) },
      };
    }

    // Drop the place on deep rings, then the lifespan deeper still, so level 7+
    // never exceeds two lines.
    const disp = dispOf(node);
    const genDisp: NodeDisplay =
      gen >= NAME_ONLY_FROM
        ? { ...disp, years: undefined, place: undefined }
        : gen >= TWO_LINE_FROM
          ? { ...disp, place: undefined }
          : disp;

    const count = 2 ** gen;
    const delta = sweep / count;
    const a0 = start + slot * delta;
    const a1 = a0 + delta;
    const mid = (a0 + a1) / 2;
    const w = ringW(gen);
    const rIn = rInnerOf[gen];
    const rOut = rIn + w;
    const rMid = (rIn + rOut) / 2;

    // Curve the lines along the arc while the wedge is wider (along the arc) than
    // it is deep; switch to straight radial text once the rings get narrow.
    const curved = rMid * delta >= w * 0.95;
    // Curved (tangential) labels: a fan never flips (its labels stay continuous
    // across the slight dip below the horizontal); a full circle flips its bottom
    // half so those labels aren't upside-down. Radial labels flip on the left half
    // so their outward-reading text stays upright.
    // The circle's bottom half reads "upside down": labels flip, the line stack
    // reverses (so the name stays visually on top), and photos rotate 180°.
    const lowerHalf = shape === "circle" && Math.sin(mid) > 0;
    const flip = curved ? lowerHalf : Math.cos(mid) < 0;
    const photo = gen <= photoRings && hasPhoto(node) ? photoBox(cx, cy, rIn, w, delta, mid, lowerHalf) : undefined;

    const base: Pick<FanSegment, "key" | "node" | "gen" | "slot" | "d" | "x" | "y" | "photo" | "badge" | "fontPx" | "light"> = {
      key: `${gen}:${slot}`,
      node,
      gen,
      slot,
      d: sectorPath(cx, cy, rIn, rOut, a0, a1),
      x: cx + rMid * Math.cos(mid),
      y: cy + rMid * Math.sin(mid),
      photo,
      fontPx,
      light,
      badge: { x: round(cx + (rIn + 12) * Math.cos(mid)), y: round(cy + (rIn + 12) * Math.sin(mid)) },
    };

    if (curved) {
      // Curved rings split the name into given / surname lines, wrapping a long
      // given name onto extra lines so it never overflows the arc. The line gap
      // tightens if needed so every line stays inside the ring.
      const bandLo = photo ? rIn + photo.size + 14 : rIn + 8;
      const bandHi = rOut - 8;
      const centre = (bandLo + bandHi) / 2;
      // On the wide inner rings (gen 1–3), keep the name on a single line when both
      // the lifespan and place are shown — otherwise the given/surname split would
      // push the label to four lines and crowd the ring.
      const splitName = !(gen <= 3 && !!genDisp.years && !!genDisp.place);
      const texts = curvedTexts(genDisp, centre * delta, fontPx, splitName);
      const n = texts.length;
      const gap = Math.min(lineGap, (bandHi - bandLo - 2) / Math.max(n, 1));
      return {
        ...base,
        curved: true,
        lines: texts.map((l, i) => ({
          ...l,
          // Outermost line first; in the circle's bottom half the stack reverses so
          // the name still ends up visually on top.
          arc: arcPath(cx, cy, centre + (flip ? -1 : 1) * ((n - 1) / 2 - i) * gap, a0, a1, flip),
        })),
      };
    }

    // Straight radial text: the name reads outward (using ring depth, not arc
    // width), with the lifespan beneath. A full name too long for the ring depth
    // is split onto given / surname lines so it wraps instead of overflowing.
    // Rotate to point outward, flipped to read upright on the left half. Deep rings
    // drop the place, then the lifespan, via `genDisp` (so ring 8+ is name-only).
    const tooLong = genDisp.name.length * fontPx * 0.5 > w - 16;
    const texts = labelTexts(genDisp, tooLong);
    const n = texts.length;
    // Lines stack tangentially within the rotated frame — tighten the gap so they
    // fit the wedge's angular width.
    const gap = Math.min(lineGap, Math.max(1, (rMid * delta - 2) / n));
    let deg = (mid * 180) / Math.PI;
    if (flip) deg += 180;
    const ax = cx + rMid * Math.cos(mid);
    const ay = cy + rMid * Math.sin(mid);
    return {
      ...base,
      curved: false,
      labelTransform: `translate(${round(ax)},${round(ay)}) rotate(${round(deg)})`,
      lines: texts.map((l, i) => ({ ...l, dy: round((i - (n - 1) / 2) * gap) })),
    };
  });

  // Marriage collars: a thin band in the reserved lane just inside each couple's
  // (the parents') ring, centred under husband + wife. Drawn only when a marriage
  // field is shown and the child's parents occupy the next ring. The place drops
  // when it won't fit, and the whole label is skipped if even the year overflows.
  const marriages: FanMarriage[] = [];
  if (showMarriage) {
    for (const { node, gen, slot } of placed) {
      // A band is drawn under every couple that has a parent ring above them, even
      // with no recorded marriage (a gray placeholder); the year / place is added
      // on top only when recorded, not redacted, and it fits the arc.
      if (node.children.length === 0 || gen >= maxGen || gen + 1 > usedMaxGen) continue;
      const delta = sweep / 2 ** gen;
      const a0 = start + slot * delta;
      const a1 = a0 + delta;
      const mid = (a0 + a1) / 2;
      // The collar lane sits at the inner edge of the parents' ring.
      const rOut = rInnerOf[gen + 1];
      const rIn = rOut - collarW;
      const rMid = (rIn + rOut) / 2;
      const parentGen = gen + 1;
      const baseFont = FONT_BY_GEN[Math.min(parentGen, FONT_BY_GEN.length - 1)] ?? 6.5;
      const fields = { date: display.showMarriageDate, place: display.showMarriagePlace };
      // A full circle flips its bottom half so the label isn't upside-down.
      const flip = shape === "circle" && Math.sin(mid) > 0;
      // The root's-parents collar in a circle spans the whole 360°, where a0 ≡ a1
      // and a normal sector/arc degenerates — draw a full ring + full-circle baseline.
      const full = a1 - a0 >= TAU - 1e-6;
      const overflows = (s: string, font: number, r: number) => s.length * font * 0.5 > r * delta;
      const lineAt = (text: string, r: number) => ({
        text,
        arc: full ? circleBaseline(cx, cy, r) : arcPath(cx, cy, r, a0, a1, flip),
      });

      let lines: { text: string; arc: string }[] = [];
      let fontPx = round(Math.min(baseFont * 0.82, collarW * 0.55));

      if (node.marriage && !(display.privacyLiving && node.living)) {
        const { year, place } = node.marriage;
        // Deep rings stack the year over the place on two concentric lines (the arc
        // is too short for one line) when both are selected and recorded.
        if (parentGen >= MARRIAGE_TWO_LINE_FROM && fields.date && fields.place && year && place) {
          const twoFont = round(Math.min(baseFont * 0.82, collarW * 0.4));
          const gap = twoFont * 1.08;
          const dateText = formatMarriage(node.marriage, { date: true, place: false })!;
          if (!overflows(dateText, twoFont, rMid + gap / 2) && !overflows(place, twoFont, rMid - gap / 2)) {
            fontPx = twoFont;
            // Date outer, place inner — reversed in the circle's bottom half so the
            // date stays visually on top.
            const ord = flip ? -1 : 1;
            lines = [lineAt(dateText, rMid + (ord * gap) / 2), lineAt(place, rMid - (ord * gap) / 2)];
          }
        }
        // Otherwise one line; if "year, place" won't fit, fall back to the date
        // alone (when shown), else leave the band as a bare placeholder.
        if (!lines.length) {
          let text = formatMarriage(node.marriage, fields);
          if (text && overflows(text, fontPx, rMid) && fields.date && fields.place) {
            text = formatMarriage(node.marriage, { date: true, place: false });
          }
          if (text && !overflows(text, fontPx, rMid)) lines = [lineAt(text, rMid)];
        }
      }

      const d = full ? donutPath(cx, cy, rIn, rOut) : sectorPath(cx, cy, rIn, rOut, a0, a1);
      marriages.push({ key: `m:${gen}:${slot}`, d, lines, fontPx });
    }
  }

  return {
    segments,
    marriages,
    cx,
    cy,
    r0: ROOT_R,
    rootKey: "0:0",
    width: 2 * rMax + PAD * 2,
    height: 2 * rMax + PAD * 2,
  };
}

/** The label lines for a person: given/surname split when there's arc room
 *  (`split`), else the full name on one line — with the lifespan, then any place,
 *  beneath. `disp` already reflects which fields the settings show. */
function labelTexts(disp: NodeDisplay, split: boolean): { text: string; kind: FanLine["kind"] }[] {
  const names = split ? nameLines(disp.name) : [disp.name];
  return [
    ...names.map((text) => ({ text, kind: "name" as const })),
    ...(disp.years ? [{ text: disp.years, kind: "years" as const }] : []),
    ...(disp.place ? [{ text: disp.place, kind: "years" as const }] : []),
  ];
}

/** Curved-ring label lines: by default the surname on its own line with the given
 *  name(s) word-wrapped to the arc width above it; with `splitName` false the whole
 *  name wraps as one block (so it stays on one line when the ring is wide). The
 *  lifespan and any place follow beneath. */
function curvedTexts(
  disp: NodeDisplay,
  availWidth: number,
  fontPx: number,
  splitName = true,
): { text: string; kind: FanLine["kind"] }[] {
  const parts = disp.name.trim().split(/\s+/).filter(Boolean);
  const surname = splitName && parts.length > 1 ? parts[parts.length - 1] : undefined;
  const given = surname ? parts.slice(0, -1) : parts;
  const names = [...wrapWords(given, availWidth, fontPx * 0.52), ...(surname ? [surname] : [])];
  return [
    ...names.map((text) => ({ text, kind: "name" as const })),
    ...(disp.years ? [{ text: disp.years, kind: "years" as const }] : []),
    ...(disp.place ? [{ text: disp.place, kind: "years" as const }] : []),
  ];
}

/** Greedily pack words into lines no wider than `availWidth` (estimated). */
function wrapWords(words: string[], availWidth: number, charPx: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && next.length * charPx > availWidth) {
      lines.push(cur);
      cur = w;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

/** A photo box for an inner wedge, rotated so it aligns with the ring (bottom
 *  edge along the arc), sitting before the name. Undefined when too narrow. */
function photoBox(
  cx: number,
  cy: number,
  rIn: number,
  width: number,
  delta: number,
  mid: number,
  lowerHalf: boolean,
): { size: number; cx: number; cy: number; rot: number } | undefined {
  const rGuess = rIn + width * 0.26;
  const arc = rGuess * delta;
  const size = Math.min(width * 0.38, arc * 0.7, 46);
  if (size < 24) return undefined;
  const rPhoto = rIn + size / 2 + 8;
  // Bottom edge along the arc tangent → top points outward. In the circle's bottom
  // half that would land upside-down, so rotate a further 180° to keep it upright.
  const rot = (((((mid * 180) / Math.PI + 90 + (lowerHalf ? 180 : 0)) % 360) + 360) % 360);
  return {
    size: round(size),
    cx: round(cx + rPhoto * Math.cos(mid)),
    cy: round(cy + rPhoto * Math.sin(mid)),
    rot: round(rot),
  };
}

/** A curved text baseline spanning a wedge at radius `r`, mirrored about the
 *  vertical: left→right on the right half, reversed on the left half. */
function arcPath(cx: number, cy: number, r: number, a0: number, a1: number, flip: boolean): string {
  const pt = (a: number) => `${round(cx + r * Math.cos(a))},${round(cy + r * Math.sin(a))}`;
  // Large-arc flag must follow the span: the root's-parents collar wraps the whole
  // sweep (>180°), where a hardcoded 0 would draw the minor arc through the notch.
  const large = Math.abs(a1 - a0) > Math.PI ? 1 : 0;
  return flip
    ? `M${pt(a1)} A${round(r)},${round(r)} 0 ${large} 0 ${pt(a0)}`
    : `M${pt(a0)} A${round(r)},${round(r)} 0 ${large} 1 ${pt(a1)}`;
}

/** Annular sector between two radii and two angles (PAD-relative coords). */
function sectorPath(cx: number, cy: number, rIn: number, rOut: number, a0: number, a1: number): string {
  const large = a1 - a0 >= Math.PI ? 1 : 0;
  const p = (r: number, a: number) => `${round(cx + r * Math.cos(a))},${round(cy + r * Math.sin(a))}`;
  return (
    `M${p(rOut, a0)} A${round(rOut)},${round(rOut)} 0 ${large} 1 ${p(rOut, a1)} ` +
    `L${p(rIn, a1)} A${round(rIn)},${round(rIn)} 0 ${large} 0 ${p(rIn, a0)} Z`
  );
}

/** Full circle (the root disk), drawn as two semicircle arcs. */
function circlePath(cx: number, cy: number, r: number): string {
  return (
    `M${round(cx - r)},${round(cy)} ` +
    `A${round(r)},${round(r)} 0 1 1 ${round(cx + r)},${round(cy)} ` +
    `A${round(r)},${round(r)} 0 1 1 ${round(cx - r)},${round(cy)} Z`
  );
}

/** A full-circle text baseline starting at the bottom and running clockwise, so a
 *  `<textPath>` at 50% lands centred at the top (the circle chart's root collar). */
function circleBaseline(cx: number, cy: number, r: number): string {
  return (
    `M${round(cx)},${round(cy + r)} ` +
    `A${round(r)},${round(r)} 0 1 1 ${round(cx)},${round(cy - r)} ` +
    `A${round(r)},${round(r)} 0 1 1 ${round(cx)},${round(cy + r)}`
  );
}

/** A full annular ring (donut) between two radii — the circle chart's root collar
 *  band. Outer circle clockwise, inner counter-clockwise, so the hole is cut out. */
function donutPath(cx: number, cy: number, rIn: number, rOut: number): string {
  const ring = (r: number, sweep: 0 | 1) =>
    `M${round(cx - r)},${round(cy)} ` +
    `A${round(r)},${round(r)} 0 1 ${sweep} ${round(cx + r)},${round(cy)} ` +
    `A${round(r)},${round(r)} 0 1 ${sweep} ${round(cx - r)},${round(cy)} Z`;
  return `${ring(rOut, 1)} ${ring(rIn, 0)}`;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
