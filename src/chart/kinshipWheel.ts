// Contemporaries: every blood relative of one person, placed by how closely
// they are related rather than by pedigree position.
//
// Two layouts share one data pass:
//  - the **wheel**, a polar chart where the distance from the centre is the
//    blood distance (parent 1, sibling 2, uncle 3, first cousin 4 …), each
//    wedge is one of the root's grandparent lines, and the colour is the
//    generation offset;
//  - the **bars**, the same people as lifespan bars on a year axis, banded by
//    blood distance — which of them were alive at the same time, and how close.
//
// Blood distance, not generation offset, is the radius on purpose: generation
// offset puts every cousin of every degree on one ring (a real tree has
// hundreds of them there), so it separates nobody. Blood distance is the
// number of birth links between the two people, which is both the genealogical
// and the genetic sense of "how close".
//
// Everything here is pure: no React, no colours, no i18n beyond the caller's
// own `nameOf`. Colour and wording are the renderer's business.

import type { Dataset, Individual, Sex } from "../gedcom/types";
import { primaryName } from "../match/relatives";
import {
  LIVING_WINDOW_YEARS,
  birthYear,
  deathYear,
  deathDateText,
  estimateBirthYearFromNetwork,
  formatLifespan,
  isDeceased,
  isPresumedLiving,
} from "../gedcom/lifespan";

/** Which of the root's two parental lines a relative's blood runs through.
 *  "own" covers the root's parents, siblings and issue, whose line is both. */
export type KinSide = "father" | "mother" | "own";

/** The wedge key shared by the root's own household (parents, siblings, issue). */
export const OWN_BRANCH = "own";

/** Where a blood relative stands relative to the root: `up` generations to the
 *  nearest common ancestor, then `down` generations back to them. */
export interface KinPosition {
  up: number;
  down: number;
  /** The common ancestor the two meet at — the root themself for their issue. */
  viaId: string;
}

/** Birth links between the two people: parent 1, sibling 2, uncle 3, cousin 4. */
export const bloodDistance = (p: KinPosition): number => p.up + p.down;
/** Positive for the root's elders, negative for their issue, 0 for their own generation. */
export const generationOffset = (p: KinPosition): number => p.up - p.down;

interface AncestorLine {
  gen: number;
  side: KinSide;
  branch: string;
}

/** The person's parents, each tagged by the role they hold in the family
 *  record — HUSB/WIFE, not their own SEX, so a missing SEX still picks a side. */
function parentsOf(ds: Dataset, id: string): { id: string; role: "father" | "mother" }[] {
  const out: { id: string; role: "father" | "mother" }[] = [];
  for (const famId of ds.individuals.get(id)?.childOf ?? []) {
    const fam = ds.families.get(famId);
    if (!fam) continue;
    if (fam.husband) out.push({ id: fam.husband, role: "father" });
    if (fam.wife) out.push({ id: fam.wife, role: "mother" });
  }
  return out;
}

function childrenOf(ds: Dataset, id: string): string[] {
  const out: string[] = [];
  for (const famId of ds.individuals.get(id)?.spouseOf ?? []) {
    const fam = ds.families.get(famId);
    if (fam) out.push(...fam.children);
  }
  return out;
}

/** The root's ancestors, each carrying the side and the grandparent line their
 *  descendants belong to. Generations 0 and 1 (the root and their parents) hold
 *  no grandparent line of their own — their descendants are the root's siblings
 *  and issue, which share the central wedge. */
function ancestorLines(ds: Dataset, rootId: string): Map<string, AncestorLine> {
  const map = new Map<string, AncestorLine>([[rootId, { gen: 0, side: "own", branch: OWN_BRANCH }]]);
  const queue = [rootId];
  for (let i = 0; i < queue.length; i++) {
    const at = map.get(queue[i])!;
    for (const p of parentsOf(ds, queue[i])) {
      if (map.has(p.id)) continue;
      const gen = at.gen + 1;
      map.set(p.id, {
        gen,
        side: gen === 1 ? p.role : at.side,
        branch: gen === 1 ? OWN_BRANCH : gen === 2 ? p.id : at.branch,
      });
      queue.push(p.id);
    }
  }
  return map;
}

/**
 * Every blood relative of `rootId`, by their *closest* relationship — the path
 * with the fewest birth links, which is what pedigree collapse makes ambiguous.
 *
 * A blood path only ever runs up to a common ancestor and back down, so the
 * walk seeds one bucket per ancestor generation and then descends: a bucket's
 * index is the blood distance, so the first time a person is reached is by
 * their closest relationship and no comparison is needed.
 */
export function bloodKin(ds: Dataset, rootId: string): Map<string, KinPosition> {
  const out = new Map<string, KinPosition>();
  if (!ds.individuals.has(rootId)) return out;

  interface Step extends KinPosition { id: string }
  const buckets: Step[][] = [];
  const push = (m: number, step: Step) => (buckets[m] ??= []).push(step);

  // Sorted so pedigree collapse resolves the same way on every run.
  const seeds = [...ancestorLines(ds, rootId)].sort(
    (a, b) => a[1].gen - b[1].gen || (a[0] < b[0] ? -1 : 1),
  );
  for (const [id, line] of seeds) push(line.gen, { id, up: line.gen, down: 0, viaId: id });

  for (let m = 0; m < buckets.length; m++) {
    for (const step of buckets[m] ?? []) {
      if (out.has(step.id)) continue;
      out.set(step.id, { up: step.up, down: step.down, viaId: step.viaId });
      for (const childId of childrenOf(ds, step.id)) {
        if (!out.has(childId)) push(m + 1, { id: childId, up: step.up, down: step.down + 1, viaId: step.viaId });
      }
    }
  }
  return out;
}

/** The stretch of years a person is taken to have been alive for. */
export interface LifeSpan {
  /** Birth year, or one estimated from relatives when the record has none. */
  from?: number;
  /** Death year; for someone still presumed living, the current year. */
  to?: number;
  /** No recorded death: the bar's right end is a guess, not a fact. */
  openEnd: boolean;
  living: boolean;
}

/**
 * How long a person was around, for the "who was alive at the same time" test.
 * Undated ends fall back to the app's own rules rather than a second set: the
 * birth to {@link estimateBirthYearFromNetwork}, and an unrecorded death to
 * {@link LIVING_WINDOW_YEARS} after birth — the same span beyond which
 * {@link isPresumedLiving} stops believing someone is still here.
 */
export function lifeSpan(indi: Individual, ds: Dataset, now: number): LifeSpan {
  const living = isPresumedLiving(indi, ds, now);
  const from = birthYear(indi) ?? estimateBirthYearFromNetwork(indi, ds);
  const died = deathYear(indi);
  const to = died ?? (from === undefined ? undefined : Math.min(now, from + LIVING_WINDOW_YEARS));
  return { from, to, openEnd: died === undefined, living };
}

/** Whether the two stretches of years touch at all. */
export function overlaps(span: LifeSpan, from: number, to: number): boolean {
  if (span.from === undefined && span.to === undefined) return false;
  return (span.to ?? span.from!) >= from && (span.from ?? span.to!) <= to;
}

/** One blood relative, ready to draw in either layout. */
export interface KinPerson {
  id: string;
  indi: Individual;
  up: number;
  down: number;
  /** Birth links to the root: the wheel's ring, the bars' band. */
  distance: number;
  /** Generations above (+) or below (−) the root: the colour axis. */
  generation: number;
  /** The grandparent line this relative descends from — the wheel's wedge. */
  branch: string;
  side: KinSide;
  name: string;
  /** The given name alone — what the wheel writes beside a dot, where a full
   *  name with a married surname would crowd out three neighbours. Read from
   *  the parsed NAME rather than split off the display string, which puts the
   *  surname first under some name settings. */
  given: string;
  /** "1817–1921" / "1817" / "" — {@link formatLifespan}. */
  years: string;
  sex: Sex;
  span: LifeSpan;
}

export interface KinInput {
  ds: Dataset;
  rootId: string;
  /** How a name reads under the app's Name-display settings. */
  nameOf: (indi: Individual) => string;
  /** Keep only relatives whose life overlaps this window; omit for all of them. */
  window?: { from: number; to: number };
  /** Cap on blood distance — the shared Generations setting. */
  maxDistance?: number;
  now?: number;
}

/**
 * The deepest blood distance in scope, ignoring any cap — what the Generations
 * stepper counts "of". It must ignore the cap: measuring the capped set makes
 * the maximum equal the cap, so stepping down to one hides the control that
 * would step back up.
 */
export function kinDepth(input: KinInput): number {
  let max = 1;
  for (const p of collectKin({ ...input, maxDistance: undefined })) {
    if (p.distance > max) max = p.distance;
  }
  return max;
}

/** Every blood relative in scope, the root included, closest first. */
export function collectKin(input: KinInput): KinPerson[] {
  const { ds, rootId, nameOf, window: win, maxDistance } = input;
  const now = input.now ?? new Date().getFullYear();
  const lines = ancestorLines(ds, rootId);
  const out: KinPerson[] = [];

  for (const [id, pos] of bloodKin(ds, rootId)) {
    const indi = ds.individuals.get(id);
    if (!indi) continue;
    const distance = bloodDistance(pos);
    if (maxDistance !== undefined && distance > maxDistance) continue;
    const span = lifeSpan(indi, ds, now);
    if (win && id !== rootId && !overlaps(span, win.from, win.to)) continue;
    const line = lines.get(pos.viaId);
    const name = nameOf(indi);
    out.push({
      id,
      indi,
      up: pos.up,
      down: pos.down,
      distance,
      generation: generationOffset(pos),
      branch: line?.branch ?? OWN_BRANCH,
      side: line?.side ?? "own",
      name,
      given: primaryName(indi)?.given?.trim() || name.split(/\s+/)[0] || name,
      years: formatLifespan(birthYear(indi), deathYear(indi), isDeceased(indi)),
      sex: indi.sex,
      span,
    });
  }
  out.sort((a, b) => a.distance - b.distance || (a.span.from ?? 9999) - (b.span.from ?? 9999) || (a.id < b.id ? -1 : 1));
  return out;
}

// ── The wheel ────────────────────────────────────────────────────────────────

/** Dot radius for the innermost rings, where there is room, and for the rest. */
const DOT_NEAR = 4.6;
const DOT_FAR = 3.0;
/** Rings this close to the root get the bigger dots and a name. */
const NEAR_RING = 3;
/** Gap between one relative and the next along a ring. */
const DOT_GAP = 1.5;
/** Empty core, so the root's own marker has room. */
const HUB_R = 42;
/** A ring with people in it never gets thinner than this; the close rings, which
 *  hold only a handful, get the generous floor so their names have somewhere
 *  to sit. Purely count-driven bands leave them hairline-thin. */
const RING_MIN = 9;
const RING_MIN_NEAR = 26;
/** Gutters: the root's own wedge at 12 o'clock, the ring scale at 6 o'clock. */
const OWN_WEDGE_MIN = 36;
const OWN_WEDGE_MAX = 52;
const SCALE_GUTTER = 46;
/** How much arc a ring's caption may occupy: the half of the 6 o'clock gutter
 *  left of the axis, since the caption is right-aligned onto it. Renderers
 *  measure their own text against `r * this` and fall back to the bare number,
 *  which is the only way to keep a caption out of the wedge beside it. */
export const RING_LABEL_ARC = ((SCALE_GUTTER / 2) * Math.PI) / 180;
const WEDGE_GAP = 2.2;
/** Smallest wedge a branch may be squeezed into, however few people it holds. */
const WEDGE_MIN = 20;

export interface WheelWedge {
  key: string;
  side: KinSide;
  /** The grandparent whose line this is; absent for the root's own wedge. */
  ancestorId?: string;
  count: number;
  /** Degrees, clockwise, with −90 at 12 o'clock. */
  a0: number;
  a1: number;
  /** Where the wedge's caption sits, outside the rim. */
  labelX: number;
  labelY: number;
  labelAnchor: "start" | "middle" | "end";
}

export interface WheelRing {
  distance: number;
  /** Mid-radius, where the dots sit, and the band's outer edge. */
  r: number;
  rOuter: number;
  count: number;
  /** Arc across the 6 o'clock gutter that the ring's caption is set on. */
  pathD: string;
  /** Distance along that arc for a caption right-aligned on the axis. */
  textOffset: number;
}

export interface WheelDot {
  person: KinPerson;
  x: number;
  y: number;
  r: number;
}

export interface WheelLabel {
  person: KinPerson;
  x: number;
  y: number;
  anchor: "start" | "end";
  text: string;
}

export interface KinshipWheelChart {
  cx: number;
  cy: number;
  radius: number;
  width: number;
  height: number;
  people: KinPerson[];
  dots: WheelDot[];
  labels: WheelLabel[];
  rings: WheelRing[];
  wedges: WheelWedge[];
  maxDistance: number;
}

const rad = (deg: number) => (deg * Math.PI) / 180;

/** Ring bands, water-filled: every occupied ring clears its floor, and what is
 *  left is shared out by how many people the ring holds. */
function ringRadii(counts: number[], maxD: number, avail: number): number[] {
  const weight = (m: number) => 0.55 + Math.sqrt(counts[m] ?? 0);
  const floor = (m: number) => ((counts[m] ?? 0) === 0 ? 4 : m <= 5 ? RING_MIN_NEAR : RING_MIN);
  const total = Array.from({ length: maxD }, (_, i) => weight(i + 1)).reduce((a, b) => a + b, 0) || 1;
  const px: number[] = [];
  for (let m = 1; m <= maxD; m++) px[m] = (avail * weight(m)) / total;
  for (let pass = 0; pass < 5; pass++) {
    const pinned: boolean[] = [];
    let used = 0;
    let free = 0;
    for (let m = 1; m <= maxD; m++) {
      if (px[m] < floor(m)) { pinned[m] = true; used += floor(m); } else free += weight(m);
    }
    const rest = Math.max(0, avail - used);
    if (!free) break;
    for (let m = 1; m <= maxD; m++) px[m] = pinned[m] ? floor(m) : (rest * weight(m)) / free;
  }
  const edges = [HUB_R];
  for (let m = 1; m <= maxD; m++) edges[m] = edges[m - 1] + px[m];
  return edges;
}

/** Wedge angles. The root's own line straddles 12 o'clock; the father's blood
 *  fills the left half and the mother's the right, and inside each half the
 *  grandfather's line sits above the grandmother's. */
function layoutWedges(people: KinPerson[], ds: Dataset): Omit<WheelWedge, "labelX" | "labelY" | "labelAnchor">[] {
  const counts = new Map<string, { side: KinSide; n: number }>();
  for (const p of people) {
    if (p.distance === 0) continue;
    const at = counts.get(p.branch) ?? { side: p.side, n: 0 };
    at.n += 1;
    counts.set(p.branch, at);
  }
  const ofSide = (side: KinSide) =>
    [...counts]
      .filter(([key, v]) => key !== OWN_BRANCH && v.side === side)
      // Grandfather's line above the grandmother's, read off the record rather
      // than off the order the file happened to list the grandparents in.
      .sort((a, b) => sexRank(ds.individuals.get(a[0])?.sex) - sexRank(ds.individuals.get(b[0])?.sex)
        || (a[0] < b[0] ? -1 : 1))
      .map(([key, v]) => ({ key, side, count: v.n, ancestorId: key }));

  const father = ofSide("father");
  const mother = ofSide("mother");
  const ownCount = counts.get(OWN_BRANCH)?.n ?? 0;
  const ownSpan = Math.max(OWN_WEDGE_MIN, Math.min(OWN_WEDGE_MAX, 7 * Math.sqrt(Math.max(1, ownCount))));
  const half = 180 - ownSpan / 2 - SCALE_GUTTER / 2 - WEDGE_GAP * 2;

  const out: Omit<WheelWedge, "labelX" | "labelY" | "labelAnchor">[] = [
    { key: OWN_BRANCH, side: "own", count: ownCount, a0: -90 - ownSpan / 2, a1: -90 + ownSpan / 2 },
  ];
  const spread = (
    list: { key: string; side: KinSide; count: number; ancestorId: string }[],
    from: number,
    dir: 1 | -1,
  ) => {
    if (!list.length) return;
    const free = half - WEDGE_GAP * (list.length - 1);
    const total = list.reduce((a, b) => a + b.count, 0) || 1;
    const raw = list.map((b) => Math.max(WEDGE_MIN, (free * b.count) / total));
    const scale = free / raw.reduce((a, b) => a + b, 0);
    let cur = from;
    list.forEach((b, i) => {
      const span = raw[i] * scale;
      out.push({ ...b, a0: dir > 0 ? cur : cur - span, a1: dir > 0 ? cur + span : cur });
      cur += dir * (span + WEDGE_GAP);
    });
  };
  spread(mother, -90 + ownSpan / 2 + WEDGE_GAP, 1);
  spread(father, -90 - ownSpan / 2 - WEDGE_GAP, -1);
  return out;
}

const sexRank = (sex: Sex | undefined) => (sex === "F" ? 1 : 0);

/**
 * Place every relative on the wheel. Callers pass `people` to reuse one pass;
 * the wheel is always built from *everyone* in scope, so hiding a group from
 * the colour key never shifts what is left.
 *
 * Within one wedge-and-ring cell the
 * sub-rows are grouped by generation, elders on the inner row and issue on the
 * outer — a ring holds both directions at once (distance 1 is your parents
 * *and* your children), and wrapping them together reads as noise.
 */
export function buildKinshipWheel(input: KinInput & { people?: KinPerson[] }): KinshipWheelChart {
  const people = input.people ?? collectKin(input);
  const maxDistance = Math.max(1, ...people.map((p) => p.distance));
  // A bigger tree gets a bigger chart rather than denser dots: the canvas
  // scrolls and zooms, so the honest move is more room, not smaller marks.
  const radius = Math.round(Math.max(360, Math.min(900, 260 + Math.sqrt(people.length) * 4)));
  const pad = 130;
  const cx = radius + pad;
  const cy = radius + pad;

  const counts: number[] = [];
  for (const p of people) counts[p.distance] = (counts[p.distance] ?? 0) + 1;
  const edges = ringRadii(counts, maxDistance, radius - HUB_R);

  const wedges = layoutWedges(people, input.ds).map((w) => {
    const mid = rad((w.a0 + w.a1) / 2);
    const lr = radius + 16;
    const cos = Math.cos(mid);
    return {
      ...w,
      labelX: cx + lr * cos,
      labelY: cy + lr * Math.sin(mid) + 4,
      labelAnchor: (cos > 0.2 ? "start" : cos < -0.2 ? "end" : "middle") as "start" | "middle" | "end",
    };
  });
  const wedgeByKey = new Map(wedges.map((w) => [w.key, w]));

  const dots: WheelDot[] = [];
  const candidates: { person: KinPerson; x: number; y: number; ux: number; uy: number; text: string }[] = [];

  // Bucket by wedge and ring, then lay each cell out along its arc.
  const cells = new Map<string, KinPerson[]>();
  for (const p of people) {
    if (p.distance === 0) continue;
    const key = `${p.branch}|${p.distance}`;
    const at = cells.get(key);
    if (at) at.push(p); else cells.set(key, [p]);
  }

  for (const [key, cell] of cells) {
    const [branch, dStr] = key.split("|");
    const m = Number(dStr);
    const wedge = wedgeByKey.get(branch);
    if (!wedge) continue;
    const rMid = (edges[m] + edges[m - 1]) / 2;
    const band = edges[m] - edges[m - 1];
    const spanDeg = wedge.a1 - wedge.a0;
    const dotR = m <= NEAR_RING ? DOT_NEAR : DOT_FAR;
    const step = dotR * 2 + DOT_GAP;
    const perRow = Math.max(1, Math.floor((rad(spanDeg) * rMid) / step));

    const laid = subRows(cell, perRow);
    const gap = Math.min(step, (band - 2) / Math.max(1, laid.length));
    for (const [rowIndex, row] of laid.entries()) {
      const rr = rMid + (rowIndex - (laid.length - 1) / 2) * gap;
      row.forEach((p, col) => {
        const a = rad(wedge.a0 + (spanDeg * (col + 0.5)) / row.length);
        const cos = Math.cos(a);
        const sin = Math.sin(a);
        dots.push({ person: p, x: cx + rr * cos, y: cy + rr * sin, r: dotR });
        if (m <= NEAR_RING + 3) {
          candidates.push({
            person: p,
            x: cx + (rr + dotR + 4) * cos,
            y: cy + (rr + dotR + 4) * sin + 3,
            ux: cos,
            uy: sin,
            text: p.given,
          });
        }
      });
    }
  }

  const rings: WheelRing[] = [];
  let lastY = -Infinity;
  for (let m = 1; m <= maxDistance; m++) {
    const r = (edges[m] + edges[m - 1]) / 2;
    if (cy + r - lastY < 11) continue;
    lastY = cy + r;
    // The scale is set on the ring itself, right-aligned to the 6 o'clock axis
    // so the captions form one column instead of running into the wedge beside it.
    const from = 148;
    const to = 32;
    const pts: string[] = [];
    for (let i = 0; i <= 24; i++) {
      const a = rad(from + ((to - from) * i) / 24);
      pts.push(`${(cx + r * Math.cos(a)).toFixed(1)} ${(cy + r * Math.sin(a)).toFixed(1)}`);
    }
    rings.push({
      distance: m,
      r,
      rOuter: edges[m],
      count: counts[m] ?? 0,
      pathD: `M${pts.join("L")}`,
      textOffset: (r * rad(from - to)) / 2 - 4,
    });
  }

  return {
    cx,
    cy,
    radius,
    width: cx + radius + pad,
    height: cy + radius + pad,
    people,
    dots,
    labels: placeLabels(candidates),
    rings,
    wedges,
    maxDistance,
  };
}

/** Split one cell into sub-rows: a row per generation where that fits, so the
 *  elders sit inside and the issue outside, and a plain wrap when it does not
 *  (a crowded ring would spend half its band on rounding). */
function subRows(cell: KinPerson[], perRow: number): KinPerson[][] {
  const byGen = new Map<number, KinPerson[]>();
  for (const p of cell) {
    const at = byGen.get(p.generation);
    if (at) at.push(p); else byGen.set(p.generation, [p]);
  }
  const gens = [...byGen.keys()].sort((a, b) => b - a);
  const flatRows = Math.max(1, Math.ceil(cell.length / perRow));
  const grouped = gens.reduce((n, g) => n + Math.ceil(byGen.get(g)!.length / perRow), 0);

  const rows: KinPerson[][] = [];
  if (cell.length <= 30 || grouped <= flatRows + 2) {
    for (const g of gens) {
      const list = byGen.get(g)!;
      const n = Math.ceil(list.length / perRow);
      const width = Math.ceil(list.length / n);
      for (let i = 0; i < n; i++) rows.push(list.slice(i * width, (i + 1) * width));
    }
  } else {
    const flat = gens.flatMap((g) => byGen.get(g)!);
    const width = Math.ceil(flat.length / flatRows);
    for (let i = 0; i < flatRows; i++) rows.push(flat.slice(i * width, (i + 1) * width));
  }
  return rows;
}

/** Native-size font the wheel's names are measured against. */
export const WHEEL_LABEL_PX = 10.5;
const NUDGE = [0, 12, -12, 24, -24, 36];

/** Name as many relatives as fit. Closest kin get first claim on the space, and
 *  a name that would collide slides out along its own ray before it is dropped —
 *  so a knot like three children of the same parents resolves into a stack
 *  instead of one survivor. */
function placeLabels(
  candidates: { person: KinPerson; x: number; y: number; ux: number; uy: number; text: string }[],
): WheelLabel[] {
  const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
  const hits = (b: { x0: number; x1: number; y0: number; y1: number }) =>
    placed.some((o) => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0);

  const out: WheelLabel[] = [];
  for (const c of [...candidates].sort((a, b) => a.person.distance - b.person.distance)) {
    const w = c.text.length * WHEEL_LABEL_PX * 0.55;
    const anchor: "start" | "end" = c.ux > 0 ? "start" : "end";
    for (const d of NUDGE) {
      const x = c.x + c.ux * d;
      const y = c.y + c.uy * d;
      const x0 = anchor === "end" ? x - w - 3 : x - 3;
      const box = { x0, x1: x0 + w + 6, y0: y - WHEEL_LABEL_PX * 0.85, y1: y + WHEEL_LABEL_PX * 0.3 };
      if (hits(box)) continue;
      placed.push(box);
      out.push({ person: c.person, x, y, anchor, text: c.text });
      break;
    }
  }
  return out;
}

// ── The bars ─────────────────────────────────────────────────────────────────

/** Row height per ring. The close rings are sized for their text rather than
 *  the text being squeezed into them — a named row needs about 1.5× its font
 *  or the descenders sit on the line below. */
const BAR_ROW_H: Record<number, number> = { 0: 18, 1: 18, 2: 18, 3: 14, 4: 11, 5: 9.5, 6: 7, 7: 5.2 };
/** Rings at least this tall carry a name in the margin. */
export const BAR_NAMED_H = 9.5;
/** Height the thousands of distant cousins share out between them. */
const BAR_BUDGET = 13000;
const BAR_GAP = 26;
export const BAR_LEFT = 168;
const BAR_RIGHT = 30;
const BAR_AXIS_H = 62;
/** Room kept left of the earliest named person, so their name has a margin to
 *  hang in instead of being thrown to the far side of its own bar. */
const BAR_NAME_GUTTER = 190;

export interface KinBand {
  distance: number;
  count: number;
  /** Top of the band's first row. */
  y: number;
  rowH: number;
  rows: { person: KinPerson; y: number; x0: number; x1: number; named: boolean }[];
}

export interface KinBarsChart {
  width: number;
  height: number;
  /** Height of the sticky header: the year axis plus the root's own band. */
  headerHeight: number;
  minYear: number;
  maxYear: number;
  ticks: number[];
  xOf: (year: number) => number;
  bands: KinBand[];
  people: KinPerson[];
}

export function buildKinBars(input: KinInput & { width: number; people?: KinPerson[] }): KinBarsChart {
  const now = input.now ?? new Date().getFullYear();
  const people = (input.people ?? collectKin(input)).filter(
    (p) => p.span.from !== undefined || p.span.to !== undefined,
  );
  const byRing = new Map<number, KinPerson[]>();
  for (const p of people) {
    const at = byRing.get(p.distance);
    if (at) at.push(p); else byRing.set(p.distance, [p]);
  }
  const rings = [...byRing.keys()].sort((a, b) => a - b);

  let fixed = 0;
  let thinRows = 0;
  for (const m of rings) {
    const h = BAR_ROW_H[m];
    if (h) fixed += byRing.get(m)!.length * h; else thinRows += byRing.get(m)!.length;
  }
  const thin = thinRows
    ? Math.max(1.9, Math.min(3.4, (BAR_BUDGET - fixed - rings.length * BAR_GAP) / thinRows))
    : 3;
  const rowH = (m: number) => BAR_ROW_H[m] ?? thin;

  const start = (p: KinPerson) => p.span.from ?? p.span.to!;
  const end = (p: KinPerson) => p.span.to ?? p.span.from!;
  const maxYear = Math.max(now, ...people.map(end));
  let minYear = Math.min(...people.map(start));
  const inner = input.width - BAR_LEFT - BAR_RIGHT;
  const named = people.filter((p) => rowH(p.distance) >= BAR_NAMED_H);
  if (named.length) {
    const earliest = Math.min(...named.map(start));
    const span = maxYear - minYear;
    const have = (inner * (earliest - minYear)) / (span || 1);
    if (have < BAR_NAME_GUTTER && inner > BAR_NAME_GUTTER) {
      minYear -= (BAR_NAME_GUTTER * span - inner * (earliest - minYear)) / (inner - BAR_NAME_GUTTER);
    }
  }
  const xOf = (year: number) => BAR_LEFT + (inner * (year - minYear)) / (maxYear - minYear || 1);

  const step = maxYear - minYear > 400 ? 100 : maxYear - minYear > 150 ? 50 : 20;
  const ticks: number[] = [];
  for (let y = Math.ceil(minYear / step) * step; y <= maxYear; y += step) ticks.push(y);

  const bands: KinBand[] = [];
  let y = BAR_AXIS_H;
  for (const m of rings) {
    const list = byRing.get(m)!;
    const h = rowH(m);
    bands.push({
      distance: m,
      count: list.length,
      y,
      rowH: h,
      rows: list.map((p, i) => {
        const x0 = xOf(start(p));
        return { person: p, y: y + i * h, x0, x1: Math.max(x0 + 2, xOf(end(p))), named: h >= BAR_NAMED_H };
      }),
    });
    y += list.length * h + BAR_GAP;
  }
  const root = bands.find((b) => b.distance === 0);

  return {
    width: input.width,
    height: y + 20,
    headerHeight: BAR_AXIS_H + (root ? root.count * root.rowH + BAR_GAP : 8),
    minYear,
    maxYear,
    ticks,
    xOf,
    bands,
    people,
  };
}

/** The name written beside a bar: small rows drop the years, which the tooltip
 *  carries anyway, so more of them fit in the margin. */
export function barNameFont(rowH: number): number {
  return Math.max(6.5, Math.min(11, rowH * 0.62));
}

export function barNameText(person: KinPerson, font: number): string {
  return font < 8 || !person.years ? person.name : `${person.name}  ${person.years}`;
}

/** Full-date hover text for a bar or dot, matching the other charts' tooltips. */
export function kinTooltip(person: KinPerson): string {
  const died = deathDateText(person.indi);
  return [person.name, person.years || died].filter(Boolean).join(" · ");
}
