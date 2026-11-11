// The narrative planner: turns a report entry's fact lines into an ordered
// list of abstract statements — "born (and baptized)", "married (again)",
// "they had N children", … — that the per-language renderer
// (report/narrativeText.ts + report/lang/*) phrases as sentences. Pure
// entry → statements logic, shared by both report directions, so combining
// rules (birth+baptism fused, children right after their union's marriage)
// live here once for every language.

import type { GedDate, Sex } from "../gedcom/types";
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
    | "divorced" // the union's divorce or annulment, after its children
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
  /** Married: the file records the couple as never married — the sentence
   *  names the partner instead of a wedding ("His partner was …"). */
  unmarried?: boolean;
  /** Married: the file records no marriage and no status for the couple —
   *  the sentence names a partner without saying whether they married. */
  unrecorded?: boolean;
  /** Married: any earlier union was told before this one (married or not) —
   *  a partner sentence then opens with "later". */
  later?: boolean;
  /** Married: the couple's first child was born before the dated wedding
   *  ("his partner and later wife …; they married only in …"). */
  late?: boolean;
  /** Married: a remarriage after the previous spouse's death — `fact2` then
   *  carries that death ("Widowed in 1890, …"). */
  widowed?: boolean;
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
export function childGroups(
  data: ReportData,
  // How a child is named in the sentence — under privacy the same redacted
  // name its own entry shows, or a living child would be named in the
  // parent's paragraph after all.
  nameOf: (e: ReportEntry) => string = (e) => e.name,
): Map<number, ChildGroup[]> {
  const byParent = new Map<number, ChildGroup[]>();
  for (const g of data.generations) {
    for (const e of g.entries) {
      if (e.parentNum === undefined || e.parentFam === undefined) continue;
      const groups = byParent.get(e.parentNum) ?? [];
      if (groups.length === 0) byParent.set(e.parentNum, groups);
      let group = groups.find((x) => x.fam === e.parentFam);
      if (!group) groups.push((group = { fam: e.parentFam, names: [] }));
      group.names.push(nameOf(e));
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
  // Each union sits in the story at its wedding, or — undated, or with
  // children born before it — at its first child's birth; the unions are then
  // walked in that order, so "again" and "widowed" read the life as told.
  const unions = marriages
    .map((m) => {
      const wed = dateKey(m);
      const child = m.firstChildBorn ? gedDateKey(m.firstChildBorn) : undefined;
      return { m, key: wed === undefined ? child : child === undefined ? wed : Math.min(wed, child) };
    })
    .sort((a, b) => (a.key ?? Infinity) - (b.key ?? Infinity));
  let prevMarriage: FactLine | undefined;
  unions.forEach(({ m, key }, index) => {
    const bothLiving = entry.living && m.spouseLiving === true;
    // The partner's lifespan joins their name (like the register's ⚭ line);
    // a living partner keeps the name but loses the years under privacy.
    const years = m.spouseYears && !(priv && m.spouseLiving) ? ` (${m.spouseYears})` : "";
    // "Again" counts marriages only — a partnership (recorded as such, or a
    // union with no marriage record) before the first wedding doesn't make
    // that wedding a remarriage. A previous spouse who died
    // before this (dated) wedding makes it a widower's/widow's remarriage,
    // unless that marriage had already ended in a divorce or annulment (a
    // separation leaves the marriage standing until the death).
    const again = prevMarriage !== undefined;
    const late = !m.unmarried && !!m.parsed && !!m.firstChildBorn && isBefore(m.firstChildBorn, m.parsed);
    const dissolved = !!prevMarriage?.ended && prevMarriage.ended.tag !== "SEPA";
    const widowed =
      again && !m.unmarried && !!m.parsed && !dissolved &&
      !!prevMarriage!.spouseDied && isBefore(prevMarriage!.spouseDied, m.parsed);
    const stmts: Omit<Statement, "subject">[] = [
      {
        kind: "married",
        fact: m,
        ...(widowed ? { fact2: { tag: "DEAT", glyph: "", parsed: prevMarriage!.spouseDied, date: undefined } } : null),
        spouse: m.spouse && `${m.spouse}${years}`,
        again,
        unmarried: m.unmarried,
        unrecorded: m.unrecorded,
        later: index > 0,
        late,
        widowed,
        living: bothLiving,
      },
    ];
    if (!m.unmarried && !m.unrecorded) prevMarriage = m;
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
    if (m.ended) stmts.push({ kind: "divorced", fact: m.ended });
    blocks.push({ key, stmts });
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

/** A date's sort key on the scale {@link factDateKey} uses. */
function gedDateKey(d: GedDate): number | undefined {
  return d.year === undefined ? undefined : d.year * 10000 + (d.month ?? 0) * 100 + (d.day ?? 0);
}

/**
 * Whether `a` is certainly earlier than `b`: each date is read as the span of
 * days it can mean, and `a`'s latest day must fall before `b`'s earliest.
 * "1866" is not before "4 FEB 1866" (same year, month unknown), "MAR 1865" is;
 * a bound narrows only one side — "BEF 1866" ends before 1866 starts, "AFT
 * 1891" starts after 1891 ends, "BET 1860 AND 1865" spans both years. An
 * approximate date (ABT, EST, CAL) has no edge at all and never counts — the
 * sentence it would trigger states a fact, not a guess.
 */
export function isBefore(a: GedDate, b: GedDate): boolean {
  const ra = dateSpan(a);
  const rb = dateSpan(b);
  return !!ra && !!rb && ra[1] < rb[0];
}

/** The earliest and latest day keys a date can mean, or undefined when it has
 *  no firm edges (approximate, placeholder, unparsed, open periods). */
function dateSpan(d: GedDate): [number, number] | undefined {
  if (d.placeholder || d.year === undefined) return undefined;
  const lo = (y: number, m?: number, day?: number) => y * 10000 + (m ?? 1) * 100 + (day ?? 1);
  const hi = (y: number, m?: number, day?: number) => y * 10000 + (m ?? 12) * 100 + (day ?? 31);
  switch (d.qualifier) {
    case "exact":
    case "interpreted":
      return [lo(d.year, d.month, d.day), hi(d.year, d.month, d.day)];
    case "before":
      return [-Infinity, lo(d.year, d.month, d.day) - 1];
    case "after":
      return [hi(d.year, d.month, d.day) + 1, Infinity];
    case "between":
      return d.year2 === undefined ? undefined : [lo(d.year, d.month, d.day), hi(d.year2, d.month2, d.day2)];
    default:
      return undefined;
  }
}

/** The opening variant for the i-th of n same-kind statements: the first is
 *  plain, a run of three or more closes with "finally", and the middle ones
 *  alternate "then"/"next" so no two neighbours start alike. */
function seqVariant(i: number, n: number): Statement["variant"] {
  if (i === 0) return undefined;
  if (i === n - 1 && n >= 3) return "finally";
  return i % 2 === 1 ? "then" : "next";
}
