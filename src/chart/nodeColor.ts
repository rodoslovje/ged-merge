// The charts' Color setting: what a person's fill says. One axis at a time,
// chosen in the chart popover and shared by every chart that draws people —
// the pedigree boxes and wedges, the Timeline bars, the Relationship boxes,
// the Contemporaries dots. A "colorer" is built once per chart from the people
// on it: it sorts each person into a category (a generation, a country, an age
// band, …), hands every category a colour, and lists the categories as the
// legend. Categorical axes spread evenly spaced hues over the most frequent
// values (the rest fold into "other"); numeric axes bucket the value and run a
// ramp over the buckets.
//
// Pure: the hosts pass the people, the dataset and the translator in.

import type { Dataset, Individual, Sex } from "../gedcom/types";
import { birthDateOf, birthYear, isDeceased, isPresumedLiving } from "../gedcom/lifespan";
import { ageBetween, lifespanAge } from "../gedcom/age";
import { localityParts } from "../gedcom/place";
import { placeCountryFacet, countryFacetLabel } from "../geo/placeCountry";
import { findEvent, primaryName } from "../match/relatives";
import type { Translate } from "../locales/i18n";
import type { TreeMode, TreeNode } from "./personTree";
import { splitParents, type FanSegment } from "./fanLayout";
import { OWN_BRANCH } from "./kinshipWheel";

export type ColorAxis =
  | "plain"
  | "generation"
  | "branch"
  | "sex"
  | "living"
  | "country"
  | "birthPlace"
  | "surname"
  | "parentAge"
  | "lifespan"
  | "century"
  | "sources";

/** The axes in popover order. */
export const COLOR_AXES: ColorAxis[] = [
  "plain", "living", "generation", "branch", "sex",
  "country", "birthPlace", "surname",
  "parentAge", "lifespan", "century", "sources",
];

/**
 * The axes a *group* of people can answer exactly, because they read nothing
 * off a person but where they stand in the tree and what they are called.
 *
 * A chart that draws one mark per person can offer every axis. One that draws a
 * mark per group — the Contemporaries surname rings, where a band is a surname
 * in one family line at one generation — can only offer these: on any other,
 * the band holds men and women, living and dead, four countries, and a single
 * fill would have to speak for a majority and quietly misreport the rest.
 */
export const GROUP_AXES: ColorAxis[] = ["plain", "generation", "branch", "surname"];

/**
 * What a chart can colour its people by. A chart that paints them by something
 * of its own — the Compare tree's match status — takes `none` and is offered
 * no Color setting at all. A chart that knows each person's generation but not
 * the family line they come down through — the Timeline's rows, the
 * Relationship chart's path — takes `noBranch`: a line axis there would paint
 * every person the one colour. A chart that draws one mark per group — the
 * Contemporaries surname rings — takes `group` and offers {@link GROUP_AXES}.
 * Everything else offers the lot.
 */
export type ColorAxisScope = "all" | "noBranch" | "group" | "none";

/** The axes a chart of this scope offers, in popover order. */
export function colorAxesFor(scope: ColorAxisScope): ColorAxis[] {
  if (scope === "none") return [];
  if (scope === "group") return GROUP_AXES;
  return scope === "noBranch" ? COLOR_AXES.filter((a) => a !== "branch") : COLOR_AXES;
}

/** The axis to colour by on a chart of this scope: the chosen one, or "plain"
 *  when that chart cannot honour it (a stored choice made on another chart). */
export function axisWithin(axis: ColorAxis, scope: ColorAxisScope): ColorAxis {
  return colorAxesFor(scope).includes(axis) ? axis : "plain";
}

/** A stored axis, or "plain" for anything else. */
export function sanitizeColorAxis(v: unknown): ColorAxis {
  // The two parents' ages were separate axes for a day.
  if (v === "motherAge" || v === "fatherAge") return "parentAge";
  return (COLOR_AXES as readonly unknown[]).includes(v) ? (v as ColorAxis) : "plain";
}

/** How strongly a person's colour tints their box or wedge while a Color
 *  axis is in force — well past the plain chart's 16 %, so the categories
 *  read apart at a glance and the names still read on top. */
export const AXIS_TINT = 38;

/** Where a person sits on the chart: generations above (+) or below (−) the
 *  root, and the line they belong to — a grandparent's id above, a child of
 *  the root's id below, {@link OWN_BRANCH} for the root, their spouses and
 *  their parents. The same keys the Contemporaries wheel uses. */
export interface NodePosition {
  gen: number;
  branch: string;
  /** The person rides beside the line rather than on it — a spouse's band on
   *  a descendant fan — so the axes that read the chart have nothing to say
   *  about them: they are of no generation of the tree and of no line. Such a
   *  person falls out of those axes' categories (and out of their legend
   *  counts); the host paints them neutral. */
  offLine?: boolean;
}

/** The axes that read where a person sits on the chart rather than what their
 *  record says. A spouse riding beside the line can answer none of them, so
 *  these are the axes where their band stays neutral; on a record axis the
 *  band takes the spouse's own colour — where they were born is exactly what
 *  the axis is for. ("plain" reads neither, and belongs here for the hosts
 *  that paint an off-line person neutral on all three.) */
export const CHART_AXES: ReadonlySet<ColorAxis> = new Set<ColorAxis>(["plain", "generation", "branch"]);

/** A branch's colour and name, resolved by the host that knows the tree. */
export interface BranchInfo {
  label: string;
  color: string;
}

export interface LegendEntry {
  key: string;
  label: string;
  color: string;
  count: number;
}

export interface NodeColorer {
  axis: ColorAxis;
  /** The category a person falls into — `""` when the axis has nothing to
   *  say about them (no birth place, no parent, living on the lifespan axis). */
  categoryOf: (indi: Individual | undefined, pos?: NodePosition) => string;
  /** The category's colour; undefined on the plain axis, so the host keeps
   *  its own default. */
  colorOf: (category: string) => string | undefined;
  /** A person's colour, the whole way from the record — what every host
   *  actually wants. Undefined on the plain axis, so `?? own default` reads
   *  as "the chart's own colouring". */
  colorFor: (indi: Individual | undefined, pos?: NodePosition) => string | undefined;
  legend: LegendEntry[];
}

export interface ColorContext {
  ds: Dataset;
  t: Translate;
  lang: string;
  /** The file's home country (ISO code, lower case): a place naming no
   *  country is taken to lie there. `""` to assume nothing. */
  home: string;
  /** Colour and name per branch key on this chart (see {@link NodePosition}). */
  branches?: Map<string, BranchInfo>;
  now?: number;
}

/** A person to colour, as the host draws them. */
export interface ColorSubject {
  indi?: Individual;
  pos?: NodePosition;
}

// ─── Palette ──────────────────────────────────────────────────────────────────

/** Hue `i` of `n` evenly spaced around the colour wheel — the sweep stops
 *  short of a full turn so the last never matches the first; lightness and
 *  chroma come from the theme. */
export function categoryColor(i: number, n: number): string {
  const hue = Math.round(25 + (i * 320) / Math.max(n, 1));
  return `oklch(var(--fan-branch-l) var(--fan-branch-c) ${hue})`;
}

/** Line `i` of `n` on one side of the root, spread evenly along that side's
 *  generation ramp — the ancestors' lines run from the parents' colour to the
 *  deepest ancestors', the descendants' from the children's to the furthest
 *  descendants' — so the Family line axis and the Generation axis share one
 *  palette per side. */
export function lineColor(i: number, n: number, direction: TreeMode): string {
  const t = n <= 1 ? 0 : i / (n - 1);
  const [near, far] = direction === "ancestors" ? ["--kin-anc-near", "--kin-anc-far"] : ["--kin-desc-near", "--kin-desc-far"];
  return `color-mix(in oklch, var(${far}) ${(t * 100).toFixed(1)}%, var(${near}))`;
}

const OWN_COLOR = "var(--accent)";
const UNKNOWN_COLOR = "var(--faint)";
const SEX_COLOR: Record<Sex, string> = { M: "var(--sex-male)", F: "var(--sex-female)", U: UNKNOWN_COLOR };

/** Generation colour, mixed between the theme's two ramp ends so it reads on
 *  paper as well as on the dark. Each direction is scaled to the range actually
 *  on screen — a tree can reach twelve generations up and three down, and one
 *  shared span squeezes every descendant step into a few degrees of hue.
 *  Eased, so the crowded first steps still separate. */
export function generationColor(g: number, up: number, down: number): string {
  if (g === 0) return "var(--kin-gen-0)";
  const n = g > 0 ? up : down;
  const t = n <= 1 ? 0 : Math.pow(Math.min(1, (Math.abs(g) - 1) / (n - 1)), 0.7);
  const [near, far] = g > 0 ? ["--kin-anc-near", "--kin-anc-far"] : ["--kin-desc-near", "--kin-desc-far"];
  return `color-mix(in oklch, var(${far}) ${(t * 100).toFixed(1)}%, var(${near}))`;
}

/** A three-stop ramp: `lo` at 0, the neutral generation colour at ½, `hi` at 1. */
function ramp(t: number, lo: string, hi: string): string {
  const x = Math.max(0, Math.min(1, t));
  return x < 0.5
    ? `color-mix(in oklch, var(--kin-gen-0) ${(x * 200).toFixed(1)}%, ${lo})`
    : `color-mix(in oklch, ${hi} ${((x - 0.5) * 200).toFixed(1)}%, var(--kin-gen-0))`;
}

const BAD = "var(--danger)";
const GOOD = "var(--accent)";

/** Categories past this many fold into "other" — more hues than that stop
 *  telling apart. */
const MAX_CATEGORIES = 12;
const OTHER = "\u0000other";

// ─── Per-person readings ─────────────────────────────────────────────────────

// Burial last: someone buried in a country is taken to have lived there.
const PLACE_TAGS = ["BIRT", "RESI", "DEAT", "BURI"] as const;

/** The country of the first of birth, residence, death and burial that names a place. */
function countryOf(indi: Individual, home: string): string {
  for (const tag of PLACE_TAGS) {
    const place = findEvent(indi, tag)?.place;
    if (place?.raw.trim()) return placeCountryFacet(place.raw) || home;
  }
  return "";
}

function birthPlaceOf(indi: Individual): string {
  const place = findEvent(indi, "BIRT")?.place;
  return place ? (localityParts(place)[0] ?? "") : "";
}

function surnameOf(indi: Individual): string {
  return primaryName(indi)?.surname?.trim() ?? "";
}

/** The parents' age when this person was born — the average of the two, or
 *  whichever one is known — from the first birth family. */
function parentAgeOf(indi: Individual, ds: Dataset): number | undefined {
  const fam = indi.childOf.length ? ds.families.get(indi.childOf[0]) : undefined;
  if (!fam) return undefined;
  const ages: number[] = [];
  for (const id of [fam.husband, fam.wife]) {
    const parent = id ? ds.individuals.get(id) : undefined;
    const age = parent ? ageBetween(birthDateOf(parent), birthDateOf(indi)) : undefined;
    if (age !== undefined) ages.push(age);
  }
  return ages.length ? ages.reduce((a, b) => a + b, 0) / ages.length : undefined;
}

/** How much of the person's life is sourced: the share of their recorded
 *  birth, death and marriages that carry a citation. Undefined with none of
 *  those events recorded. */
function sourcedShareOf(indi: Individual, ds: Dataset): number | undefined {
  let total = 0;
  let cited = 0;
  const count = (e: { sources?: unknown[] } | undefined) => {
    if (!e) return;
    total++;
    if (e.sources?.length) cited++;
  };
  count(findEvent(indi, "BIRT"));
  count(findEvent(indi, "DEAT"));
  for (const fid of indi.spouseOf) {
    const fam = ds.families.get(fid);
    if (fam) count(fam.events.find((e) => e.tag === "MARR"));
  }
  return total ? cited / total : undefined;
}

// ─── Buckets for the numeric axes ────────────────────────────────────────────

/** Bucket width per numeric axis, in the value's unit. The buckets present
 *  on a chart take evenly spaced hues in value order — a sweep round the
 *  wheel keeps the order legible and tells neighbours apart far better than
 *  a two-colour ramp did. */
const NUMERIC: Partial<Record<ColorAxis, number>> = {
  parentAge: 5,
  lifespan: 10,
  century: 100,
};

function bucketKey(value: number, step: number): string {
  return String(Math.floor(value / step) * step);
}

// ─── The colorer ─────────────────────────────────────────────────────────────

export function createNodeColorer(axis: ColorAxis, ctx: ColorContext, subjects: Iterable<ColorSubject>): NodeColorer {
  const { ds, t, lang } = ctx;
  const now = ctx.now ?? new Date().getFullYear();
  const numeric = NUMERIC[axis];

  const readCategory = (indi: Individual | undefined, pos?: NodePosition): string => {
    // A spouse riding beside the line is of no generation and of no line.
    if (pos?.offLine && CHART_AXES.has(axis)) return "";
    switch (axis) {
      case "plain": return "";
      case "generation": return pos ? String(pos.gen) : "";
      case "branch": return pos?.branch ?? "";
      case "sex": return indi?.sex ?? "";
      case "living": return indi ? (isPresumedLiving(indi, ds, now) ? "living" : "deceased") : "";
      case "country": return indi ? countryOf(indi, ctx.home) : "";
      case "birthPlace": return indi ? birthPlaceOf(indi) : "";
      case "surname": return indi ? surnameOf(indi) : "";
      case "sources": {
        const share = indi ? sourcedShareOf(indi, ds) : undefined;
        return share === undefined ? "" : share === 0 ? "none" : share < 1 ? "some" : "all";
      }
      default: {
        if (!indi || !numeric) return "";
        const v =
          axis === "parentAge" ? parentAgeOf(indi, ds)
            : axis === "lifespan" ? (isDeceased(indi) ? lifespanAge(indi) : undefined)
              : birthYear(indi);
        return v === undefined ? "" : bucketKey(v, numeric);
      }
    }
  };

  // The record-reading axes cost real work per person — a living check can walk
  // the family network to estimate a birth year, a country parses a place, the
  // parents' age resolves a family — and the hosts ask for the same person
  // again on every render, more than once per drawn node. Their reading depends
  // on the record alone, never on where the chart puts them, so it is read once
  // per person and kept. The chart-reading axes are a field read and need no
  // cache (and must not have one: a repeated ancestor sits at two generations).
  const perRecord = !CHART_AXES.has(axis);
  // Keyed by the record itself, not by its id: the charts hand the same
  // `Individual` object back on every pass, and identity cannot go stale the
  // way an id shared by two objects could.
  const cache = new Map<Individual, string>();
  const categoryOf = (indi: Individual | undefined, pos?: NodePosition): string => {
    if (!perRecord || !indi) return readCategory(indi, pos);
    const hit = cache.get(indi);
    if (hit !== undefined) return hit;
    const k = readCategory(indi, pos);
    cache.set(indi, k);
    return k;
  };

  // Count the categories on the chart; the root of the legend and of the
  // "other" fold.
  const counts = new Map<string, number>();
  let up = 1;
  let down = 1;
  for (const s of subjects) {
    const k = categoryOf(s.indi, s.pos);
    counts.set(k, (counts.get(k) ?? 0) + 1);
    if (s.pos) {
      if (s.pos.gen > up) up = s.pos.gen;
      if (-s.pos.gen > down) down = -s.pos.gen;
    }
  }
  counts.delete("");

  // Order: numeric axes by value, generations top-down, sex and living in a
  // fixed order, everything else by how many people carry the value.
  const FIXED: Partial<Record<ColorAxis, string[]>> = {
    sex: ["M", "F", "U"],
    living: ["living", "deceased"],
    sources: ["none", "some", "all"],
  };
  let keys = [...counts.keys()];
  if (numeric) keys.sort((a, b) => Number(a) - Number(b));
  else if (axis === "generation") keys.sort((a, b) => Number(b) - Number(a));
  else if (FIXED[axis]) keys = FIXED[axis]!.filter((k) => counts.has(k));
  else keys.sort((a, b) => counts.get(b)! - counts.get(a)!);

  // The open-ended categorical axes fold their long tail into "other".
  const folds = axis === "country" || axis === "birthPlace" || axis === "surname";
  const kept = folds && keys.length > MAX_CATEGORIES ? keys.slice(0, MAX_CATEGORIES - 1) : keys;
  const foldedKeys = folds ? keys.slice(kept.length) : [];
  const folded = new Set(foldedKeys);
  const otherCount = foldedKeys.reduce((s, k) => s + counts.get(k)!, 0);

  const colors = new Map<string, string>();
  kept.forEach((k, i) => {
    let c: string;
    switch (axis) {
      case "generation": c = generationColor(Number(k), up, down); break;
      case "branch": c = k === OWN_BRANCH ? OWN_COLOR : ctx.branches?.get(k)?.color ?? UNKNOWN_COLOR; break;
      case "sex": c = SEX_COLOR[k as Sex] ?? UNKNOWN_COLOR; break;
      case "living": c = k === "living" ? OWN_COLOR : "var(--kin-deceased)"; break;
      case "sources": c = ramp(k === "none" ? 0 : k === "some" ? 0.5 : 1, BAD, GOOD); break;
      default: c = categoryColor(i, kept.length);
    }
    colors.set(k, c);
  });
  if (otherCount) colors.set(OTHER, UNKNOWN_COLOR);

  const label = (k: string): string => {
    switch (axis) {
      case "generation": {
        const g = Number(k);
        if (g === 0) return t("kin.gen.0");
        const n = Math.abs(g);
        const dir = g > 0 ? "up" : "down";
        return n <= 3 ? t(`kin.gen.${dir}.${n}`) : t(`kin.gen.${dir}.n`, { n });
      }
      case "branch": return k === OWN_BRANCH ? t("kin.wedge.own") : ctx.branches?.get(k)?.label ?? t("kin.wedge.unknown");
      case "sex": return t(`sex.${k}`);
      case "living": return t(`kin.living.${k}`);
      case "country": return countryFacetLabel(k, lang);
      case "sources": return t(`chartColor.sources.${k}`);
      case "century": return `${k}–${Number(k) + 99}`;
      default: return numeric ? `${k}–${Number(k) + numeric - 1}` : k;
    }
  };

  const legend: LegendEntry[] = kept.map((k) => ({ key: k, label: label(k), color: colors.get(k)!, count: counts.get(k)! }));
  if (otherCount) legend.push({ key: OTHER, label: t("chartColor.other"), color: UNKNOWN_COLOR, count: otherCount });

  const categoryFolded = (indi: Individual | undefined, pos?: NodePosition): string => {
    const k = categoryOf(indi, pos);
    return folded.has(k) ? OTHER : k;
  };
  const colorOf = (k: string) => (axis === "plain" ? undefined : colors.get(k) ?? UNKNOWN_COLOR);

  return {
    axis,
    categoryOf: categoryFolded,
    colorOf,
    colorFor: (indi, pos) => colorOf(categoryFolded(indi, pos)),
    legend,
  };
}

// ─── Positions on a pedigree chart ───────────────────────────────────────────

/** The root's children in the order the descendant charts number their lines:
 *  each union's children in union order, then the children with no recorded
 *  spouse. */
function rootChildren(root: TreeNode): TreeNode[] {
  return [...root.partners.flatMap((p) => p.children), ...root.children];
}

/**
 * Index every position of a direction tree by its node key: the generation
 * (signed by direction) and the branch — a grandparent's id above the root, a
 * child of the root's id below, {@link OWN_BRANCH} for the root, their spouses
 * and their parents. `prefix` is what the host prepends to the keys of this
 * tree's positions (a bowtie's ancestor half). Returns the branches found, so
 * the host can name and colour them.
 */
export function indexPositions(
  root: TreeNode | undefined,
  direction: TreeMode,
  prefix = "",
  into: Map<string, NodePosition> = new Map(),
  branches: Map<string, BranchInfo> = new Map(),
): { positions: Map<string, NodePosition>; branches: Map<string, BranchInfo> } {
  if (!root) return { positions: into, branches };
  const sign = direction === "ancestors" ? 1 : -1;
  // `|| 0` keeps the root at +0, not -0, below the root.
  const set = (n: TreeNode, gen: number, branch: string) => into.set(prefix + n.key, { gen: sign * gen || 0, branch });
  if (direction === "ancestors") {
    set(root, 0, OWN_BRANCH);
    const [father, mother] = splitParents(root.children);
    [father, mother].forEach((parent, side) => {
      if (!parent) return;
      set(parent, 1, OWN_BRANCH);
      const [gf, gm] = splitParents(parent.children);
      [gf, gm].forEach((gp, j) => {
        if (!gp) return;
        const key = gp.main?.id ?? gp.key;
        branches.set(key, { label: gp.name, color: lineColor(side * 2 + j, 4, "ancestors") });
        (function walk(n: TreeNode, gen: number) {
          set(n, gen, key);
          n.children.forEach((c) => walk(c, gen + 1));
        })(gp, 2);
      });
    });
  } else {
    set(root, 0, OWN_BRANCH);
    root.partners.forEach((p) => set(p, 0, OWN_BRANCH));
    const kids = rootChildren(root);
    kids.forEach((child, i) => {
      const key = child.main?.id ?? child.key;
      branches.set(key, { label: child.name, color: lineColor(i, kids.length, "descendants") });
      (function walk(n: TreeNode, gen: number) {
        set(n, gen, key);
        n.partners.forEach((p) => { set(p, gen, key); p.children.forEach((c) => walk(c, gen + 1)); });
        n.children.forEach((c) => walk(c, gen + 1));
      })(child, 1);
    });
  }
  return { positions: into, branches };
}

/** A radial segment's position: its ring, signed by the half it is on, and
 *  its line — read off the segment itself, since the fan numbers its own
 *  slots: above the root, the grandparent slot the segment descends from. */
export function fanPosition(seg: FanSegment, half: TreeMode, positions: Map<string, NodePosition>): NodePosition {
  if (half === "descendants") {
    // The tree index knows the line by the child's id; the segment carries
    // the same tree node, so the key resolves through it.
    return positions.get(seg.node.key) ?? { gen: -seg.gen, branch: OWN_BRANCH };
  }
  return positions.get(seg.node.key) ?? { gen: seg.gen, branch: OWN_BRANCH };
}
