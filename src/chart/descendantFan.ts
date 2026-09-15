// Radial descendant layout for the Fan and Circle chart types.
//
// The root sits in the centre disk and every ring outward is one generation of
// descendants. A person's wedge is as wide as the number of family lines that
// end under them — every childless descendant counts one — so the outermost
// ring divides evenly and each inner wedge is exactly as wide as the branch it
// heads. A floor keeps a childless sibling's wedge wide enough for a name at
// its ring; the large branches pay for it proportionally. Spouses ride a thin
// band on the outside of their partner's wedge, one segment per marriage and
// as wide as that marriage's children (a childless marriage keeps a sliver),
// and the children of each marriage sit outside their own band, so a second
// marriage with more children visibly takes more of the arc.
//
// Labels, fonts, photos, the marker anchors and the sweep geometry follow the
// ancestor fan (fanLayout.ts), whose helpers this reuses; the output is the same
// `FanChart`, so FanChartBody draws both directions unchanged. The wedges carry
// names alone — a descendant wedge is as narrow as the lines under it, and a
// lifespan or a place fits so seldom that showing them where they happen to
// fit only made the ring read unevenly — and a name that is too long is
// shortened by dropping parts (see nameForms), never by an initial or an
// ellipsis. Input is the
// descendant `TreeNode` from `buildPersonTree(..., "descendants")`: a person's
// `partners` each carry that union's children, and children of a union with no
// recorded spouse hang off the person's own `children`.

import { PAD } from "./treeLayout";
import { countTreePeople, type TreeNode } from "./personTree";
import { MARRIAGE_SYMBOL, type NodeDisplay } from "./nodeDisplay";
import {
  BADGE_HALF_W,
  DEFAULT_MAX_GEN,
  DEFAULT_PHOTO_RINGS,
  FAN_DEG,
  FONT_BY_GEN,
  HALF,
  LAST_RING_EXTRA,
  LIGHT_FROM,
  PHOTO_RING_W,
  RING_W,
  ROOT_R,
  TAU,
  arcPath,
  circleBaseline,
  circlePath,
  curvedTexts,
  donutPath,
  fanResolvers,
  labelTexts,
  photoBox,
  round,
  sectorPath,
  type FanChart,
  type FanChartOptions,
  type FanLine,
  type FanSegment,
  type FanShape,
} from "./fanLayout";

/** A childless marriage's band, as a share of the floor a child of that
 *  generation would get — enough for the ⚭ glyph — unless the spouse's given
 *  name asks for more (see bandFloorOf). */
const CHILDLESS_UNION = 0.6;
/** How many children's floors a childless band may take to fit the spouse's
 *  given name along its lane, before the name gives way to the glyph. */
const BAND_NAME_MAX_FLOORS = 3;

/** Fill strength by generation: the children's ring strongest, then paler
 *  outward, so the depth reads from the tint and the branch from the hue. */
const TINT_GEN_1 = 36;
const TINT_STEP = 5;
const TINT_MIN = 12;
const TINT_BAND = 20;

/** One marriage of a person: the spouse node (absent when the union has no
 *  recorded spouse) and that union's children. */
interface Union {
  partner?: TreeNode;
  children: TreeNode[];
}

/** A person's unions in drawing order — each partner with their children,
 *  then, if any, the children with no recorded spouse as a partnerless union. */
function unionsOf(node: TreeNode): Union[] {
  const out: Union[] = node.partners.map((p) => ({ partner: p, children: p.children }));
  if (node.children.length) out.push({ children: node.children });
  return out;
}

/** The smallest inner-edge arc a wedge on ring `gen` needs for one name line. */
function labelArc(gen: number): number {
  return fontOf(gen) * 1.3;
}

function fontOf(gen: number): number {
  return FONT_BY_GEN[Math.min(gen, FONT_BY_GEN.length - 1)] ?? 6.5;
}

/** The forms a descendant's name is tried in, longest first, where the wedge
 *  or band has no room for all of it: the name as displayed, then without the
 *  parenthesised married surname, then the given name alone — the surname
 *  repeats down a line, and a spouse's band reads like everyone else's wedge.
 *  Read from the record's own name parts where there are any, so a
 *  surname-first display order cannot mislead; a redacted living person has
 *  only their placeholder. Never an initial or an ellipsis: a name that fits
 *  in no form is left off, and the wedge stays. */
export function nameForms(node: TreeNode, shown: string): string[] {
  if (shown !== node.name) return [shown];
  const full = shown.trim();
  const bare = full.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
  const primary = node.main?.names[0] ?? node.incoming?.names[0];
  const tokens = bare.split(" ").filter(Boolean);
  const given = primary?.given?.trim() || (tokens.length > 1 ? tokens.slice(0, -1).join(" ") : "");
  return [...new Set([full, bare, given].map((f) => f.trim()).filter(Boolean))];
}

/** The name lines of a radial (outward-reading) label: the first form that
 *  fits the ring depth on one line, or — with two lines of room — as a
 *  given-name line over a surname line; none when no form fits. */
function radialNameLines(forms: string[], maxLines: number, depth: number, fontPx: number): { text: string; kind: FanLine["kind"] }[] {
  const fits = (s: string) => s.length * fontPx * 0.5 <= depth;
  for (const form of forms) {
    if (fits(form)) return [{ text: form, kind: "name" }];
    if (maxLines >= 2) {
      const parts = form.split(/\s+/).filter(Boolean);
      if (parts.length > 1) {
        const lines = [parts.slice(0, -1).join(" "), parts[parts.length - 1]];
        if (lines.every(fits)) return lines.map((text) => ({ text, kind: "name" as const }));
      }
    }
  }
  return [];
}

export function buildDescendantFanChart(
  root: TreeNode,
  shape: FanShape,
  opts: FanChartOptions = {},
): FanChart {
  const maxGen = opts.maxGen ?? DEFAULT_MAX_GEN;
  const photoRings = opts.photoRings ?? DEFAULT_PHOTO_RINGS;
  const { hasPhoto, dispOf, titleOf } = fanResolvers(opts);

  const sweep = opts.arc?.sweep ?? (shape === "circle" ? TAU : (FAN_DEG / 360) * TAU);
  const start = opts.arc?.start ?? -HALF - sweep / 2;

  // 1. Ring census, ignoring any cap: how many people each generation holds,
  //    and whether it has spouses (which need a band lane outside its ring).
  const perGen: { people: number; bands: boolean }[] = [];
  (function census(n: TreeNode, gen: number) {
    const at = (perGen[gen] ??= { people: 0, bands: false });
    at.people++;
    if (n.partners.length) at.bands = true;
    for (const u of unionsOf(n)) for (const c of u.children) census(c, gen + 1);
  })(root, 0);
  const depth = perGen.length - 1;

  // The band lane for the marriages of generation `gen` (it sits just outside
  // that generation's ring): one curved line for the spouse's name, two when
  // a marriage field is shown as well.
  const bandFont = (gen: number) => round(fontOf(gen) * 0.9);
  const bandW = (gen: number) => round(bandFont(gen) * 1.9);

  // 2. Where the rings run out: a ring is drawn only while it has an inner-edge
  //    arc per person for at least a name line (the floor below hands the
  //    narrow wedges that much, and the total demand must fit the sweep). Past
  //    the cap the people are counted onto the last ring's "+N" markers, as
  //    the ancestor fan does with its own ring limit.
  let cap = Math.min(maxGen, depth);
  {
    let acc = ROOT_R;
    for (let g = 1; g <= cap; g++) {
      if (perGen[g - 1].bands) acc += bandW(g - 1);
      if (perGen[g].people * labelArc(g) > sweep * acc) {
        cap = g - 1;
        break;
      }
      acc += g <= photoRings ? PHOTO_RING_W : Math.max(58, RING_W - (g - photoRings - 1) * 6);
    }
  }
  const usedMaxGen = cap;
  const fontRings = opts.fontRings ?? usedMaxGen;

  // 3. Radii. Person ring `g` and, when that generation has spouses, the band
  //    lane just outside it. The outermost two text-only rings are deepened for
  //    their radial labels, like the ancestor fan.
  const ringW = (g: number) => {
    const base = g <= photoRings ? PHOTO_RING_W : Math.max(58, RING_W - (g - photoRings - 1) * 6);
    const deepened = g > photoRings && g >= usedMaxGen - 1;
    return base + (deepened ? LAST_RING_EXTRA : 0);
  };
  const ringOf: [number, number][] = [[0, ROOT_R]];
  const laneOf: ([number, number] | undefined)[] = [];
  let acc = ROOT_R;
  for (let g = 0; g <= cap; g++) {
    if (g > 0) {
      ringOf[g] = [acc, acc + ringW(g)];
      acc += ringW(g);
    }
    if (perGen[g].bands) {
      laneOf[g] = [acc, acc + bandW(g)];
      acc += bandW(g);
    }
  }
  const rMax = Math.max(acc, opts.radius ?? 0);
  const cx = rMax;
  const cy = rMax;

  // 4. Weights, in end-line units. A childless person is one line; a person with
  //    children is the sum of their unions'; a childless union (or one whose
  //    children lie past the ring cap) keeps a band just wide enough to name
  //    the spouse — their given name along the lane, up to a few children's
  //    worth, else the glyph's sliver. Then the floor: a wedge on ring g may
  //    not be narrower along its inner edge than one name line, so its weight
  //    is raised to that many units — which grows the total, so two more
  //    passes settle it.
  const valueOf = new Map<TreeNode, number>();
  const unionValue = new Map<TreeNode, number[]>();
  const weigh = (
    n: TreeNode,
    gen: number,
    floorOf: (gen: number) => number,
    bandFloorOf: (gen: number, partner: TreeNode) => number,
  ): number => {
    const unions = unionsOf(n);
    const drawn = gen < cap;
    const uv = unions.map((u) => {
      if (!drawn || !u.children.length) {
        return Math.max(floorOf(gen + 1) * CHILDLESS_UNION, u.partner ? bandFloorOf(gen, u.partner) : 0);
      }
      let s = 0;
      for (const c of u.children) s += weigh(c, gen + 1, floorOf, bandFloorOf);
      return s;
    });
    unionValue.set(n, uv);
    const sum = uv.reduce((a, b) => a + b, 0);
    const hasLine = drawn && unions.some((u) => u.children.length > 0);
    const v = Math.max(sum, hasLine ? 0 : 1, gen === 0 ? 0 : floorOf(gen));
    valueOf.set(n, v);
    return v;
  };
  let total = weigh(root, 0, () => 0, () => 0);
  for (let pass = 0; pass < 2; pass++) {
    const unit = sweep / Math.max(total, 1e-9);
    const floorOf = (g: number) => (g > cap ? 0 : labelArc(g) / ringOf[g][0] / unit);
    // The arc the spouse's shortest name form needs at the band's lane, in
    // weight units, capped so a long name never crowds the siblings.
    const bandFloorOf = (g: number, partner: TreeNode) => {
      const lane = laneOf[g];
      if (!lane || g > cap) return 0;
      const forms = nameForms(partner, dispOf(partner).name);
      const px = forms[forms.length - 1].length * bandFont(g) * 0.5 + 10;
      return Math.min(px / lane[0] / unit, (BAND_NAME_MAX_FLOORS * labelArc(g + 1)) / lane[0] / unit);
    };
    total = weigh(root, 0, floorOf, bandFloorOf);
  }

  // 5. Partition the sweep. A person's unions share the wedge by weight (centred
  //    when the floor made the wedge wider than its lines need); each union's
  //    children share its span by weight, in the tree's own order.
  interface Placed { node: TreeNode; gen: number; a0: number; a1: number }
  const persons: Placed[] = [];
  const bands: Placed[] = [];
  const place = (n: TreeNode, gen: number, a0: number, a1: number) => {
    persons.push({ node: n, gen, a0, a1 });
    const unions = unionsOf(n);
    if (!unions.length) return;
    const uv = unionValue.get(n)!;
    const scale = (a1 - a0) / Math.max(valueOf.get(n)!, 1e-9);
    const used = uv.reduce((a, b) => a + b, 0) * scale;
    let a = a0 + (a1 - a0 - used) / 2;
    unions.forEach((u, i) => {
      const ua0 = a;
      const ua1 = a + uv[i] * scale;
      if (u.partner) bands.push({ node: u.partner, gen, a0: ua0, a1: ua1 });
      if (gen < cap) {
        let ca = ua0;
        for (const c of u.children) {
          const cv = valueOf.get(c)!;
          place(c, gen + 1, ca, ca + cv * scale);
          ca += cv * scale;
        }
      }
      a = ua1;
    });
  };
  place(root, 0, start, start + sweep);

  // Each generation numbers its segments (people and bands alike) in drawing
  // order, so `gen:slot` stays unique per position and the label arcs' ids too.
  const slotCounter: number[] = [];
  const nextSlot = (gen: number) => (slotCounter[gen] = (slotCounter[gen] ?? 0) + 1) - 1;

  const segments: FanSegment[] = [];

  for (const { node, gen, a0, a1 } of persons) {
    const slot = nextSlot(gen);
    const light = gen > 0 && (gen >= LIGHT_FROM || gen >= fontRings - 1);
    const fontScale = gen > 0 && gen === fontRings ? 0.7 : light ? 0.82 : 1;
    const fontPx = fontOf(gen) * fontScale;
    const lineGap = round(fontPx * 1.22);

    if (gen === 0) {
      const texts = labelTexts(dispOf(node), true);
      const showPhoto = hasPhoto(node);
      const m = texts.length;
      segments.push({
        key: "0:0",
        node,
        gen,
        slot,
        title: titleOf(node),
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
      });
      continue;
    }

    // Names alone on every ring (see the header).
    const disp = dispOf(node);
    const genDisp: NodeDisplay = { ...disp, years: undefined, place: undefined };
    const forms = nameForms(node, disp.name);

    const delta = a1 - a0;
    const mid = (a0 + a1) / 2;
    const [rIn, rOut] = ringOf[gen];
    const w = rOut - rIn;
    const rMid = (rIn + rOut) / 2;

    const curved = rMid * delta >= w * 0.95;
    const lowerHalf = shape === "circle" && Math.sin(mid) > 0;
    const flip = curved ? lowerHalf : Math.cos(mid) < 0;
    const photo = gen <= photoRings && hasPhoto(node) ? photoBox(cx, cy, rIn, w, delta, mid, lowerHalf) : undefined;

    const rBadge = rOut - 8;
    const off = Math.max(0, delta / 2 - BADGE_HALF_W / rBadge);
    const badgeMid = mid + (flip ? -off : off);
    // The line below this person that the chart's own ring cap left undrawn.
    const cut = gen === cap && unionsOf(node).some((u) => u.children.length > 0) ? countTreePeople(node) : 0;

    const base: Omit<FanSegment, "lines" | "curved" | "labelTransform"> = {
      key: `${gen}:${slot}`,
      node,
      gen,
      slot,
      title: titleOf(node),
      d: sectorPath(cx, cy, rIn, rOut, a0, a1),
      x: cx + rMid * Math.cos(mid),
      y: cy + rMid * Math.sin(mid),
      photo,
      fontPx,
      light,
      badge: { x: round(cx + (rIn + 12) * Math.cos(mid)), y: round(cy + (rIn + 12) * Math.sin(mid)) },
      outerBadge: { x: round(cx + rBadge * Math.cos(badgeMid)), y: round(cy + rBadge * Math.sin(badgeMid)) },
      hidden: cut > 0 ? cut : undefined,
      tint: Math.max(TINT_MIN, TINT_GEN_1 - (gen - 1) * TINT_STEP),
    };

    if (curved) {
      const bandLo = photo ? rIn + photo.size + 14 : rIn + 8;
      const bandHi = rOut - 8;
      const centre = (bandLo + bandHi) / 2;
      // The longest form whose wrapped lines fit the ring's depth; none when
      // even one name alone would not.
      let texts: { text: string; kind: FanLine["kind"] }[] = [];
      for (const form of forms) {
        const lines = curvedTexts({ ...genDisp, name: form }, centre * delta, fontPx, true);
        if (lines.length * lineGap <= bandHi - bandLo) { texts = lines; break; }
      }
      const n = texts.length;
      const gap = Math.min(lineGap, (bandHi - bandLo - 2) / Math.max(n, 1));
      segments.push({
        ...base,
        curved: true,
        lines: texts.map((l, i) => ({
          ...l,
          arc: arcPath(cx, cy, centre + (flip ? -1 : 1) * ((n - 1) / 2 - i) * gap, a0, a1, flip),
        })),
      });
      continue;
    }

    // Straight radial text reading outward: as many lines as the wedge's inner
    // edge is tall — the name split over two when the ring is too shallow for
    // it, the lifespan and place beneath — down to a single fitted name line,
    // and none at all when even that would overflow (the wedge stays, coloured
    // and clickable; the panel names the person).
    const arcIn = rIn * delta;
    const maxLines = Math.floor(arcIn / (fontPx * 1.05));
    const texts = maxLines >= 1 ? radialNameLines(forms, maxLines, w - 16, fontPx) : [];
    const n = texts.length;
    const gap = Math.min(lineGap, Math.max(1, (rMid * delta - 2) / Math.max(n, 1)));
    let deg = (mid * 180) / Math.PI;
    if (flip) deg += 180;
    const ax = cx + rMid * Math.cos(mid);
    const ay = cy + rMid * Math.sin(mid);
    segments.push({
      ...base,
      curved: false,
      labelTransform: `translate(${round(ax)},${round(ay)}) rotate(${round(deg)})`,
      lines: texts.map((l, i) => ({ ...l, dy: round((i - (n - 1) / 2) * gap) })),
    });
  }

  // Spouse bands: a thin curved segment in the lane outside the partner's ring,
  // carrying the spouse's name (fitted to the arc, down to the ⚭ glyph alone)
  // and, when a marriage field is shown and recorded, the year / place on a
  // second concentric line. The root's only marriage in a circle spans the whole
  // 360°, where a sector degenerates — that one is a full ring.
  for (const { node, gen, a0, a1 } of bands) {
    const lane = laneOf[gen];
    if (!lane) continue;
    const slot = nextSlot(gen);
    const [rIn, rOut] = lane;
    const rMid = (rIn + rOut) / 2;
    const delta = a1 - a0;
    const mid = (a0 + a1) / 2;
    const full = delta >= TAU - 1e-6;
    const flip = shape === "circle" && Math.sin(mid) > 0;
    const light = gen >= LIGHT_FROM || gen >= fontRings - 1;
    const fontPx = bandFont(gen) * (light ? 0.82 : 1);
    const arcLen = (full ? TAU : delta) * rMid;
    const fits = (s: string, f: number) => s.length * f * 0.5 <= arcLen - 6;
    const disp = dispOf(node);

    // The name line: the longest form of the spouse's name that fits the arc
    // (see nameForms), else the marriage glyph alone, else nothing.
    let nameText: string | undefined;
    for (const cand of [...nameForms(node, disp.name), MARRIAGE_SYMBOL]) {
      if (fits(cand, fontPx)) { nameText = cand; break; }
    }
    const lines: FanLine[] = nameText
      ? [{ text: nameText, kind: "name", arc: full ? circleBaseline(cx, cy, rMid) : arcPath(cx, cy, rMid, a0, a1, flip) }]
      : [];

    // Markers sit at the band's two ends, clear of the centred label: the
    // status badge at the start, the repeat arrow at the end.
    const inset = Math.min(delta / 2, (BADGE_HALF_W + 2) / rMid);
    const aBadge = full ? mid - HALF : a0 + inset;
    const aOuter = full ? mid + HALF : a1 - inset;
    segments.push({
      key: `${gen}:${slot}`,
      node,
      gen,
      slot,
      title: titleOf(node),
      d: full ? donutPath(cx, cy, rIn, rOut) : sectorPath(cx, cy, rIn, rOut, a0, a1),
      x: cx + rMid * Math.cos(mid),
      y: cy + rMid * Math.sin(mid),
      lines,
      fontPx,
      light,
      curved: true,
      badge: { x: round(cx + rMid * Math.cos(aBadge)), y: round(cy + rMid * Math.sin(aBadge)) },
      outerBadge: { x: round(cx + rMid * Math.cos(aOuter)), y: round(cy + rMid * Math.sin(aOuter)) },
      band: true,
      tint: TINT_BAND,
    });
  }

  return {
    segments,
    marriages: [],
    cx,
    cy,
    r0: ROOT_R,
    rootKey: "0:0",
    maxGen: cap,
    rings: usedMaxGen,
    width: 2 * rMax + PAD * 2,
    height: 2 * rMax + PAD * 2,
  };
}
