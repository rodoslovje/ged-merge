import type { Dataset, Individual, Sex } from "../gedcom/types";
import type { MatchResult } from "../match/types";
import { displayName, primaryName } from "../match/relatives";
import { individualFieldRows } from "../review/fields";

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
  /** Birth year(s): "1850", or "1850 / 1851" when the two sides differ. */
  years: string;
  sex: Sex;
  /** Multi-line tooltip describing the differences ("Full match" when clean). */
  detail: string;
  /** Graph children: parents in ancestor mode, offspring in descendant mode. */
  children: TreeNode[];
}

export interface MatchMaps {
  masterToCompare: Map<string, string>;
  compareToMaster: Map<string, string>;
}

/** A translator (i18next `t`), used only to label fields in node tooltips. */
type Translate = (key: string, opts?: Record<string, unknown>) => string;

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

  const build = (master?: Individual, incoming?: Individual): TreeNode | undefined => {
    if (!master && !incoming) return undefined;
    const key = `${master?.id ?? ""}|${incoming?.id ?? ""}`;
    const node = makeNode(t, key, master, incoming, masterDs, compareDs);
    if (seen.has(key)) return node; // already expanded elsewhere: stop here
    seen.add(key);
    node.children =
      mode === "ancestors"
        ? parents(master, incoming, masterDs, compareDs, build)
        : offspring(master, incoming, masterDs, compareDs, maps, build);
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

function offspring(
  master: Individual | undefined,
  incoming: Individual | undefined,
  masterDs: Dataset,
  compareDs: Dataset,
  maps: MatchMaps,
  build: Build,
): TreeNode[] {
  const out: TreeNode[] = [];
  const masterKids = master ? childrenOf(master, masterDs) : [];
  const incomingKids = incoming ? childrenOf(incoming, compareDs) : [];
  const incomingById = new Map(incomingKids.map((c) => [c.id, c]));
  const used = new Set<string>();

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

function childrenOf(indi: Individual, ds: Dataset): Individual[] {
  const out: Individual[] = [];
  const seen = new Set<string>();
  for (const famId of indi.spouseOf) {
    const fam = ds.families.get(famId);
    if (!fam) continue;
    for (const cid of fam.children) {
      if (seen.has(cid)) continue;
      const c = ds.individuals.get(cid);
      if (c) {
        seen.add(cid);
        out.push(c);
      }
    }
  }
  return out;
}

function makeNode(
  t: Translate,
  key: string,
  master: Individual | undefined,
  incoming: Individual | undefined,
  masterDs: Dataset,
  compareDs: Dataset,
): TreeNode {
  const status = nodeStatus(t, master, incoming, masterDs, compareDs);
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
    detail: describe(t, master, incoming, masterDs, compareDs, status),
    children: [],
  };
}

function nodeStatus(
  t: Translate,
  master: Individual | undefined,
  incoming: Individual | undefined,
  masterDs: Dataset,
  compareDs: Dataset,
): NodeStatus {
  if (master && !incoming) return "master-only";
  if (!master && incoming) return "incoming-only";

  const rows = individualFieldRows(t, master, incoming, masterDs, compareDs);
  const conflict = (k: string) => rows.find((r) => r.key === k)?.state === "conflict";
  if (conflict("given") || conflict("surname") || birthYearConflict(master, incoming)) {
    return "major";
  }
  return rows.some((r) => r.state !== "agree") ? "minor" : "match";
}

function describe(
  t: Translate,
  master: Individual | undefined,
  incoming: Individual | undefined,
  masterDs: Dataset,
  compareDs: Dataset,
  status: NodeStatus,
): string {
  if (!master || !incoming) {
    const who = (master ?? incoming)!;
    const side = status === "master-only" ? t("tree.legend.masterOnly") : t("tree.legend.incomingOnly");
    return `${side}: ${nameOf(who)}`;
  }
  const diffs = individualFieldRows(t, master, incoming, masterDs, compareDs).filter(
    (r) => r.state !== "agree",
  );
  if (diffs.length === 0) return t("tree.legend.match");
  return diffs.map((r) => `${r.label}: ${r.master || "—"} / ${r.incoming || "—"}`).join("\n");
}

function nameOf(indi: Individual): string {
  return displayName(primaryName(indi));
}

function birthYear(indi: Individual | undefined): number | undefined {
  return indi?.events.find((e) => e.tag === "BIRT")?.date?.year;
}

function birthYearConflict(
  master: Individual | undefined,
  incoming: Individual | undefined,
): boolean {
  const my = birthYear(master);
  const iy = birthYear(incoming);
  return my !== undefined && iy !== undefined && my !== iy;
}

function birthYears(
  master: Individual | undefined,
  incoming: Individual | undefined,
): string {
  const my = birthYear(master);
  const iy = birthYear(incoming);
  if (my !== undefined && iy !== undefined) return my === iy ? String(my) : `${my} / ${iy}`;
  return String(my ?? iy ?? "");
}
