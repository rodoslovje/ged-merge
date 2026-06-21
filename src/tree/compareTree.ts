import type { Dataset, Individual, Sex } from "../gedcom/types";
import { birthYear, deathYear, formatLifespan, isDeceased } from "../gedcom/lifespan";
import type { Translate } from "../locales/i18n";
import type { MatchResult } from "../match/types";
import { displayName, primaryName } from "../match/relatives";
import { individualFieldRows } from "../review/fields";
import { inferPlaceExportFormat } from "../normalize/profile";
import type { PlaceTargetFormat } from "../normalize/types";

/** Which direction the tree fans out from the root person. */
export type TreeMode = "ancestors" | "descendants";

/** How a person compares between the master and incoming files. */
export type NodeStatus =
  | "match" // both sides present and fully agree
  | "minor" // both present, only non-key differences
  | "major" // both present, conflict in name / surname / birth year
  | "master-only" // present only in the master file
  | "incoming-only"; // present only in the incoming file

export interface TreeNode {
  /** Stable key for React rendering. */
  key: string;
  master?: Individual;
  incoming?: Individual;
  status: NodeStatus;
  /** Primary display name (master's, falling back to incoming's). */
  name: string;
  /** Lifespan label: "1817–1921", "1817–" (dead), "1817" (living), or "". */
  years: string;
  sex: Sex;
  /** Multi-line tooltip describing the differences ("Full match" when clean). */
  detail: string;
  /** Graph children: parents in ancestor mode, offspring in descendant mode. */
  children: TreeNode[];
  /** Spouses, shown beside the person in descendant mode (empty for ancestors). */
  partners: TreeNode[];
}

export interface MatchMaps {
  masterToCompare: Map<string, string>;
  compareToMaster: Map<string, string>;
}


/** Index the accepted candidate pairs both ways for quick lookup. */
export function buildMatchMaps(matches: MatchResult): MatchMaps {
  const masterToCompare = new Map<string, string>();
  const compareToMaster = new Map<string, string>();
  for (const c of matches.individuals) {
    masterToCompare.set(c.masterId, c.compareId);
    compareToMaster.set(c.compareId, c.masterId);
  }
  return { masterToCompare, compareToMaster };
}

/**
 * Build the merged compare tree rooted at one person (given as its master and/or
 * incoming record). Ancestors are merged by position (each person has one father
 * and one mother); descendants are paired through the match map and any unpaired
 * child on either side becomes a one-sided node. A visited guard stops cycles
 * and pedigree collapse from expanding forever.
 */
export function buildCompareTree(
  t: Translate,
  rootMaster: Individual | undefined,
  rootIncoming: Individual | undefined,
  masterDs: Dataset,
  compareDs: Dataset,
  maps: MatchMaps,
  mode: TreeMode,
): TreeNode | undefined {
  const seen = new Set<string>();
  const placeFmt = inferPlaceExportFormat(masterDs);

  const build = (master?: Individual, incoming?: Individual): TreeNode | undefined => {
    if (!master && !incoming) return undefined;
    const key = `${master?.id ?? ""}|${incoming?.id ?? ""}`;
    const node = makeNode(t, key, master, incoming, masterDs, compareDs, placeFmt);
    if (seen.has(key)) return node; // already expanded elsewhere: stop here
    seen.add(key);
    if (mode === "ancestors") {
      node.children = parents(master, incoming, masterDs, compareDs, build);
    } else {
      const { partners, directChildren } = descend(t, master, incoming, masterDs, compareDs, maps, build, placeFmt);
      node.partners = partners;
      node.children = directChildren;
    }
    return node;
  };

  return build(rootMaster, rootIncoming);
}

type Build = (master?: Individual, incoming?: Individual) => TreeNode | undefined;

function parents(
  master: Individual | undefined,
  incoming: Individual | undefined,
  masterDs: Dataset,
  compareDs: Dataset,
  build: Build,
): TreeNode[] {
  const out: TreeNode[] = [];
  for (const role of ["husband", "wife"] as const) {
    const mp = master ? firstParent(master, masterDs, role) : undefined;
    const ip = incoming ? firstParent(incoming, compareDs, role) : undefined;
    const node = build(mp, ip);
    if (node) out.push(node);
  }
  return out;
}

/** One marriage/family of a person: the spouse (if any) and that union's children. */
interface Union {
  partner?: Individual;
  children: Individual[];
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
    unions.push({ partner, children });
  }
  return unions;
}

/**
 * Build the descendant generation for a person. Each marriage becomes a partner
 * node carrying *that union's* children, so children connect to the spouse they
 * belong to. Children from a family with no recorded spouse hang off the person
 * directly. Master and incoming families are aligned by their matched partner.
 */
function descend(
  t: Translate,
  master: Individual | undefined,
  incoming: Individual | undefined,
  masterDs: Dataset,
  compareDs: Dataset,
  maps: MatchMaps,
  build: Build,
  placeFmt: PlaceTargetFormat,
): { partners: TreeNode[]; directChildren: TreeNode[] } {
  const masterUnions = unionsOf(master, masterDs);
  const incomingUnions = unionsOf(incoming, compareDs);
  const usedIncoming = new Set<number>();

  const partners: TreeNode[] = [];
  const directChildren: TreeNode[] = [];

  const emit = (
    mPartner: Individual | undefined,
    iPartner: Individual | undefined,
    children: TreeNode[],
  ) => {
    if (mPartner || iPartner) {
      const node = makeNode(t, nodeKey(mPartner, iPartner), mPartner, iPartner, masterDs, compareDs, placeFmt);
      node.children = children;
      partners.push(node);
    } else {
      directChildren.push(...children);
    }
  };

  for (const mu of masterUnions) {
    // Align this master family with an incoming one via the matched spouse.
    let iIndex = -1;
    if (mu.partner) {
      const matchedId = maps.masterToCompare.get(mu.partner.id);
      if (matchedId) {
        iIndex = incomingUnions.findIndex(
          (iu, idx) => !usedIncoming.has(idx) && iu.partner?.id === matchedId,
        );
      }
    }
    const iu = iIndex >= 0 ? incomingUnions[iIndex] : undefined;
    if (iIndex >= 0) usedIncoming.add(iIndex);
    emit(mu.partner, iu?.partner, pairChildren(mu.children, iu?.children ?? [], maps, build));
  }

  incomingUnions.forEach((iu, idx) => {
    if (usedIncoming.has(idx)) return;
    emit(undefined, iu.partner, pairChildren([], iu.children, maps, build));
  });

  return { partners, directChildren };
}

/** Pair a union's master and incoming children through the match map. */
function pairChildren(
  masterKids: Individual[],
  incomingKids: Individual[],
  maps: MatchMaps,
  build: Build,
): TreeNode[] {
  const incomingById = new Map(incomingKids.map((c) => [c.id, c]));
  const used = new Set<string>();
  const out: TreeNode[] = [];

  for (const child of masterKids) {
    const matchedId = maps.masterToCompare.get(child.id);
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

function nodeKey(master: Individual | undefined, incoming: Individual | undefined): string {
  return `${master?.id ?? ""}|${incoming?.id ?? ""}`;
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
  master: Individual | undefined,
  incoming: Individual | undefined,
  masterDs: Dataset,
  compareDs: Dataset,
  placeFmt: PlaceTargetFormat,
): TreeNode {
  const status = nodeStatus(t, master, incoming, masterDs, compareDs, placeFmt);
  const primary = master ?? incoming!;
  const sex = master && master.sex !== "U" ? master.sex : (incoming?.sex ?? "U");
  return {
    key,
    master,
    incoming,
    status,
    name: nameOf(primary),
    years: birthYears(master, incoming),
    sex,
    detail: describe(t, master, incoming, masterDs, compareDs, status, placeFmt),
    children: [],
    partners: [],
  };
}

function nodeStatus(
  t: Translate,
  master: Individual | undefined,
  incoming: Individual | undefined,
  masterDs: Dataset,
  compareDs: Dataset,
  placeFmt: PlaceTargetFormat,
): NodeStatus {
  if (master && !incoming) return "master-only";
  if (!master && incoming) return "incoming-only";

  const rows = individualFieldRows(t, master, incoming, masterDs, compareDs, placeFmt);
  const conflict = (k: string) => rows.find((r) => r.key === k)?.state === "conflict";
  if (conflict("given") || conflict("surname") || birthYearConflict(master, incoming)) {
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
  master: Individual | undefined,
  incoming: Individual | undefined,
  masterDs: Dataset,
  compareDs: Dataset,
  status: NodeStatus,
  placeFmt: PlaceTargetFormat,
): string {
  if (!master || !incoming) {
    const who = (master ?? incoming)!;
    const side = status === "master-only" ? t("tree.legend.masterOnly") : t("tree.legend.incomingOnly");
    return `${side}: ${nameOf(who)}`;
  }
  const diffs = individualFieldRows(t, master, incoming, masterDs, compareDs, placeFmt).filter(
    (r) => r.state !== "agree",
  );
  if (diffs.length === 0) return t("tree.legend.match");
  return diffs.map((r) => `${r.label}: ${r.master || "—"} / ${r.incoming || "—"}`).join("\n");
}

function nameOf(indi: Individual): string {
  return displayName(primaryName(indi));
}

function birthYearConflict(
  master: Individual | undefined,
  incoming: Individual | undefined,
): boolean {
  const my = birthYear(master);
  const iy = birthYear(incoming);
  return my !== undefined && iy !== undefined && my !== iy;
}

/**
 * Master-centric lifespan label for a tree node — see {@link formatLifespan}:
 * "1817–1921", "1817–" (dead, death year unknown), "1817" (presumed living), or
 * "". Falls back to the incoming side when the master lacks a year/death event.
 */
function birthYears(
  master: Individual | undefined,
  incoming: Individual | undefined,
): string {
  const b = birthYear(master) ?? birthYear(incoming);
  const d = deathYear(master) ?? deathYear(incoming);
  const dead = isDeceased(master) || isDeceased(incoming);
  return formatLifespan(b, d, dead);
}
