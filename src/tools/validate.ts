import type { Dataset, Family, GedNode, Individual } from "../gedcom/types";
import { DEATH_TAGS, birthDateOf, birthYear, deathYear, isDeceased } from "../gedcom/lifespan";
import { isSameSexCouple } from "../gedcom/couple";

/**
 * Plausibility limits for age-based sanity checks, in whole years. Computed from
 * recorded years (so they can be ±1 of the true age), these flag likely data
 * errors — a child older than a parent, a 120-year lifespan — as warnings, not
 * errors, since rare legitimate outliers exist.
 */
export const AGE_LIMITS = {
  marriage: { min: 12, max: 90 },
  death: { max: 99 },
  fatherAtBirth: { min: 14, max: 80 },
  motherAtBirth: { min: 14, max: 50 },
  spouseGap: { max: 32 },
} as const;

/**
 * Shortest plausible interval between two births by the same mother, in months
 * (roughly one gestation). Doubles as the safety margin for the parallel-families
 * check, so a child recorded only by year can't be "inside" another family's
 * birth span by a rounding artefact.
 */
export const MIN_BIRTH_INTERVAL_MONTHS = 9;

/**
 * Largest group of people, linked only to each other, still reported as a stray
 * island rather than left alone as a branch in its own right. A handful of
 * people who connect to nobody else is usually an import that never got
 * attached, or a duplicate of a branch already in the file.
 */
export const MAX_ISLAND_SIZE = 9;

/**
 * Main-file health check.
 *
 * Pure, synchronous validation over the typed domain model — fast enough to run
 * on the main thread for files of a few thousand records (a single pass over
 * individuals and families). Each finding points at one record so the UI can
 * navigate straight to it in Edit mode.
 */

/** Which record an issue concerns — drives the navigate target and label. */
export type IssueScope = "individual" | "family";

export type IssueCategory =
  | "brokenLink"
  | "duplicatePointer"
  | "pedigreeLoop"
  | "roleSexConflict"
  | "multiSpouseSlot"
  | "multipleParents"
  | "parentlessFamily"
  | "missingSex"
  | "missingName"
  | "missingVitals"
  | "island"
  | "orphan"
  | "deathBeforeBirth"
  | "eventOrder"
  | "ageAtDeath"
  | "livingTooOld"
  | "ageAtMarriage"
  | "parentAge"
  | "parallelFamilies"
  | "spouseAgeGap"
  | "futureDate";

export type IssueSeverity = "error" | "warning";

export interface ValidationIssue {
  scope: IssueScope;
  /** Record xref this issue is about — the navigate target. */
  id: string;
  category: IssueCategory;
  severity: IssueSeverity;
  /** Human-readable record label (name + lifespan, or family id). */
  subject: string;
  /** i18n key for the issue description, with optional interpolation values. */
  messageKey: string;
  messageVars?: Record<string, string | number>;
}

export interface ValidationReport {
  issues: ValidationIssue[];
  /** Per-category counts, for the summary header. */
  counts: Record<IssueCategory, number>;
  /** Records scanned. */
  individualCount: number;
  familyCount: number;
}

const EMPTY_COUNTS: Record<IssueCategory, number> = {
  brokenLink: 0,
  duplicatePointer: 0,
  pedigreeLoop: 0,
  roleSexConflict: 0,
  multiSpouseSlot: 0,
  multipleParents: 0,
  parentlessFamily: 0,
  missingSex: 0,
  missingName: 0,
  missingVitals: 0,
  island: 0,
  orphan: 0,
  deathBeforeBirth: 0,
  eventOrder: 0,
  ageAtDeath: 0,
  livingTooOld: 0,
  ageAtMarriage: 0,
  parentAge: 0,
  parallelFamilies: 0,
  spouseAgeGap: 0,
  futureDate: 0,
};

/** A short display label for an individual: primary name + life years. */
function subjectOf(indi: Individual): string {
  const name = indi.names[0]?.full?.trim();
  const by = birthYear(indi);
  const dy = deathYear(indi);
  const span = by || dy ? ` (${by ?? "?"}–${dy ?? "?"})` : "";
  return `${name || indi.id}${span}`;
}

/** Pointer values listed on more than one `tag` child of `node` — a redundant
 *  CHIL/FAMS/FAMC line repeating an xref already present (common in merged
 *  exports). Returns each repeated value once. */
function duplicateRefs(node: GedNode, tag: string): string[] {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const c of node.children) {
    if (c.tag === tag && c.value) {
      if (seen.has(c.value)) dups.add(c.value);
      else seen.add(c.value);
    }
  }
  return [...dups];
}

/** Highest event year recorded on an individual (for future-date detection). */
function maxEventYear(indi: Individual): number | undefined {
  let max: number | undefined;
  for (const e of indi.events) {
    const y = e.date?.year;
    if (y !== undefined && (max === undefined || y > max)) max = y;
    const y2 = e.date?.year2;
    if (y2 !== undefined && (max === undefined || y2 > max)) max = y2;
  }
  return max;
}

/**
 * Find every individual who is their own ancestor — a FAMC cycle in the
 * parent graph (A is a child of B, who descends from A). This is genuine
 * corruption: it makes ancestor walks (pedigree, completeness, kinship) loop
 * forever, so it's an error, not a warning.
 *
 * Iterative depth-first search with on-path (gray) colouring so a deeply or
 * pathologically linked file can't blow the call stack. When a parent edge
 * points back to a node still on the current path, every node between that
 * node and the current tip lies on the cycle and is flagged. Returns the set
 * of all individual ids that participate in at least one loop.
 */
function findPedigreeLoops(ds: Dataset): Set<string> {
  const color = new Map<string, 1 | 2>(); // 1 = on current path, 2 = fully explored
  const inLoop = new Set<string>();

  const parentsOf = (id: string): string[] => {
    const indi = ds.individuals.get(id);
    if (!indi) return [];
    const out: string[] = [];
    for (const famId of indi.childOf) {
      const fam = ds.families.get(famId);
      if (!fam) continue;
      if (fam.husband && ds.individuals.has(fam.husband)) out.push(fam.husband);
      if (fam.wife && ds.individuals.has(fam.wife)) out.push(fam.wife);
    }
    return out;
  };

  for (const startId of ds.individuals.keys()) {
    if (color.has(startId)) continue;
    const path: string[] = [];
    const stack: { id: string; parents: string[]; i: number }[] = [];
    const enter = (id: string) => {
      color.set(id, 1);
      path.push(id);
      stack.push({ id, parents: parentsOf(id), i: 0 });
    };
    enter(startId);
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top.i < top.parents.length) {
        const next = top.parents[top.i++];
        const c = color.get(next);
        if (c === 1) {
          // Back-edge to a node still on the path → cycle. Flag the whole loop.
          for (let k = path.lastIndexOf(next); k < path.length; k++) inLoop.add(path[k]);
        } else if (c === undefined) {
          enter(next);
        }
      } else {
        color.set(top.id, 2);
        path.pop();
        stack.pop();
      }
    }
  }
  return inLoop;
}

/**
 * The file's disconnected groups: each set of people reachable from one another
 * through family links, smallest-first, with the file's main tree left out.
 *
 * The largest component is the tree the file is about, so it's never an island —
 * and when several tie for largest, none of them stands out as the stray, so
 * they all stay out. A component of one is already an `orphan` finding, and
 * anything above {@link MAX_ISLAND_SIZE} is a branch in its own right; both are
 * dropped here so nothing is reported twice or cried wolf over.
 *
 * Iterative breadth-first walk over `childOf`/`spouseOf` and back out through
 * each family's members — one pass over the graph, no recursion.
 */
function findIslands(ds: Dataset): Individual[][] {
  const seen = new Set<string>();
  const components: Individual[][] = [];

  const membersOf = (indi: Individual): string[] => {
    const out: string[] = [];
    for (const famId of [...indi.childOf, ...indi.spouseOf]) {
      const fam = ds.families.get(famId);
      if (!fam) continue;
      if (fam.husband) out.push(fam.husband);
      if (fam.wife) out.push(fam.wife);
      out.push(...fam.children);
    }
    return out;
  };

  for (const start of ds.individuals.values()) {
    if (seen.has(start.id)) continue;
    const group: Individual[] = [];
    const queue = [start];
    seen.add(start.id);
    while (queue.length) {
      const indi = queue.pop()!;
      group.push(indi);
      for (const id of membersOf(indi)) {
        if (seen.has(id)) continue;
        const next = ds.individuals.get(id);
        if (!next) continue; // dangling member — the brokenLink check's
        seen.add(id);
        queue.push(next);
      }
    }
    components.push(group);
  }

  const largest = components.reduce((max, c) => Math.max(max, c.length), 0);
  return components
    .filter((c) => c.length > 1 && c.length <= MAX_ISLAND_SIZE && c.length < largest)
    .sort((a, b) => a.length - b.length);
}

/**
 * The island member to report the finding on: the youngest, by birth year —
 * the one most likely to reach a living branch, and so the best place to start
 * looking for where the group belongs. A person with only a death date is
 * ranked from it (roughly a lifetime earlier); one with no dates at all comes
 * last. Ties keep the first in file order, so the finding is stable.
 */
function youngestOf(members: Individual[]): Individual {
  const rank = (p: Individual): number => {
    const by = birthYear(p);
    if (by !== undefined) return by;
    const dy = deathYear(p);
    return dy !== undefined ? dy - 60 : -Infinity;
  };
  return members.reduce((best, p) => (rank(p) > rank(best) ? p : best));
}

/** PEDI / _MREL values that still mean "this child was born to these parents". */
const BIOLOGICAL_PEDI = new Set(["birth", "natural", ""]);

/** The families named by an individual's adoption events (`ADOP.FAMC`) — the
 *  5.5.1 way of recording an adoptive family when the `FAMC` link itself carries
 *  no `PEDI`. */
function adoptiveFamilyIds(indi: Individual): Set<string> {
  const ids = new Set<string>();
  for (const ev of indi.raw.children) {
    if (ev.tag !== "ADOP") continue;
    for (const c of ev.children) {
      if (c.tag === "FAMC" && c.value) ids.add(c.value.trim());
    }
  }
  return ids;
}

/**
 * The parent families an individual claims as their *birth* family: `FAMC` links
 * whose `PEDI`/`_MREL` says birth, or says nothing at all.
 *
 * Adoptive, foster and sealing links are a legitimate second set of parents, so
 * they're excluded — as are links naming a family the person's own `ADOP` event
 * points at. A family that doesn't exist is left to the `brokenLink` check, and a
 * repeated line to `duplicatePointer`, so neither is counted twice here.
 */
function birthParentFamilies(indi: Individual, ds: Dataset): Family[] {
  const adoptive = adoptiveFamilyIds(indi);
  const out: Family[] = [];
  const seen = new Set<string>();
  for (const node of indi.raw.children) {
    if (node.tag !== "FAMC" || !node.value) continue;
    const id = node.value.trim();
    if (seen.has(id) || adoptive.has(id)) continue;
    const pedi = node.children.find((c) => c.tag === "PEDI" || c.tag === "_MREL")?.value;
    if (pedi !== undefined && !BIOLOGICAL_PEDI.has(pedi.trim().toLowerCase())) continue;
    const fam = ds.families.get(id);
    if (!fam) continue;
    seen.add(id);
    out.push(fam);
  }
  return out;
}

/** A family named by its couple — "Janez Novak & Ana Kos (@F1@)" — for listing
 *  the rival parent sets in a finding. */
function coupleLabel(fam: Family, ds: Dataset): string {
  const names = [fam.husband, fam.wife]
    .map((id) => (id ? ds.individuals.get(id) : undefined))
    .filter((p): p is Individual => !!p)
    .map((p) => p.names[0]?.full?.trim() || p.id);
  return names.length ? `${names.join(" & ")} (${fam.id})` : fam.id;
}

/** A dated birth of one child, as a month index so partial dates still compare. */
interface ChildBirth {
  indi: Individual;
  /** year * 12 + month − 1; an unrecorded month counts as mid-year. */
  month: number;
  year: number;
}

/**
 * The children of `fam` that carry a birth (or christening) date and are linked
 * to it as births — an adopted or foster child legitimately overlaps a mother's
 * own children, so PEDI/_MREL on the child's FAMC excludes them here.
 */
function datedBirthChildren(fam: Family, ds: Dataset): ChildBirth[] {
  const out: ChildBirth[] = [];
  for (const childId of fam.children) {
    const child = ds.individuals.get(childId);
    if (!child) continue;
    const famc = child.raw.children.find((c) => c.tag === "FAMC" && c.value === fam.id);
    const pedi = famc?.children.find((c) => c.tag === "PEDI" || c.tag === "_MREL")?.value;
    if (pedi !== undefined && !BIOLOGICAL_PEDI.has(pedi.trim().toLowerCase())) continue;
    const d = birthDateOf(child);
    if (d?.year === undefined) continue;
    out.push({ indi: child, month: d.year * 12 + ((d.month ?? 6) - 1), year: d.year });
  }
  return out.sort((a, b) => a.month - b.month);
}

/** One mother whose children by two different partners are interleaved in time. */
interface ParallelFamilies {
  mother: Individual;
  /** The partner whose run of children brackets the child below. */
  partnerA: Individual;
  /** First and last birth year of the children with `partnerA`. */
  spanA: [number, number];
  /** The partner the bracketed child belongs to. */
  partnerB: Individual;
  /** A child by `partnerB` born in the middle of `partnerA`'s run. */
  child: ChildBirth;
}

/**
 * Mothers who bear children by two different fathers in the same years.
 *
 * Remarriage is normal and produces two *consecutive* runs of children; what is
 * impossible is an interleaved one — a child by the second partner born between
 * the first and last child of the other partner. That pattern means a child (or
 * a whole sibling set) hangs off the wrong family, or the same woman was merged
 * from two people.
 *
 * Only the mother side is checked: a father can genuinely have children by two
 * women at once. Both partners must be recorded and different, and the outside
 * child must clear both ends of the other run by at least one gestation, so
 * year-only dates and a posthumous last child don't trip it.
 */
function findParallelFamilies(ds: Dataset): ParallelFamilies[] {
  const found: ParallelFamilies[] = [];
  const TOL = MIN_BIRTH_INTERVAL_MONTHS;

  for (const mother of ds.individuals.values()) {
    if (mother.spouseOf.length < 2) continue;
    const runs: { partner: Individual; births: ChildBirth[] }[] = [];
    for (const famId of mother.spouseOf) {
      const fam = ds.families.get(famId);
      if (!fam || fam.wife !== mother.id) continue; // mother role only
      const partner = fam.husband ? ds.individuals.get(fam.husband) : undefined;
      if (!partner) continue; // an unknown father may well be the same man
      const births = datedBirthChildren(fam, ds);
      if (births.length) runs.push({ partner, births });
    }

    for (let i = 0; i < runs.length; i++) {
      for (let j = i + 1; j < runs.length; j++) {
        if (runs[i].partner.id === runs[j].partner.id) continue; // one couple, two family records
        // Either run can be the bracketing one; report the first hit.
        const hit =
          bracketed(runs[i], runs[j]) ?? bracketed(runs[j], runs[i]);
        if (hit) found.push({ mother, ...hit });
      }
    }
  }
  return found;

  /** A child of `outer.partner`'s counterpart born well inside `inner`'s run. */
  function bracketed(
    inner: { partner: Individual; births: ChildBirth[] },
    outer: { partner: Individual; births: ChildBirth[] },
  ): Omit<ParallelFamilies, "mother"> | undefined {
    const from = inner.births[0].month;
    const to = inner.births[inner.births.length - 1].month;
    if (to - from < 2 * TOL) return undefined;
    const child = outer.births.find((b) => b.month >= from + TOL && b.month <= to - TOL);
    if (!child) return undefined;
    return {
      partnerA: inner.partner,
      spanA: [inner.births[0].year, inner.births[inner.births.length - 1].year],
      partnerB: outer.partner,
      child,
    };
  }
}

export function validateDataset(ds: Dataset, currentYear: number = new Date().getFullYear()): ValidationReport {
  const issues: ValidationIssue[] = [];
  const counts: Record<IssueCategory, number> = { ...EMPTY_COUNTS };

  const push = (issue: ValidationIssue) => {
    issues.push(issue);
    counts[issue.category]++;
  };

  // Self-ancestor (FAMC) cycles, computed once over the whole parent graph.
  const pedigreeLoops = findPedigreeLoops(ds);

  for (const indi of ds.individuals.values()) {
    // The display subject (name + lifespan) costs two event scans and a string
    // build, but only a small fraction of individuals have any issue. Compute it
    // lazily on first use so clean records don't pay for it.
    let subject: string | undefined;
    const add = (
      category: IssueCategory,
      severity: IssueSeverity,
      messageKey: string,
      messageVars?: Record<string, string | number>,
    ) =>
      push({
        scope: "individual",
        id: indi.id,
        category,
        severity,
        subject: (subject ??= subjectOf(indi)),
        messageKey,
        messageVars,
      });

    // Name / sex completeness
    if (!indi.names.length || !indi.names[0]?.full?.trim()) {
      add("missingName", "warning", "tools.validate.issue.missingName");
    }
    if (indi.sex === "U") {
      add("missingSex", "warning", "tools.validate.issue.missingSex");
    }

    // Vital dates
    const by = birthYear(indi);
    const dy = deathYear(indi);
    if (by === undefined && dy === undefined) {
      add("missingVitals", "warning", "tools.validate.issue.missingVitals");
    }
    if (by !== undefined && dy !== undefined && dy < by) {
      add("deathBeforeBirth", "error", "tools.validate.issue.deathBeforeBirth", { birth: by, death: dy });
    } else if (by !== undefined && dy !== undefined && dy - by > AGE_LIMITS.death.max) {
      add("ageAtDeath", "warning", "tools.validate.issue.ageAtDeath", { age: dy - by, max: AGE_LIMITS.death.max });
    } else if (by !== undefined && !isDeceased(indi) && currentYear - by > AGE_LIMITS.death.max) {
      // No death evidence at all (an undated DEAT still counts as deceased),
      // yet the birth year puts them past the plausible lifespan — almost
      // always a missing death record, not a supercentenarian.
      add("livingTooOld", "warning", "tools.validate.issue.livingTooOld", {
        age: currentYear - by,
        max: AGE_LIMITS.death.max,
      });
    }

    // Events outside the lifespan: any other dated event before the birth year
    // or after the death year. The events the bounds come from can't trip this
    // (their year equals the bound); a death before the birth is already the
    // deathBeforeBirth error above, and burial/cremation/probate legitimately
    // follow a death. Family events (marriage, divorce, …) are checked against
    // the death only — a marriage before the birth already surfaces as an
    // implausible age at marriage.
    for (const e of indi.events) {
      const year = e.date?.year;
      if (year === undefined) continue;
      const isDeathTag = (DEATH_TAGS as readonly string[]).includes(e.tag);
      if (by !== undefined && year < by && !(isDeathTag && year === dy)) {
        add("eventOrder", "warning", "tools.validate.issue.eventBeforeBirth", { tag: e.tag, year, birth: by });
      } else if (dy !== undefined && year > dy && !isDeathTag && e.tag !== "PROB") {
        add("eventOrder", "warning", "tools.validate.issue.eventAfterDeath", { tag: e.tag, year, death: dy });
      }
    }
    if (dy !== undefined) {
      for (const famId of indi.spouseOf) {
        for (const e of ds.families.get(famId)?.events ?? []) {
          const year = e.date?.year;
          if (year !== undefined && year > dy) {
            add("eventOrder", "warning", "tools.validate.issue.eventAfterDeath", { tag: e.tag, year, death: dy });
          }
        }
      }
    }

    // Future dates
    const maxYear = maxEventYear(indi);
    if (maxYear !== undefined && maxYear > currentYear) {
      add("futureDate", "error", "tools.validate.issue.futureDate", { year: maxYear });
    }

    // Orphans: connected to no family at all.
    if (!indi.childOf.length && !indi.spouseOf.length) {
      add("orphan", "warning", "tools.validate.issue.orphan");
    }

    // Pedigree loop: this person is their own ancestor (a FAMC cycle).
    if (pedigreeLoops.has(indi.id)) {
      add("pedigreeLoop", "error", "tools.validate.issue.pedigreeLoop");
    }

    // Broken / non-reciprocal family pointers from the individual side.
    for (const famId of indi.childOf) {
      const fam = ds.families.get(famId);
      if (!fam) {
        add("brokenLink", "error", "tools.validate.issue.famcMissing", { fam: famId });
      } else if (!fam.children.includes(indi.id)) {
        add("brokenLink", "error", "tools.validate.issue.famcNotReciprocal", { fam: famId });
      }
    }
    for (const famId of indi.spouseOf) {
      const fam = ds.families.get(famId);
      if (!fam) {
        add("brokenLink", "error", "tools.validate.issue.famsMissing", { fam: famId });
      } else if (fam.husband !== indi.id && fam.wife !== indi.id) {
        add("brokenLink", "error", "tools.validate.issue.famsNotReciprocal", { fam: famId });
      }
    }

    // Two birth families: the person hangs off two different sets of parents.
    // Legitimate when one is adoptive or foster (excluded above), otherwise one
    // of the two links is wrong — or the person exists twice in the file.
    if (indi.childOf.length > 1) {
      const fams = birthParentFamilies(indi, ds);
      if (fams.length > 1) {
        add("multipleParents", "warning", "tools.validate.issue.multipleParents", {
          count: fams.length,
          families: fams.map((f) => coupleLabel(f, ds)).join("; "),
        });
      }
    }

    // A second parent family that names no parent at all — no HUSB, no WIFE.
    // It asserts nothing about this person's parentage, so it is a leftover
    // from an import or a merge rather than an alternative set of parents.
    // Only flagged when another parent family exists: a lone parentless FAMC
    // is the ordinary way to say "siblings known, parents unknown".
    if (indi.childOf.length > 1) {
      for (const famId of indi.childOf) {
        const fam = ds.families.get(famId);
        if (!fam || fam.husband || fam.wife) continue;
        add("parentlessFamily", "warning", "tools.validate.issue.parentlessFamily", { fam: famId });
      }
    }

    // Redundant pointer lines: the same family listed twice as FAMC/FAMS.
    for (const fam of duplicateRefs(indi.raw, "FAMC")) {
      add("duplicatePointer", "warning", "tools.validate.issue.dupFamc", { fam });
    }
    for (const fam of duplicateRefs(indi.raw, "FAMS")) {
      add("duplicatePointer", "warning", "tools.validate.issue.dupFams", { fam });
    }
  }

  // Age plausibility across family relationships (marriage age, parent age at a
  // child's birth, spouse age gap). All compared from recorded birth/marriage
  // years, so a finding means the years imply an unlikely age — likely a data error.
  for (const fam of ds.families.values()) {
    const husband = fam.husband ? ds.individuals.get(fam.husband) : undefined;
    const wife = fam.wife ? ds.individuals.get(fam.wife) : undefined;
    const hb = birthYear(husband);
    const wb = birthYear(wife);
    const marrYear = fam.events.find((e) => e.tag === "MARR")?.date?.year;

    // Role/sex contradiction: a HUSB recorded female or a WIFE recorded male.
    // SEX U is left alone (unknown, not contradictory). Reported on the person,
    // naming the partner they're married to (or the family if there's no partner).
    // A genuine same-sex couple (both spouses present, same known sex) is the
    // expected way to store such a marriage in GEDCOM — one partner in each
    // slot — so it is NOT a contradiction and is suppressed here.
    const sameSexCouple = isSameSexCouple(husband, wife);
    if (!sameSexCouple && husband && husband.sex === "F") {
      push({
        scope: "individual", id: husband.id, category: "roleSexConflict", severity: "error",
        subject: subjectOf(husband),
        messageKey: wife ? "tools.validate.issue.husbandFemale" : "tools.validate.issue.husbandFemaleNoSpouse",
        messageVars: wife ? { spouse: subjectOf(wife) } : { fam: fam.id },
      });
    }
    if (!sameSexCouple && wife && wife.sex === "M") {
      push({
        scope: "individual", id: wife.id, category: "roleSexConflict", severity: "error",
        subject: subjectOf(wife),
        messageKey: husband ? "tools.validate.issue.wifeMale" : "tools.validate.issue.wifeMaleNoSpouse",
        messageVars: husband ? { spouse: subjectOf(husband) } : { fam: fam.id },
      });
    }

    // Age at marriage, per spouse.
    if (marrYear !== undefined) {
      for (const sp of [husband, wife]) {
        const sb = birthYear(sp);
        if (!sp || sb === undefined) continue;
        const age = marrYear - sb;
        if (age < AGE_LIMITS.marriage.min || age > AGE_LIMITS.marriage.max) {
          push({
            scope: "individual", id: sp.id, category: "ageAtMarriage", severity: "warning",
            subject: subjectOf(sp), messageKey: "tools.validate.issue.ageAtMarriage",
            messageVars: { age, min: AGE_LIMITS.marriage.min, max: AGE_LIMITS.marriage.max },
          });
        }
      }
    }

    // Age difference between spouses — reported on the older partner.
    if (hb !== undefined && wb !== undefined && Math.abs(hb - wb) > AGE_LIMITS.spouseGap.max) {
      const older = (hb <= wb ? husband : wife)!;
      push({
        scope: "individual", id: older.id, category: "spouseAgeGap", severity: "warning",
        subject: subjectOf(older), messageKey: "tools.validate.issue.spouseAgeGap",
        messageVars: { gap: Math.abs(hb - wb), max: AGE_LIMITS.spouseGap.max },
      });
    }

    // Father/mother age at each child's birth — reported on the child.
    for (const childId of fam.children) {
      const child = ds.individuals.get(childId);
      const cb = birthYear(child);
      if (!child || cb === undefined) continue;
      if (hb !== undefined && (cb - hb < AGE_LIMITS.fatherAtBirth.min || cb - hb > AGE_LIMITS.fatherAtBirth.max)) {
        push({
          scope: "individual", id: child.id, category: "parentAge", severity: "warning",
          subject: subjectOf(child), messageKey: "tools.validate.issue.fatherAge",
          messageVars: { age: cb - hb, min: AGE_LIMITS.fatherAtBirth.min, max: AGE_LIMITS.fatherAtBirth.max },
        });
      }
      if (wb !== undefined && (cb - wb < AGE_LIMITS.motherAtBirth.min || cb - wb > AGE_LIMITS.motherAtBirth.max)) {
        push({
          scope: "individual", id: child.id, category: "parentAge", severity: "warning",
          subject: subjectOf(child), messageKey: "tools.validate.issue.motherAge",
          messageVars: { age: cb - wb, min: AGE_LIMITS.motherAtBirth.min, max: AGE_LIMITS.motherAtBirth.max },
        });
      }
    }
  }

  // Children by two different fathers born in the same years — reported on the mother.
  for (const p of findParallelFamilies(ds)) {
    push({
      scope: "individual", id: p.mother.id, category: "parallelFamilies", severity: "warning",
      subject: subjectOf(p.mother), messageKey: "tools.validate.issue.parallelFamilies",
      messageVars: {
        partnerA: subjectOf(p.partnerA),
        partnerB: subjectOf(p.partnerB),
        spanA: `${p.spanA[0]}–${p.spanA[1]}`,
        child: subjectOf(p.child.indi),
      },
    });
  }

  // Small groups linked only to each other — reported once, on the youngest,
  // who is where the search for the missing link starts.
  for (const group of findIslands(ds)) {
    const person = youngestOf(group);
    push({
      scope: "individual", id: person.id, category: "island", severity: "warning",
      subject: subjectOf(person), messageKey: "tools.validate.issue.island",
      messageVars: { count: group.length },
    });
  }

  // Broken pointers from the family side.
  for (const fam of ds.families.values()) {
    const subject = fam.id;
    const add = (messageKey: string, messageVars?: Record<string, string | number>) =>
      push({ scope: "family", id: fam.id, category: "brokenLink", severity: "error", subject, messageKey, messageVars });

    // Nobody at all is in this family — no spouses, no children. Partial
    // imports and merges leave these behind; no record points at one, so it is
    // invisible everywhere except here and in the saved file.
    if (!fam.husband && !fam.wife && fam.children.length === 0) {
      push({
        scope: "family", id: fam.id, category: "parentlessFamily", severity: "warning",
        subject, messageKey: "tools.validate.issue.familyNoMembers",
      });
    }

    for (const role of ["husband", "wife"] as const) {
      const ref = fam[role];
      if (ref && !ds.individuals.has(ref)) {
        add("tools.validate.issue.spouseMissing", { indi: ref });
      }
    }
    // Two different individuals crammed into one spouse slot — some exporters
    // write two HUSB (or two WIFE) lines for a same-sex couple. The typed model
    // keeps only the last, so the earlier partner(s) are invisible to the app
    // (though still serialized). Flag it and name who is hidden so the user can
    // move the extra partner into the empty opposite slot.
    for (const [tag, kept] of [["HUSB", fam.husband], ["WIFE", fam.wife]] as const) {
      const distinct = [...new Set(
        fam.raw.children.filter((c) => c.tag === tag && c.value).map((c) => c.value!.trim()),
      )];
      if (distinct.length < 2) continue;
      const nameFor = (id: string): string => {
        const i = ds.individuals.get(id);
        return i ? subjectOf(i) : id;
      };
      push({
        scope: "family", id: fam.id, category: "multiSpouseSlot", severity: "warning",
        subject, messageKey: "tools.validate.issue.multiSpouseSlot",
        messageVars: {
          shown: kept ? nameFor(kept) : "?",
          hidden: distinct.filter((id) => id !== kept).map(nameFor).join(", "),
        },
      });
    }
    for (const childId of fam.children) {
      if (!ds.individuals.has(childId)) {
        add("tools.validate.issue.childMissing", { indi: childId });
      }
    }
    // Redundant pointer lines: the same child listed twice as CHIL.
    for (const indiId of duplicateRefs(fam.raw, "CHIL")) {
      push({
        scope: "family", id: fam.id, category: "duplicatePointer", severity: "warning",
        subject, messageKey: "tools.validate.issue.dupChil", messageVars: { indi: indiId },
      });
    }
  }

  // Stable, useful ordering: errors first, then by category, then by subject.
  issues.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "error" ? -1 : 1;
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return a.subject.localeCompare(b.subject);
  });

  return {
    issues,
    counts,
    individualCount: ds.individuals.size,
    familyCount: ds.families.size,
  };
}
