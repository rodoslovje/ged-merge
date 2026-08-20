// The narrative planner: turns a report entry's fact lines into an ordered
// list of abstract statements — "born (and baptized)", "married (again)",
// "they had N children", … — that the per-language renderer
// (report/narrativeText.ts + report/lang/*) phrases as sentences. Pure
// entry → statements logic, shared by both report directions, so combining
// rules (birth+baptism fused, children right after their union's marriage)
// live here once for every language.

import type { Sex } from "../gedcom/types";
import { factDateKey, type ReportData, type ReportEntry } from "./model";
import type { FactLine } from "./model";

/** How a sentence refers to the person: the first statement names them, the
 *  rest use the language's short form (pronoun in English, bare verb form in
 *  Slovenian). People of unknown sex are always named — no language here has
 *  a safe unknown-sex short form. */
export type SubjectForm = "name" | "pronoun";

export interface Statement {
  kind:
    | "bornBaptized" // birth + baptism fused into one sentence
    | "born"
    | "baptized"
    | "married" // one per union, in record order; `again` from the 2nd on
    | "spouseOrigin" // the partner's parents, right after their marriage
    | "children" // a union's children (register only)
    | "occupation"
    | "education"
    | "residence"
    | "diedBuried" // death + burial/cremation fused into one sentence
    | "died"
    | "buried";
  subject: SubjectForm;
  /** The primary fact (the birth of bornBaptized, the death of diedBuried). */
  fact?: FactLine;
  /** The fused second fact (the baptism / the burial). */
  fact2?: FactLine;
  /** Married: the partner's display name, when known. */
  spouse?: string;
  /** Married: a repeat marriage (2nd or later union with a ⚭ fact). */
  again?: boolean;
  /** SpouseOrigin: the partner's sex — it picks the possessive/kin word
   *  ("Her parents…" / "Njegova starša…"), which follows the partner. */
  spouseSex?: Sex;
  /** SpouseOrigin: the partner's parents' display names (either may be
   *  missing; the renderer picks the father-/mother-only sentence). */
  father?: string;
  mother?: string;
  /** Married: both partners presumed living — present tense ("njegova žena
   *  je …" instead of "je bila"). Children: the parents (couple form) or the
   *  subject (solo form) presumed living ("imata" instead of "imela sta"). */
  living?: boolean;
  /** Children: the union's children's display names, in birth order. */
  childNames?: string[];
  /** Children: the sentence follows this union's marriage statement, so the
   *  couple form ("They had …") reads unambiguously. Without it the renderer
   *  falls back to the single-parent form ("He had …"). */
  couple?: boolean;
  /** Repeated residences/occupations vary their opening so a run of them
   *  doesn't read "He lived… He lived… He lived…": "then" / "next" alternate
   *  through the middle, "finally" closes a run of three or more. */
  variant?: "then" | "next" | "finally";
}

/** A union's children as listed in the register (names in birth order). */
export interface ChildGroup {
  fam: string;
  names: string[];
}

/**
 * The children of every union, grouped per descendant parent's register
 * number — gathered from the next generations' entries, which already carry
 * `parentNum` / `parentFam` in birth order. Empty for the Ahnentafel
 * (ancestor entries have no `parentNum`), so ancestor narratives simply get
 * no children sentences — each child is the previous entry anyway.
 */
export function childGroups(data: ReportData): Map<number, ChildGroup[]> {
  const byParent = new Map<number, ChildGroup[]>();
  for (const g of data.generations) {
    for (const e of g.entries) {
      if (e.parentNum === undefined || e.parentFam === undefined) continue;
      const groups = byParent.get(e.parentNum) ?? [];
      if (groups.length === 0) byParent.set(e.parentNum, groups);
      let group = groups.find((x) => x.fam === e.parentFam);
      if (!group) groups.push((group = { fam: e.parentFam, names: [] }));
      group.names.push(e.name);
    }
  }
  return byParent;
}

/**
 * Plan an entry's narrative: vitals fused where both halves exist, each
 * union's marriage followed by that union's children, the optional mid-life
 * facts, then death/burial. Duplicate entries (`dupOf`) plan to nothing —
 * their line continues at the first appearance, which the views already show.
 */
export function planEntry(
  entry: ReportEntry,
  groups: ChildGroup[] = [],
  opts: { privacyLiving?: boolean } = {},
): Statement[] {
  if (entry.dupOf !== undefined) return [];
  const priv = !!opts.privacyLiving;

  const first = (tags: string[]) => entry.facts.find((f) => tags.includes(f.tag));
  const all = (tags: string[]) => entry.facts.filter((f) => tags.includes(f.tag));

  const birth = first(["BIRT"]);
  const baptism = first(["BAPM", "CHR"]);
  const death = first(["DEAT"]);
  const burial = first(["BURI", "CREM"]);
  const marriages = all(["MARR"]);

  const out: Statement[] = [];
  const add = (s: Omit<Statement, "subject">) =>
    out.push({ subject: out.length === 0 ? "name" : "pronoun", ...s });

  if (birth && baptism) add({ kind: "bornBaptized", fact: birth, fact2: baptism });
  else if (birth) add({ kind: "born", fact: birth });
  else if (baptism) add({ kind: "baptized", fact: baptism });

  // The mid-life statements interleave chronologically: each union (its ⚭
  // sentence with the partner's origin and that union's children right after,
  // so the couple wording stays unambiguous across remarriages) is one block
  // anchored at the marriage date; occupations, schooling and residences are
  // their own blocks. Dated blocks sort by date; undated ones follow the dated
  // run in the structural order (marriages, work, schooling, homes) — only
  // birth opens and death closes the story regardless of the dates between.
  interface Block {
    key?: number;
    stmts: Omit<Statement, "subject">[];
  }
  const blocks: Block[] = [];
  const dateKey = factDateKey;

  const told = new Set<string>();
  marriages.forEach((m, i) => {
    const bothLiving = entry.living && m.spouseLiving === true;
    // The partner's lifespan joins their name (like the register's ⚭ line);
    // a living partner keeps the name but loses the years under privacy.
    const years = m.spouseYears && !(priv && m.spouseLiving) ? ` (${m.spouseYears})` : "";
    const stmts: Omit<Statement, "subject">[] = [
      { kind: "married", fact: m, spouse: m.spouse && `${m.spouse}${years}`, again: i > 0, living: bothLiving },
    ];
    // The partner's parents, told right after the marriage that names them; a
    // living parent's name stays out under privacy. `living` carries the named
    // parents' tense (present only when all of them are presumed living).
    const father = m.spouseFather && !(priv && m.spouseFather.living) ? m.spouseFather.name : undefined;
    const mother = m.spouseMother && !(priv && m.spouseMother.living) ? m.spouseMother.name : undefined;
    if (father || mother) {
      const parentsLiving = (father ? !!m.spouseFather?.living : true) && (mother ? !!m.spouseMother?.living : true);
      stmts.push({ kind: "spouseOrigin", spouseSex: m.spouseSex, father, mother, living: parentsLiving });
    }
    const group = m.fam !== undefined ? groups.find((g) => g.fam === m.fam) : undefined;
    if (group && group.names.length > 0) {
      told.add(group.fam);
      stmts.push({ kind: "children", childNames: group.names, couple: true, living: bothLiving });
    }
    blocks.push({ key: dateKey(m), stmts });
  });
  // Children of unions without a ⚭ fact (no partner and no dated marriage):
  // single-parent wording, undated — they follow the dated run.
  for (const group of groups) {
    if (told.has(group.fam) || group.names.length === 0) continue;
    blocks.push({ stmts: [{ kind: "children", childNames: group.names, living: entry.living }] });
  }

  all(["OCCU"]).forEach((f, i) =>
    blocks.push({ key: dateKey(f), stmts: [{ kind: "occupation", fact: f, variant: i > 0 ? "then" : undefined }] }));
  for (const f of all(["EDUC"])) blocks.push({ key: dateKey(f), stmts: [{ kind: "education", fact: f }] });
  const resis = all(["RESI"]);
  resis.forEach((f, i) =>
    blocks.push({ key: dateKey(f), stmts: [{ kind: "residence", fact: f, variant: seqVariant(i, resis.length) }] }));

  // Stable sort: dated blocks ascending, undated after them in insertion order.
  blocks.sort((a, b) => (a.key ?? Infinity) - (b.key ?? Infinity));
  for (const b of blocks) b.stmts.forEach(add);

  if (death && burial) add({ kind: "diedBuried", fact: death, fact2: burial });
  else if (death) add({ kind: "died", fact: death });
  else if (burial) add({ kind: "buried", fact: burial });

  return out;
}

/** The opening variant for the i-th of n same-kind statements: the first is
 *  plain, a run of three or more closes with "finally", and the middle ones
 *  alternate "then"/"next" so no two neighbours start alike. */
function seqVariant(i: number, n: number): Statement["variant"] {
  if (i === 0) return undefined;
  if (i === n - 1 && n >= 3) return "finally";
  return i % 2 === 1 ? "then" : "next";
}
