import type { Dataset, Family, Individual, Sex } from "../gedcom/types";
import { birthYear, deathYear, formatLifespan, isDeceased, isPresumedLiving } from "../gedcom/lifespan";
import { lifespanAge } from "../gedcom/age";
import { localityParts } from "../gedcom/place";
import { placeLabel } from "./nodeDisplay";
import type { Translate } from "../locales/i18n";
import type { MatchResult } from "../match/types";
import { displayName, primaryName } from "../match/relatives";
import { individualFieldRows } from "../review/fields";
import { inferPlaceExportFormat } from "../normalize/profile";
import type { PlaceTargetFormat } from "../normalize/types";

/** Which direction the tree fans out from the root person. */
export type TreeMode = "ancestors" | "descendants";

/** How a person compares between the main and incoming files. */
export type NodeStatus =
  | "match" // both sides present and fully agree
  | "minor" // both present, only non-key differences
  | "major" // both present, conflict in name / surname / birth year
  | "main-only" // present only in the main file
  | "incoming-only"; // present only in the incoming file

export interface TreeNode {
  /** Render/selection key, unique per tree *position*: pedigree collapse repeats
   *  a person in several places, and each occurrence is its own node (the second
   *  and later carry a `#n` suffix). Identify the person via main/incoming. */
  key: string;
  main?: Individual;
  incoming?: Individual;
  status: NodeStatus;
  /** Primary display name (main's, falling back to incoming's). */
  name: string;
  /** Lifespan label: "1817–1921", "1817–" (dead), "1817" (living), or "". */
  years: string;
  /** Whole-years age (at death, or current for the living) when known — folded
   *  into the lifespan line by {@link nodeDisplay} when the Age toggle is on. */
  age?: number;
  /** First-available place (birth → residence → death), most-specific locality. */
  place?: string;
  /** Presumed living (no death event + recent birth) — a privacy-redaction candidate. */
  living: boolean;
  sex: Sex;
  /** Multi-line tooltip describing the differences ("Full match" when clean). */
  detail: string;
  /** Graph children: parents in ancestor mode, offspring in descendant mode. */
  children: TreeNode[];
  /** Spouses, shown beside the person in descendant mode (empty for ancestors). */
  partners: TreeNode[];
  /** Marriage drawn at this node's connector: in descendant mode the person's own
   *  union (on the partner line); in ancestor mode the marriage of this node's two
   *  parents (the fan collar between its parent segments). Absent when unrecorded. */
  marriage?: MarriageInfo;
  /** This position is a second (or later) occurrence and carries no line of its
   *  own — it was already expanded earlier in the tree. Two cases: a person
   *  reached twice (pedigree collapse), and, in descendant mode, a union whose
   *  *both* spouses descend from the root, so the couple's children are drawn
   *  under whichever of the two the tree reaches first. Renderers mark it, so an
   *  empty node reads as "continues elsewhere" rather than "nothing recorded". */
  repeat?: boolean;
  /** The `key` of the position that does carry the line, so the marker can take
   *  the user there. Absent on the rare repeat with nowhere to point (a union
   *  whose children hang off a person rather than a spouse node). */
  repeatOf?: string;
  /** How many blood relatives {@link pruneTree} cut off below this node — set
   *  only on the last drawn generation, so renderers can say "and N more, not
   *  shown". Absent when nothing was cut (or no limit is in force). */
  hidden?: number;
  /** Sheet number this node's line continues on, set by the printable-sheet
   *  split (`src/chart/sheets.ts`) on a branch it cut. The node is drawn with a
   *  numbered marker instead of its children; the sheet with that number picks
   *  the same person up and carries on. Never set on the on-screen chart. */
  continuesOn?: number;
}

/** A marriage's display fields — already reduced to a year and most-specific
 *  locality, like a person's lifespan/place. Either may be absent. */
export interface MarriageInfo {
  year?: string;
  place?: string;
}

export interface MatchMaps {
  mainToCompare: Map<string, string>;
  compareToMain: Map<string, string>;
}


/** Index the accepted candidate pairs both ways for quick lookup. */
export function buildMatchMaps(matches: MatchResult): MatchMaps {
  const mainToCompare = new Map<string, string>();
  const compareToMain = new Map<string, string>();
  for (const c of matches.individuals) {
    mainToCompare.set(c.mainId, c.compareId);
    compareToMain.set(c.compareId, c.mainId);
  }
  return { mainToCompare, compareToMain };
}

/**
 * Build the merged compare tree rooted at one person (given as its main and/or
 * incoming record). Ancestors are merged by position (each person has one father
 * and one mother); descendants are paired through the match map and any unpaired
 * child on either side becomes a one-sided node. A visited guard stops cycles
 * and pedigree collapse from expanding forever.
 *
 * `isRejected` lets a decided "these are not the same person" pruning the tree:
 * when a paired node has been rejected, its incoming side is dropped so the node
 * becomes main-only and only the main lineage continues — the incoming person
 * and every incoming-only relative above/below them disappear from the tree.
 */
export function buildPersonTree(
  t: Translate,
  rootMain: Individual | undefined,
  rootIncoming: Individual | undefined,
  mainDs: Dataset,
  compareDs: Dataset,
  maps: MatchMaps,
  mode: TreeMode,
  isRejected?: (mainId: string, compareId: string) => boolean,
): TreeNode | undefined {
  // Occurrence count per person: pedigree collapse (and spouses who are also
  // blood relatives) repeat a person in several positions, and every occurrence
  // must get its own key — duplicate keys break React rendering and selection.
  // Key numbering is separate from the `expanded` guard below, so a person first
  // met as a spouse still expands normally when later built as a child.
  const occurrences = new Map<string, number>();
  const claimKey = (baseKey: string): string => {
    const n = (occurrences.get(baseKey) ?? 0) + 1;
    occurrences.set(baseKey, n);
    return n === 1 ? baseKey : `${baseKey}#${n}`;
  };
  // People already expanded → the key of the position that carries their branch,
  // so a repeat can point the user at it.
  const expanded = new Map<string, string>();
  // Unions already drawn with their children, mapped to the partner node that
  // carries them (undefined when the union has no recorded spouse and the
  // children hang off the person). A couple whose *both* spouses descend from
  // the root is reached twice — once down each spouse's line — and the person
  // guard below doesn't catch it, because the second spouse was only ever met as
  // a partner node. Without this the union's children are drawn under both
  // occurrences, inflating what the chart shows.
  const expandedFams = new Map<string, string | undefined>();
  const placeFmt = inferPlaceExportFormat(mainDs);

  const build = (main?: Individual, incoming?: Individual): TreeNode | undefined => {
    if (!main && !incoming) return undefined;
    // A rejected pairing means the two records are different people: keep the
    // main and drop the incoming side here, so neither it nor its relatives
    // are walked any further.
    if (main && incoming && isRejected?.(main.id, incoming.id)) {
      incoming = undefined;
    }
    const base = nodeKey(main, incoming);
    const key = claimKey(base);
    const node = makeNode(t, key, main, incoming, mainDs, compareDs, placeFmt);
    const expandedAt = expanded.get(base);
    if (expandedAt !== undefined) {
      // Already expanded elsewhere: stop here and point at that position.
      node.repeat = true;
      node.repeatOf = expandedAt;
      return node;
    }
    expanded.set(base, key);
    if (mode === "ancestors") {
      node.children = parents(main, incoming, mainDs, compareDs, build);
      // The marriage of this person's parents — drawn as the fan collar between
      // their two segments. Prefer the main side, else the incoming side.
      node.marriage =
        parentsMarriage(main, mainDs) ?? parentsMarriage(incoming, compareDs);
    } else {
      const { partners, directChildren } = descend(t, main, incoming, mainDs, compareDs, maps, build, claimKey, expandedFams, placeFmt);
      node.partners = partners;
      node.children = directChildren;
    }
    return node;
  };

  return build(rootMain, rootIncoming);
}

type Build = (main?: Individual, incoming?: Individual) => TreeNode | undefined;
type ClaimKey = (baseKey: string) => string;

function parents(
  main: Individual | undefined,
  incoming: Individual | undefined,
  mainDs: Dataset,
  compareDs: Dataset,
  build: Build,
): TreeNode[] {
  const out: TreeNode[] = [];
  for (const role of ["husband", "wife"] as const) {
    const mp = main ? firstParent(main, mainDs, role) : undefined;
    const ip = incoming ? firstParent(incoming, compareDs, role) : undefined;
    const node = build(mp, ip);
    if (node) out.push(node);
  }
  return out;
}

/** One marriage/family of a person: the spouse (if any), that union's children,
 *  and the family record (carrying the MARR event). */
interface Union {
  partner?: Individual;
  children: Individual[];
  fam: Family;
}

function unionsOf(indi: Individual | undefined, ds: Dataset): Union[] {
  if (!indi) return [];
  const unions: Union[] = [];
  for (const famId of indi.spouseOf) {
    const fam = ds.families.get(famId);
    if (!fam) continue;
    const otherId = fam.husband === indi.id ? fam.wife : fam.husband;
    const partner = otherId ? ds.individuals.get(otherId) : undefined;
    const children = fam.children
      .map((cid) => ds.individuals.get(cid))
      .filter((c): c is Individual => c !== undefined);
    unions.push({ partner, children, fam });
  }
  return unions;
}

/** The marriage display fields (year + most-specific locality) of a family's MARR
 *  event, or undefined when the family has neither recorded. */
function marriageOf(fam: Family | undefined): MarriageInfo | undefined {
  if (!fam) return undefined;
  const marr = fam.events.find((e) => e.tag === "MARR");
  if (!marr) return undefined;
  const year = marr.date?.year !== undefined ? String(marr.date.year) : undefined;
  const place = marr.place ? localityParts(marr.place)[0] : undefined;
  if (!year && !place) return undefined;
  return { year, place };
}

/** The marriage of `indi`'s parents — the MARR of the family in which `indi` is a
 *  child that holds the same father/mother shown by {@link firstParent} (else the
 *  first FAMC family). Undefined when no such family records a marriage. */
function parentsMarriage(indi: Individual | undefined, ds: Dataset): MarriageInfo | undefined {
  if (!indi) return undefined;
  const father = firstParent(indi, ds, "husband");
  const mother = firstParent(indi, ds, "wife");
  const fams = indi.childOf.map((id) => ds.families.get(id)).filter((f): f is Family => f !== undefined);
  const match = fams.find(
    (f) =>
      (!father || f.husband === father.id || f.wife === father.id) &&
      (!mother || f.husband === mother.id || f.wife === mother.id),
  );
  return marriageOf(match ?? fams[0]);
}

/**
 * Build the descendant generation for a person. Each marriage becomes a partner
 * node carrying *that union's* children, so children connect to the spouse they
 * belong to. Children from a family with no recorded spouse hang off the person
 * directly. Main and incoming families are aligned by their matched partner.
 *
 * A union is expanded once per tree (`expandedFams`): when both spouses descend
 * from the root, the second occurrence keeps the couple and their marriage but
 * is flagged `repeat` and drawn childless, so the shared children — and every
 * generation below them — appear exactly once.
 */
function descend(
  t: Translate,
  main: Individual | undefined,
  incoming: Individual | undefined,
  mainDs: Dataset,
  compareDs: Dataset,
  maps: MatchMaps,
  build: Build,
  claimKey: ClaimKey,
  expandedFams: Map<string, string | undefined>,
  placeFmt: PlaceTargetFormat,
): { partners: TreeNode[]; directChildren: TreeNode[] } {
  const mainUnions = unionsOf(main, mainDs);
  const incomingUnions = unionsOf(incoming, compareDs);
  const usedIncoming = new Set<number>();

  const partners: TreeNode[] = [];
  const directChildren: TreeNode[] = [];

  const emit = (
    mPartner: Individual | undefined,
    iPartner: Individual | undefined,
    famKeys: string[],
    childrenOf: () => TreeNode[],
    fam: Family | undefined,
  ) => {
    // Second (or later) time through this union: keep the couple and their
    // marriage, drop the line below. The children aren't built at all, so the
    // person guard in `build` stays free for their real position elsewhere.
    const seenAs = famKeys.find((k) => expandedFams.has(k));
    const children = seenAs === undefined ? childrenOf() : [];
    if (mPartner || iPartner) {
      // Partner nodes claim a key too: a spouse who is also a blood relative
      // (or married twice into the tree) appears in several positions.
      const key = claimKey(nodeKey(mPartner, iPartner));
      const node = makeNode(t, key, mPartner, iPartner, mainDs, compareDs, placeFmt);
      node.children = children;
      // The marriage belongs to this union — drawn on the person↔spouse line.
      node.marriage = marriageOf(fam);
      if (seenAs !== undefined) {
        node.repeat = true;
        node.repeatOf = expandedFams.get(seenAs);
      }
      partners.push(node);
    } else {
      directChildren.push(...children);
    }
    // Mark the union only on its first pass, so its recorded position stays the
    // one that actually carries the children.
    if (seenAs === undefined) {
      const at = mPartner || iPartner ? partners[partners.length - 1].key : undefined;
      for (const k of famKeys) expandedFams.set(k, at);
    }
  };

  for (const mu of mainUnions) {
    // Align this main family with an incoming one via the matched spouse.
    let iIndex = -1;
    if (mu.partner) {
      const matchedId = maps.mainToCompare.get(mu.partner.id);
      if (matchedId) {
        iIndex = incomingUnions.findIndex(
          (iu, idx) => !usedIncoming.has(idx) && iu.partner?.id === matchedId,
        );
      }
    }
    const iu = iIndex >= 0 ? incomingUnions[iIndex] : undefined;
    if (iIndex >= 0) usedIncoming.add(iIndex);
    // Both sides' family xrefs identify the union — the two datasets number
    // their records independently, so the keys are side-prefixed.
    const keys = iu ? [`m:${mu.fam.id}`, `i:${iu.fam.id}`] : [`m:${mu.fam.id}`];
    emit(mu.partner, iu?.partner, keys, () => pairChildren(mu.children, iu?.children ?? [], maps, build), mu.fam);
  }

  incomingUnions.forEach((iu, idx) => {
    if (usedIncoming.has(idx)) return;
    emit(undefined, iu.partner, [`i:${iu.fam.id}`], () => pairChildren([], iu.children, maps, build), iu.fam);
  });

  return { partners, directChildren };
}

/** Pair a union's main and incoming children through the match map. */
function pairChildren(
  mainKids: Individual[],
  incomingKids: Individual[],
  maps: MatchMaps,
  build: Build,
): TreeNode[] {
  const incomingById = new Map(incomingKids.map((c) => [c.id, c]));
  const used = new Set<string>();
  const out: TreeNode[] = [];

  for (const child of mainKids) {
    const matchedId = maps.mainToCompare.get(child.id);
    const paired = matchedId ? incomingById.get(matchedId) : undefined;
    if (paired) used.add(paired.id);
    const node = build(child, paired);
    if (node) out.push(node);
  }
  for (const child of incomingKids) {
    if (used.has(child.id)) continue;
    const node = build(undefined, child);
    if (node) out.push(node);
  }
  return out;
}

function nodeKey(main: Individual | undefined, incoming: Individual | undefined): string {
  return `${main?.id ?? ""}|${incoming?.id ?? ""}`;
}

/**
 * Count the incoming-only people in a node's subtree — the ones a "bring
 * ancestors/descendants" import would add as fresh records. Matched nodes are
 * reused as join points and main-only nodes aren't touched, so neither counts.
 * The node itself is excluded (the import is about its ancestors/descendants).
 */
/**
 * Count the blood relatives in a node's tree — ancestors (in an ancestors tree)
 * or descendants (in a descendants tree). The root itself and spouses (partner
 * nodes) are excluded, so the number answers "does this person have anything in
 * this direction?" at a glance. Deduped by person (keys are occurrence-unique,
 * so pedigree collapse must not double-count).
 */
export function countTreePeople(root: TreeNode | undefined): number {
  if (!root) return 0;
  const seen = new Set<string>();
  const visit = (x: TreeNode) => {
    const person = nodeKey(x.main, x.incoming);
    if (seen.has(person)) return;
    seen.add(person);
    x.children.forEach(visit);
    x.partners.forEach((p) => p.children.forEach(visit));
  };
  root.children.forEach(visit);
  root.partners.forEach((p) => p.children.forEach(visit));
  return seen.size;
}

/**
 * How many generations the tree spans away from its root: 0 when the root has
 * nobody in this direction, 1 when only their parents/children are known, and so
 * on. Spouses sit in their partner's generation, so a union's children count as
 * one step below the person they hang from — the same numbering
 * {@link pruneTree} and the reports use.
 */
export function treeDepth(root: TreeNode | undefined): number {
  if (!root) return 0;
  let max = 0;
  const visit = (n: TreeNode, gen: number) => {
    if (gen > max) max = gen;
    n.children.forEach((c) => visit(c, gen + 1));
    n.partners.forEach((p) => p.children.forEach((c) => visit(c, gen + 1)));
  };
  visit(root, 0);
  return max;
}

/**
 * Trim a built tree to `maxGen` generations away from the root (0 = the root
 * alone), returning copies so the full tree stays intact for the head-counts and
 * for a later, deeper look. Spouses belong to their partner's generation, so the
 * last drawn generation keeps its couples and drops only what hangs below them.
 * Each node that lost a line records how many people went with it in
 * {@link TreeNode.hidden}, so the chart can own up to what it isn't showing.
 */
export function pruneTree(root: TreeNode | undefined, maxGen: number): TreeNode | undefined {
  if (!root) return undefined;
  const cut = (n: TreeNode, gen: number): TreeNode => {
    if (gen >= maxGen) {
      const hidden = countTreePeople(n);
      // Partners stay (same generation as their spouse) but lead nowhere; the
      // whole cut branch is counted once, on the person the chart hangs it from.
      return {
        ...n,
        children: [],
        partners: n.partners.map((p) => ({ ...p, children: [] })),
        ...(hidden > 0 ? { hidden } : null),
      };
    }
    return {
      ...n,
      children: n.children.map((c) => cut(c, gen + 1)),
      partners: n.partners.map((p) => ({ ...p, children: p.children.map((c) => cut(c, gen + 1)) })),
    };
  };
  return cut(root, 0);
}

export function countImportable(node: TreeNode): number {
  let n = 0;
  const visit = (x: TreeNode) => {
    if (x.status === "incoming-only") n++;
    x.children.forEach(visit);
    x.partners.forEach(visit);
  };
  node.children.forEach(visit);
  node.partners.forEach(visit);
  return n;
}

function firstParent(
  indi: Individual,
  ds: Dataset,
  role: "husband" | "wife",
): Individual | undefined {
  for (const famId of indi.childOf) {
    const id = ds.families.get(famId)?.[role];
    const p = id ? ds.individuals.get(id) : undefined;
    if (p) return p;
  }
  return undefined;
}

function makeNode(
  t: Translate,
  key: string,
  main: Individual | undefined,
  incoming: Individual | undefined,
  mainDs: Dataset,
  compareDs: Dataset,
  placeFmt: PlaceTargetFormat,
): TreeNode {
  const status = nodeStatus(t, main, incoming, mainDs, compareDs, placeFmt);
  const primary = main ?? incoming!;
  const sex = main && main.sex !== "U" ? main.sex : (incoming?.sex ?? "U");
  return {
    key,
    main,
    incoming,
    status,
    name: nameOf(primary),
    years: birthYears(main, incoming),
    age: lifespanAge(primary),
    place: placeLabel(primary),
    // Declared-private people redact exactly like the presumed-living.
    living: isPresumedLiving(main, mainDs) || isPresumedLiving(incoming, compareDs) || !!main?.private || !!incoming?.private,
    sex,
    detail: describe(t, main, incoming, mainDs, compareDs, status, placeFmt),
    children: [],
    partners: [],
  };
}

function nodeStatus(
  t: Translate,
  main: Individual | undefined,
  incoming: Individual | undefined,
  mainDs: Dataset,
  compareDs: Dataset,
  placeFmt: PlaceTargetFormat,
): NodeStatus {
  if (main && !incoming) return "main-only";
  if (!main && incoming) return "incoming-only";

  const rows = individualFieldRows(t, main, incoming, mainDs, compareDs, placeFmt);
  const conflict = (k: string) => rows.find((r) => r.key === k)?.state === "conflict";
  if (conflict("given") || conflict("surname") || birthYearConflict(main, incoming)) {
    return "major";
  }
  // A row with `relatives` is a list of people, not a scalar field of the
  // root person. Differences in relatives are reflected in the child nodes, not
  // as a 'minor' conflict on the parent.
  const hasDiff = rows.some((r) => r.state !== "agree" && !r.relatives);
  return hasDiff ? "minor" : "match";
}

function describe(
  t: Translate,
  main: Individual | undefined,
  incoming: Individual | undefined,
  mainDs: Dataset,
  compareDs: Dataset,
  status: NodeStatus,
  placeFmt: PlaceTargetFormat,
): string {
  if (!main || !incoming) {
    const who = (main ?? incoming)!;
    const side = status === "main-only" ? t("tree.legend.mainOnly") : t("tree.legend.incomingOnly");
    return `${side}: ${nameOf(who)}`;
  }
  const diffs = individualFieldRows(t, main, incoming, mainDs, compareDs, placeFmt).filter(
    (r) => r.state !== "agree",
  );
  if (diffs.length === 0) return t("tree.legend.match");
  return diffs.map((r) => `${r.label}: ${r.main || "—"} / ${r.incoming || "—"}`).join("\n");
}

function nameOf(indi: Individual): string {
  return displayName(primaryName(indi));
}

function birthYearConflict(
  main: Individual | undefined,
  incoming: Individual | undefined,
): boolean {
  const my = birthYear(main);
  const iy = birthYear(incoming);
  return my !== undefined && iy !== undefined && my !== iy;
}

/**
 * Main-centric lifespan label for a tree node — see {@link formatLifespan}:
 * "1817–1921", "1817–" (dead, death year unknown), "1817" (presumed living), or
 * "". Falls back to the incoming side when the main lacks a year/death event.
 */
function birthYears(
  main: Individual | undefined,
  incoming: Individual | undefined,
): string {
  const b = birthYear(main) ?? birthYear(incoming);
  const d = deathYear(main) ?? deathYear(incoming);
  const dead = isDeceased(main) || isDeceased(incoming);
  return formatLifespan(b, d, dead);
}
