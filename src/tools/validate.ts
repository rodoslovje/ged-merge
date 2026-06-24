import type { Dataset, Individual } from "../gedcom/types";
import { birthYear, deathYear } from "../gedcom/lifespan";

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
  | "missingSex"
  | "missingName"
  | "missingVitals"
  | "orphan"
  | "deathBeforeBirth"
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
  missingSex: 0,
  missingName: 0,
  missingVitals: 0,
  orphan: 0,
  deathBeforeBirth: 0,
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

export function validateDataset(ds: Dataset, currentYear: number = new Date().getFullYear()): ValidationReport {
  const issues: ValidationIssue[] = [];
  const counts: Record<IssueCategory, number> = { ...EMPTY_COUNTS };

  const push = (issue: ValidationIssue) => {
    issues.push(issue);
    counts[issue.category]++;
  };

  for (const indi of ds.individuals.values()) {
    const subject = subjectOf(indi);
    const add = (
      category: IssueCategory,
      severity: IssueSeverity,
      messageKey: string,
      messageVars?: Record<string, string | number>,
    ) => push({ scope: "individual", id: indi.id, category, severity, subject, messageKey, messageVars });

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
