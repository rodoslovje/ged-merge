import type { Dataset, GedNode, Individual } from "../gedcom/types";
import { birthYear, deathYear } from "../gedcom/lifespan";

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
 * Master-file health check.
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
  | "missingSex"
  | "missingName"
  | "missingVitals"
  | "orphan"
  | "deathBeforeBirth"
  | "ageAtDeath"
  | "ageAtMarriage"
  | "parentAge"
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
  missingSex: 0,
  missingName: 0,
  missingVitals: 0,
  orphan: 0,
  deathBeforeBirth: 0,
  ageAtDeath: 0,
  ageAtMarriage: 0,
  parentAge: 0,
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
    if (husband && husband.sex === "F") {
      push({
        scope: "individual", id: husband.id, category: "roleSexConflict", severity: "error",
        subject: subjectOf(husband),
        messageKey: wife ? "tools.validate.issue.husbandFemale" : "tools.validate.issue.husbandFemaleNoSpouse",
        messageVars: wife ? { spouse: subjectOf(wife) } : { fam: fam.id },
      });
    }
    if (wife && wife.sex === "M") {
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

  // Broken pointers from the family side.
  for (const fam of ds.families.values()) {
    const subject = fam.id;
    const add = (messageKey: string, messageVars?: Record<string, string | number>) =>
      push({ scope: "family", id: fam.id, category: "brokenLink", severity: "error", subject, messageKey, messageVars });

    for (const role of ["husband", "wife"] as const) {
      const ref = fam[role];
      if (ref && !ds.individuals.has(ref)) {
        add("tools.validate.issue.spouseMissing", { indi: ref });
      }
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
