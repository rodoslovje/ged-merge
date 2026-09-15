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
import { primaryName } from "../match/relatives";
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
  | "motherAge"
  | "fatherAge"
  | "lifespan"
  | "century"
  | "sources";

/** The axes in popover order. */
export const COLOR_AXES: ColorAxis[] = [
  "plain", "generation", "branch", "sex", "living",
  "country", "birthPlace", "surname",
  "motherAge", "fatherAge", "lifespan", "century", "sources",
];

/** A stored axis, or "plain" for anything else. */
export function sanitizeColorAxis(v: unknown): ColorAxis {
  return (COLOR_AXES as readonly unknown[]).includes(v) ? (v as ColorAxis) : "plain";
}

/** Where a person sits on the chart: generations above (+) or below (−) the
 *  root, and the line they belong to — a grandparent's id above, a child of
 *  the root's id below, {@link OWN_BRANCH} for the root, their spouses and
 *  their parents. The same keys the Contemporaries wheel uses. */
export interface NodePosition {
  gen: number;
  branch: string;
}

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

/** The grandparent lines' colours, in pedigree order: father's father,
 *  father's mother, mother's father, mother's mother. */
export const LINE_COLORS = ["var(--kin-line-f1)", "var(--kin-line-f2)", "var(--kin-line-m1)", "var(--kin-line-m2)"];

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

const COOL = "var(--kin-desc-far)";
const WARM = "var(--kin-anc-far)";
const BAD = "var(--danger)";
const GOOD = "var(--accent)";

/** Categories past this many fold into "other" — more hues than that stop
 *  telling apart. */
const MAX_CATEGORIES = 12;
const OTHER = "\u0000other";

// ─── Per-person readings ─────────────────────────────────────────────────────

const PLACE_TAGS = ["BIRT", "RESI", "DEAT"] as const;

function eventOf(indi: Individual, tag: string) {
  return indi.events.find((e) => e.tag === tag);
}

/** The country of the first of birth, residence and death that names a place. */
function countryOf(indi: Individual, home: string): string {
  for (const tag of PLACE_TAGS) {
    const place = eventOf(indi, tag)?.place;
    if (place?.raw.trim()) return placeCountryFacet(place.raw) || home;
  }
  return "";
}

function birthPlaceOf(indi: Individual): string {
  const place = eventOf(indi, "BIRT")?.place;
  return place ? (localityParts(place)[0] ?? "") : "";
}

function surnameOf(indi: Individual): string {
  return primaryName(indi)?.surname?.trim() ?? "";
}

/** The parent's age when this person was born, from the first birth family. */
function parentAgeOf(indi: Individual, ds: Dataset, which: "husband" | "wife"): number | undefined {
  const fam = indi.childOf.length ? ds.families.get(indi.childOf[0]) : undefined;
  const parent = fam?.[which] ? ds.individuals.get(fam[which]!) : undefined;
  return parent ? ageBetween(birthDateOf(parent), birthDateOf(indi)) : undefined;
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
  count(eventOf(indi, "BIRT"));
  count(eventOf(indi, "DEAT"));
  for (const fid of indi.spouseOf) {
    const fam = ds.families.get(fid);
    if (fam) count(fam.events.find((e) => e.tag === "MARR"));
  }
  return total ? cited / total : undefined;
}

// ─── Buckets for the numeric axes ────────────────────────────────────────────

interface Bucket {
  /** Bucket width in the value's unit. */
  step: number;
  /** The value range the ramp spans. */
  lo: number;
  hi: number;
  colors: [string, string];
}

const NUMERIC: Partial<Record<ColorAxis, Bucket>> = {
  motherAge: { step: 5, lo: 15, hi: 50, colors: [COOL, WARM] },
  fatherAge: { step: 5, lo: 15, hi: 65, colors: [COOL, WARM] },
  lifespan: { step: 10, lo: 0, hi: 90, colors: [BAD, GOOD] },
  century: { step: 100, lo: 1500, hi: 2000, colors: [WARM, COOL] },
};

function bucketKey(value: number, b: Bucket): string {
  return String(Math.floor(value / b.step) * b.step);
}

function bucketColor(key: string, b: Bucket): string {
  const mid = Number(key) + b.step / 2;
  return ramp((mid - b.lo) / (b.hi - b.lo), b.colors[0], b.colors[1]);
}

// ─── The colorer ─────────────────────────────────────────────────────────────

export function createNodeColorer(axis: ColorAxis, ctx: ColorContext, subjects: Iterable<ColorSubject>): NodeColorer {
  const { ds, t, lang } = ctx;
  const now = ctx.now ?? new Date().getFullYear();
  const numeric = NUMERIC[axis];

  const categoryOf = (indi: Individual | undefined, pos?: NodePosition): string => {
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
          axis === "motherAge" ? parentAgeOf(indi, ds, "wife")
            : axis === "fatherAge" ? parentAgeOf(indi, ds, "husband")
              : axis === "lifespan" ? (isDeceased(indi) ? lifespanAge(indi) : undefined)
                : birthYear(indi);
        return v === undefined ? "" : bucketKey(v, numeric);
      }
    }
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
      default: c = numeric ? bucketColor(k, numeric) : categoryColor(i, kept.length);
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
      default: return numeric ? `${k}–${Number(k) + numeric.step - 1}` : k;
    }
  };

  const legend: LegendEntry[] = kept.map((k) => ({ key: k, label: label(k), color: colors.get(k)!, count: counts.get(k)! }));
  if (otherCount) legend.push({ key: OTHER, label: t("chartColor.other"), color: UNKNOWN_COLOR, count: otherCount });

  return {
    axis,
    categoryOf: (indi, pos) => {
      const k = categoryOf(indi, pos);
      return folded.has(k) ? OTHER : k;
    },
    colorOf: (k) => (axis === "plain" ? undefined : colors.get(k) ?? (k === "" ? UNKNOWN_COLOR : UNKNOWN_COLOR)),
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
        branches.set(key, { label: gp.name, color: LINE_COLORS[side * 2 + j] });
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
      branches.set(key, { label: child.name, color: categoryColor(i, kids.length) });
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
