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
// `FanChart`, so FanChartBody draws both directions unchanged. Input is the
// descendant `TreeNode` from `buildPersonTree(..., "descendants")`: a person's
// `partners` each carry that union's children, and children of a union with no
// recorded spouse hang off the person's own `children`.

import { PAD } from "./treeLayout";
import { countTreePeople, type TreeNode } from "./personTree";
import { MARRIAGE_SYMBOL, formatMarriage, type NodeDisplay } from "./nodeDisplay";
import {
  BADGE_HALF_W,
  DEFAULT_MAX_GEN,
  DEFAULT_PHOTO_RINGS,
  FAN_DEG,
  FONT_BY_GEN,
  HALF,
  LAST_RING_EXTRA,
  LIGHT_FROM,
  NAME_ONLY_FROM,
  PHOTO_RING_W,
  RING_W,
  ROOT_R,
  TAU,
  TWO_LINE_FROM,
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
 *  generation would get — enough for the ⚭ glyph, not for a child's name. */
const CHILDLESS_UNION = 0.6;

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

/** A name that fits `maxW` at `fontPx` (estimated at half an em per character):
 *  the full name, else given name + surname initial, else the given name alone,
 *  else that cut with an ellipsis. */
function fitName(name: string, maxW: number, fontPx: number): string {
  const charPx = fontPx * 0.5;
  const fits = (s: string) => s.length * charPx <= maxW;
  if (fits(name)) return name;
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length > 1) {
    const surname = parts[parts.length - 1];
    const given = parts.slice(0, -1).join(" ");
    const short = `${given} ${surname[0]}.`;
    if (fits(short)) return short;
    if (fits(given)) return given;
    name = given;
  }
  const n = Math.max(1, Math.floor(maxW / charPx) - 1);
  return name.length > n ? `${name.slice(0, n)}…` : name;
}

export function buildDescendantFanChart(
  root: TreeNode,
  shape: FanShape,
  opts: FanChartOptions = {},
): FanChart {
  const maxGen = opts.maxGen ?? DEFAULT_MAX_GEN;
  const photoRings = opts.photoRings ?? DEFAULT_PHOTO_RINGS;
  const { display, hasPhoto, dispOf, titleOf } = fanResolvers(opts);
  const showMarriage = display.showMarriageDate || display.showMarriagePlace;
  const marriageFields = { date: display.showMarriageDate, place: display.showMarriagePlace };

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
  const bandW = (gen: number) => round(bandFont(gen) * (showMarriage ? 3.1 : 1.9));

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
  //    children is the sum of their unions'; a childless union keeps a sliver.
  //    Then the floor: a wedge on ring g may not be narrower along its inner
  //    edge than one name line, so its weight is raised to that many units —
  //    which grows the total, so two more passes settle it.
  const valueOf = new Map<TreeNode, number>();
  const unionValue = new Map<TreeNode, number[]>();
  const weigh = (n: TreeNode, gen: number, floorOf: (gen: number) => number): number => {
    const unions = unionsOf(n);
    const drawn = gen < cap;
    const uv = unions.map((u) => {
      if (!drawn || !u.children.length) return floorOf(gen + 1) * CHILDLESS_UNION;
      let s = 0;
      for (const c of u.children) s += weigh(c, gen + 1, floorOf);
      return s;
    });
    unionValue.set(n, uv);
    const sum = uv.reduce((a, b) => a + b, 0);
    const hasLine = drawn && unions.some((u) => u.children.length > 0);
    const v = Math.max(sum, hasLine ? 0 : 1, gen === 0 ? 0 : floorOf(gen));
    valueOf.set(n, v);
    return v;
  };
  let total = weigh(root, 0, () => 0);
  for (let pass = 0; pass < 2; pass++) {
    const unit = sweep / Math.max(total, 1e-9);
    const floorOf = (g: number) => (g > cap ? 0 : labelArc(g) / ringOf[g][0] / unit);
    total = weigh(root, 0, floorOf);
  }

  // 5. Partition the sweep. A person's unions share the wedge by weight (centred
  //    when the floor made the wedge wider than its lines need); each union's
  //    children share its span by weight, in the tree's own order.
  interface PlacedPerson { node: TreeNode; gen: number; a0: number; a1: number; branch?: number }
  interface PlacedBand { node: TreeNode; gen: number; a0: number; a1: number; branch?: number }
  const persons: PlacedPerson[] = [];
  const bands: PlacedBand[] = [];
  let rootBranches = 0;
  const place = (n: TreeNode, gen: number, a0: number, a1: number, branch: number | undefined) => {
    persons.push({ node: n, gen, a0, a1, branch });
    const unions = unionsOf(n);
    if (!unions.length) return;
    const uv = unionValue.get(n)!;
    const scale = (a1 - a0) / Math.max(valueOf.get(n)!, 1e-9);
    const used = uv.reduce((a, b) => a + b, 0) * scale;
    let a = a0 + (a1 - a0 - used) / 2;
    unions.forEach((u, i) => {
      const ua0 = a;
      const ua1 = a + uv[i] * scale;
      if (u.partner) bands.push({ node: u.partner, gen, a0: ua0, a1: ua1, branch });
      if (gen < cap) {
        let ca = ua0;
        for (const c of u.children) {
          const cv = valueOf.get(c)!;
          const cb = gen === 0 ? rootBranches++ : branch;
          place(c, gen + 1, ca, ca + cv * scale, cb);
          ca += cv * scale;
        }
      }
      a = ua1;
    });
  };
  place(root, 0, start, start + sweep, undefined);

  // Each generation numbers its segments (people and bands alike) in drawing
  // order, so `gen:slot` stays unique per position and the label arcs' ids too.
  const slotCounter: number[] = [];
  const nextSlot = (gen: number) => (slotCounter[gen] = (slotCounter[gen] ?? 0) + 1) - 1;

  const segments: FanSegment[] = [];

  for (const { node, gen, a0, a1, branch } of persons) {
    const slot = nextSlot(gen);
    const light = gen > 0 && (gen >= LIGHT_FROM || gen >= usedMaxGen - 1);
    const fontScale = gen > 0 && gen === usedMaxGen ? 0.7 : light ? 0.82 : 1;
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

    const disp = dispOf(node);
    const genDisp: NodeDisplay =
      gen >= NAME_ONLY_FROM
        ? { ...disp, years: undefined, place: undefined }
        : gen >= TWO_LINE_FROM
          ? { ...disp, place: undefined }
          : disp;

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
      branch,
    };

    if (curved) {
      const bandLo = photo ? rIn + photo.size + 14 : rIn + 8;
      const bandHi = rOut - 8;
      const centre = (bandLo + bandHi) / 2;
      const splitName = !(gen <= 3 && !!genDisp.years && !!genDisp.place);
      const texts = curvedTexts(genDisp, centre * delta, fontPx, splitName);
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
    let texts: { text: string; kind: FanLine["kind"] }[] = [];
    if (maxLines >= 1) {
      const tooLong = genDisp.name.length * fontPx * 0.5 > w - 16;
      texts = labelTexts(genDisp, tooLong && maxLines >= 2);
      if (texts.length > maxLines) {
        texts =
          maxLines === 1
            ? [{ text: fitName(genDisp.name, w - 16, fontPx), kind: "name" }]
            : texts.slice(0, maxLines);
      }
    }
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
  for (const { node, gen, a0, a1, branch } of bands) {
    const lane = laneOf[gen];
    if (!lane) continue;
    const slot = nextSlot(gen);
    const [rIn, rOut] = lane;
    const rMid = (rIn + rOut) / 2;
    const delta = a1 - a0;
    const mid = (a0 + a1) / 2;
    const full = delta >= TAU - 1e-6;
    const flip = shape === "circle" && Math.sin(mid) > 0;
    const light = gen >= LIGHT_FROM || gen >= usedMaxGen - 1;
    const fontPx = bandFont(gen) * (light ? 0.82 : 1);
    const arcLen = (full ? TAU : delta) * rMid;
    const fits = (s: string, f: number) => s.length * f * 0.5 <= arcLen - 6;
    const disp = dispOf(node);

    // The name line: full → "Given S." → given → the glyph → nothing.
    let nameText: string | undefined;
    for (const cand of [disp.name, fitName(disp.name, arcLen - 6, fontPx), MARRIAGE_SYMBOL]) {
      if (fits(cand, fontPx)) { nameText = cand; break; }
    }
    // The marriage line, in the muted lifespan style: year + place, falling
    // back to the year alone, and dropped when even that overflows or the
    // couple is redacted.
    let marriageText: string | undefined;
    if (showMarriage && node.marriage) {
      const redact = display.privacyLiving && (node.living || !!node.marriage.living);
      let text = redact ? undefined : formatMarriage(node.marriage, marriageFields, display.privacyLiving);
      if (text && !fits(text, fontPx * 0.85) && marriageFields.date && marriageFields.place) {
        text = formatMarriage(node.marriage, { date: true, place: false }, display.privacyLiving);
      }
      if (text && fits(text, fontPx * 0.85)) marriageText = text;
    }

    const lineAt = (text: string, kind: FanLine["kind"], r: number): FanLine => ({
      text,
      kind,
      arc: full ? circleBaseline(cx, cy, r) : arcPath(cx, cy, r, a0, a1, flip),
    });
    const lines: FanLine[] = [];
    if (nameText && marriageText) {
      // Name outer, marriage inner — reversed in the circle's bottom half so the
      // name stays visually on top.
      const gap = fontPx * 1.15;
      const ord = flip ? -1 : 1;
      lines.push(lineAt(nameText, "name", rMid + (ord * gap) / 2), lineAt(marriageText, "years", rMid - (ord * gap) / 2));
    } else if (nameText) {
      lines.push(lineAt(nameText, "name", rMid));
    } else if (marriageText) {
      lines.push(lineAt(marriageText, "years", rMid));
    }

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
      branch,
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
    branches: rootBranches,
    width: 2 * rMax + PAD * 2,
    height: 2 * rMax + PAD * 2,
  };
}
