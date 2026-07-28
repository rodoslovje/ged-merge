// Shared shapes and fact-line helpers for the report builders (the Ahnentafel
// ancestor list and the descendant register). Pure dataset → entries logic,
// kept apart from the builders so both compose the same vocabulary: compact
// glyph fact lines (* born, ~ baptized, ⚭ married, † died, ▭ buried).

import type { Dataset, Family, GedDate, GedEvent, Individual, Sex, SourceCitation } from "../gedcom/types";
import { birthYear, deathYear, formatLifespan, isDeceased, isPresumedLiving } from "../gedcom/lifespan";
import { ageAtDate } from "../gedcom/age";
import type { Translate } from "../locales/i18n";
import { EVENT_GLYPHS } from "../chart/timeline";
import { MARRIAGE_SYMBOL } from "../chart/nodeDisplay";

/** Name formatter injected by the UI (honours the Name-display settings). */
export type { NameOf } from "../chart/timeline";
import type { NameOf } from "../chart/timeline";

/** One fact line under an entry: `⚭ 4 FEB 1866, Škofja Loka — Marija Oblak`. */
export interface FactLine {
  /** The event tag the line came from (BIRT, BAPM, MARR, DEAT, OCCU, …). */
  tag: string;
  /** Classic genealogy symbol (* ~ ⚭ † ▭ ⚒ ✎ ⌂ — see {@link EVENT_GLYPHS}). */
  glyph: string;
  /** The event's own value, leading the line ("Farmer" on an occupation). */
  value?: string;
  /** Original date text, exactly as recorded. */
  date?: string;
  /** The structured date, for renderers that re-phrase it (narrative prose). */
  parsed?: GedDate;
  place?: string;
  /** The recorded street address alone (ADDR), for renderers that phrase it
   *  differently from the place ("at Dunajska 5" vs "in Kranj"). */
  addr?: string;
  /** The event's AGNC — the parish, school or office behind the event; the
   *  narrative appends it to the sentence ("at Župnija Stražišče"). */
  agency?: string;
  /** The event's CAUS (practically: cause of death), appended by the
   *  narrative as a nominative-safe aside ("(vzrok: pljučnica)"). */
  cause?: string;
  /** The place hierarchy parts (most specific first), so the narrative can
   *  drop duplicated jurisdictions and re-space the commas. */
  placeParts?: string[];
  /** Marriage lines carry the partner's display name. */
  spouse?: string;
  /** Whether the named partner is presumed living — the narrative needs the
   *  tense ("njegova žena je" vs "je bila"). Undefined when unknown. */
  spouseLiving?: boolean;
  /** Marriage lines carry the union's family xref, so the narrative can pair
   *  each marriage sentence with that union's children. */
  fam?: string;
  /** The event's note, shown under the fact line when notes are enabled. */
  note?: string;
  /** The event's formatted source citations, when enabled. */
  sources?: SourceLine[];
  /** The subject's own whole-years age at this dated event (personal events
   *  only — not birth/marriage, which carry {@link ages} instead). */
  age?: number;
  /** Sex-tagged ages for events about a couple: a marriage carries both
   *  spouses ("♂32", "♀28"); a birth carries the parents. */
  ages?: string[];
}

/** One rendered citation: the "§ title" text, the cited page kept separate
 *  (so renderers can label it in the report language — "stran 23"), plus the
 *  best link the citation resolver found (exact cited page, source image, or
 *  repository). Compose the display text with {@link sourceLabel}. */
export interface SourceLine {
  text: string;
  page?: string;
  url?: string;
}

/** A citation's display text with the localized page label:
 *  "§ Krstna knjiga, page 23" / "…, stran 23". */
export function sourceLabel(t: Translate, src: SourceLine): string {
  return src.page ? `${src.text}, ${t("report.source.page", { page: src.page })}` : src.text;
}

/** The optional fact lines a report can add beyond the vitals. */
export interface ReportFactOptions {
  occupation?: boolean;
  education?: boolean;
  residence?: boolean;
  /** Show the age reached at each dated fact: the person's own age on their
   *  personal events, and the sex-tagged pair (♂ / ♀) on a marriage (both
   *  spouses) and a birth (the parents). */
  age?: boolean;
  /** Person notes after the fact lines, event notes under their fact line. */
  notes?: boolean;
  /** Person sources after the person notes, event sources under their fact line. */
  sources?: boolean;
}

/** One numbered person in a report. */
export interface ReportEntry {
  num: number;
  id: string;
  sex: Sex;
  name: string;
  /** Lifespan label ("1817–1921", "1817–", …) — may be "". */
  years: string;
  living: boolean;
  /** The person already appeared under this number (pedigree collapse /
   *  descendant intermarriage) and their line continues there — this entry
   *  carries no facts of its own. */
  dupOf?: number;
  /** Register report: the parent entry this person is grouped under. */
  parentNum?: number;
  /** Register report: the descendant parent, for the group heading (children
   *  are grouped per union, and the heading names both parents like any
   *  other name — sex-coloured, with the lifespan). */
  parent?: PersonRef;
  /** Register report: the other parent. */
  parentSpouse?: PersonRef;
  /** Register report: the union's family xref (the grouping boundary — a
   *  parent's remarriage starts a new children list). */
  parentFam?: string;
  /** Register report: position among the union's children in birth order
   *  (1-based), rendered as the NGSQ roman numeral (I, II, III …). */
  childIndex?: number;
  /** Record-level person notes, shown after the fact lines when enabled. */
  notes?: string[];
  /** Record-level source citations, when enabled. */
  sources?: SourceLine[];
  facts: FactLine[];
}

/** A person referenced by a heading: enough to render the name like an
 *  entry's (sex colour, lifespan, privacy redaction). */
export interface PersonRef {
  id: string;
  name: string;
  sex: Sex;
  years: string;
  living: boolean;
}

export function personRef(indi: Individual, nameOf: NameOf, nowYear: number, ds: Dataset): PersonRef {
  return {
    id: indi.id,
    name: nameOf(indi),
    sex: indi.sex,
    years: formatLifespan(birthYear(indi), deathYear(indi), isDeceased(indi)),
    living: isPresumedLiving(indi, ds, nowYear) || !!indi.private,
  };
}

/** Uppercase roman numeral for an NGSQ child index (1 → I, 4 → IV …). */
export function romanIndex(n: number): string {
  const steps: [number, string][] = [
    [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"],
    [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
  ];
  let out = "";
  for (const [value, numeral] of steps) {
    while (n >= value) {
      out += numeral;
      n -= value;
    }
  }
  return out;
}

export interface ReportGeneration {
  /** 0 = the root person, then one step per generation away from them. */
  gen: number;
  entries: ReportEntry[];
}

export interface ReportData {
  generations: ReportGeneration[];
  /** Distinct people across all generations. A repeat entry (`dupOf` — pedigree
   *  collapse, or a couple whose both spouses descend from the root) is the same
   *  person met again and is not counted a second time. */
  total: number;
  /** Generations the chart-settings generation limit left off the end of this
   *  report. Absent when the report runs to the end of the line. */
  truncated?: number;
}

/** A generation's band heading: "Generation 2 — Grandparents" plus the
 *  number range its entries span ("nos. 4–7") and, for ancestors, how many
 *  of the generation's slots are filled ("3 of 4 known"). */
export interface GenerationHeading {
  title: string;
  range?: string;
  coverage?: string;
}

/** The localized band heading for a generation, per report direction. */
export function generationHeading(
  t: Translate,
  g: ReportGeneration,
  direction: "ancestors" | "descendants",
): GenerationHeading {
  // The root band needs no "no. 1" — it always holds exactly the root.
  if (g.gen === 0) return { title: t("report.gen.root") };
  const nums = g.entries.map((e) => e.num);
  const range =
    nums.length === 0
      ? undefined
      : nums.length === 1
        ? t("report.gen.no", { n: nums[0] })
        : t("report.gen.nos", { from: Math.min(...nums), to: Math.max(...nums) });
  // Ancestor generations have a fixed slot count (2^gen), so the entry count
  // doubles as a research-coverage measure. Descendant counts are open-ended.
  const coverage =
    direction === "ancestors"
      ? t("report.gen.known", { known: g.entries.length, of: 2 ** g.gen })
      : undefined;
  const genN = t("report.gen.n", { n: g.gen });
  // Beyond great-grandparents/-children there's no everyday word — the
  // numbered title stands alone.
  if (g.gen > 3) return { title: genN, range, coverage };
  const word = t(`${direction === "ancestors" ? "ahnentafel" : "register"}.gen.${g.gen}`);
  return { title: `${genN} — ${word}`, range, coverage };
}

/** The closing "N more generations are not listed" line for a report the
 *  generation limit cut short (undefined for a complete one). The limit is the
 *  generations actually printed, so it needs no extra plumbing. Shared by the
 *  page, the text / RTF downloads and the print sheet. */
export function truncationNote(t: Translate, data: ReportData): string | undefined {
  if (data.truncated === undefined) return undefined;
  return t("report.genLimit", { count: data.truncated, limit: data.generations.length - 1 });
}

/** The optional table of contents: one row per generation — the heading title
 *  with the entry-number range as the reference (the reports have no page
 *  numbers) — paired with its gen number so renderers can link the row to
 *  the section (page scroll, print anchor, RTF bookmark). */
export function tocRows(
  t: Translate,
  data: ReportData,
  direction: "ancestors" | "descendants",
): { gen: number; label: string }[] {
  return data.generations.map((g) => {
    const h = generationHeading(t, g, direction);
    return { gen: g.gen, label: [h.title, h.range].filter(Boolean).join(" · ") };
  });
}

/** Attach the record-level notes/sources the options ask for (never on dups).
 *  Notes keep their URLs — the report shows them verbatim. */
export function personExtras(entry: ReportEntry, indi: Individual, opts: ReportFactOptions): void {
  const notes = indi.notesWithLinks ?? indi.notes;
  if (opts.notes && notes?.length) entry.notes = notes;
  if (opts.sources && indi.sources?.length) entry.sources = indi.sources.map(sourceLine);
}

export function makeEntry(
  indi: Individual,
  num: number,
  nameOf: NameOf,
  facts: FactLine[],
  nowYear: number,
  dupOf: number | undefined,
  ds: Dataset,
): ReportEntry {
  return {
    num,
    id: indi.id,
    sex: indi.sex,
    name: nameOf(indi),
    years: formatLifespan(birthYear(indi), deathYear(indi), isDeceased(indi)),
    living: isPresumedLiving(indi, ds, nowYear) || !!indi.private,
    dupOf,
    facts: dupOf === undefined ? facts : [],
  };
}

/** The optional mid-life fact lines: every ⚒ occupation, ✎ education and
 *  ⌂ residence, in record order per kind — glyphs from the shared
 *  {@link EVENT_GLYPHS}, so the Timeline draws the same marks. */
export function extraFacts(indi: Individual, opts: ReportFactOptions): FactLine[] {
  const out: FactLine[] = [];
  if (opts.occupation) {
    for (const e of indi.events) {
      if (e.tag !== "OCCU" || (!e.value && !dated(e))) continue;
      out.push(withAge(withNote({ tag: "OCCU", glyph: EVENT_GLYPHS.OCCU, value: e.value, date: e.date?.raw, parsed: e.date, place: factPlace(e), ...factWhere(e) }, e, opts), indi, e.date, undefined, opts));
    }
  }
  if (opts.education) {
    for (const e of indi.events) {
      if (e.tag !== "EDUC" || (!e.value && !dated(e))) continue;
      out.push(withAge(withNote({ tag: "EDUC", glyph: EVENT_GLYPHS.EDUC, value: e.value, date: e.date?.raw, parsed: e.date, place: factPlace(e), ...factWhere(e) }, e, opts), indi, e.date, undefined, opts));
    }
  }
  if (opts.residence) {
    for (const e of indi.events) {
      if (e.tag !== "RESI" || !dated(e)) continue;
      out.push(withAge(withNote({ tag: "RESI", glyph: EVENT_GLYPHS.RESI, date: e.date?.raw, parsed: e.date, place: factPlace(e), ...factWhere(e) }, e, opts), indi, e.date, undefined, opts));
    }
  }
  return out;
}

/** A fact line for the first of the given events that has a date or a place.
 *  `ds` (when given) lets a birth line carry the parents' ages. */
export function factFor(indi: Individual, tags: string[], opts: ReportFactOptions = {}, ds?: Dataset): FactLine | undefined {
  for (const tag of tags) {
    const e = indi.events.find((ev) => ev.tag === tag);
    if (e && dated(e)) {
      const fact = withNote({ tag, glyph: EVENT_GLYPHS[tag], date: e.date?.raw, parsed: e.date, place: factPlace(e), ...factWhere(e) }, e, opts);
      return withAge(fact, indi, e.date, ds, opts);
    }
  }
  return undefined;
}

/** The union's ⚭ line, when its MARR event carries a date or a place. */
export function marriageFact(
  fam: Family,
  spouse: string | undefined,
  opts: ReportFactOptions = {},
  spouseLiving?: boolean,
  ds?: Dataset,
): FactLine | undefined {
  const marr = fam.events.find((e) => e.tag === "MARR");
  if (!marr || !dated(marr)) return undefined;
  const fact = withNote(
    {
      tag: "MARR",
      glyph: MARRIAGE_SYMBOL,
      date: marr.date?.raw,
      parsed: marr.date,
      place: factPlace(marr),
      ...factWhere(marr),
      spouse,
      spouseLiving,
      fam: fam.id,
    },
    marr,
    opts,
  );
  if (opts.age && ds) fact.ages = coupleAges(fam, ds, marr.date);
  return fact;
}

function withNote(fact: FactLine, e: GedEvent, opts: ReportFactOptions): FactLine {
  const note = e.noteWithLinks ?? e.note;
  if (opts.notes && note) fact.note = note;
  if (opts.sources && e.sources?.length) fact.sources = e.sources.map(sourceLine);
  return fact;
}

/** "♂35" / "♀30": one person's sex-tagged age at `at`, or undefined if unknown. */
function sexAge(indi: Individual | undefined, glyph: string, at: GedDate | undefined): string | undefined {
  const age = ageAtDate(indi, at);
  return age === undefined ? undefined : `${glyph}${age}`;
}

/** The parents' sex-tagged ages (♂ father, ♀ mother) at a person's birth —
 *  each parent taken from the first child-family that records that role. */
function parentAges(indi: Individual, ds: Dataset, at: GedDate | undefined): string[] | undefined {
  const families = indi.childOf.map((id) => ds.families.get(id)).filter((f): f is Family => f !== undefined);
  const father = families.find((f) => f.husband && ds.individuals.has(f.husband))?.husband;
  const mother = families.find((f) => f.wife && ds.individuals.has(f.wife))?.wife;
  const ages = [
    sexAge(father ? ds.individuals.get(father) : undefined, "♂", at),
    sexAge(mother ? ds.individuals.get(mother) : undefined, "♀", at),
  ].filter((s): s is string => s !== undefined);
  return ages.length ? ages : undefined;
}

/** Both spouses' sex-tagged ages (♂ husband, ♀ wife) at a marriage. */
function coupleAges(fam: Family, ds: Dataset, at: GedDate | undefined): string[] | undefined {
  const ages = [
    sexAge(fam.husband ? ds.individuals.get(fam.husband) : undefined, "♂", at),
    sexAge(fam.wife ? ds.individuals.get(fam.wife) : undefined, "♀", at),
  ].filter((s): s is string => s !== undefined);
  return ages.length ? ages : undefined;
}

/** Attach the age to a personal fact when the Age option is on: the parents'
 *  ages on a birth (the child's birth), or the subject's own age otherwise. */
function withAge(fact: FactLine, indi: Individual, at: GedDate | undefined, ds: Dataset | undefined, opts: ReportFactOptions): FactLine {
  if (!opts.age) return fact;
  if (fact.tag === "BIRT") {
    if (ds) fact.ages = parentAges(indi, ds, at);
  } else {
    const age = ageAtDate(indi, at);
    if (age !== undefined) fact.age = age;
  }
  return fact;
}

/** The parenthetical age for a fact's date in the compact list/text/RTF
 *  renderings: "(62)" for the subject's own age, "(♂32 ♀28)" for a marriage or
 *  a birth (both partners / the parents). Undefined when no age is attached. */
export function factAgeSuffix(f: FactLine): string | undefined {
  if (f.ages?.length) return `(${f.ages.join(" ")})`;
  if (f.age !== undefined) return `(${f.age})`;
  return undefined;
}

/** A citation as one compact "§ title" line, its cited page and resolved link. */
export function sourceLine(s: SourceCitation): SourceLine {
  return { text: `§ ${s.title || s.sourceId}`, page: s.page, url: s.url };
}

/** A fact's display location. Unlike the Timeline's compact one-word labels,
 *  the report keeps everything exactly as recorded: the complete street
 *  address followed by the complete place hierarchy — "Dunajska 5, Kranj,
 *  Slovenija" when both are recorded, either one alone otherwise. */
export function factPlace(e: GedEvent): string | undefined {
  const addr = e.address?.raw;
  const loc = e.place?.raw;
  const parts = addr === loc ? [addr] : [addr, loc];
  return parts.filter(Boolean).join(", ") || undefined;
}

/** The location split for the narrative renderer: the address on its own
 *  (unless it merely repeats the place) plus the place hierarchy parts. The
 *  list renderer keeps using the verbatim `place` string. */
function factWhere(e: GedEvent): Pick<FactLine, "addr" | "placeParts" | "agency" | "cause"> {
  const addr = e.address?.raw;
  return {
    addr: addr && addr !== e.place?.raw ? addr : undefined,
    placeParts: e.place?.parts,
    agency: e.agency,
    cause: e.cause,
  };
}

export function dated(e: GedEvent): boolean {
  return !!e.date?.raw || !!factPlace(e);
}

/** Resolve family ids to their records, keeping order, dropping dangling refs. */
export function familiesOf(ds: Dataset, ids: string[]): Family[] {
  return ids.map((id) => ds.families.get(id)).filter((f): f is Family => f !== undefined);
}

/** Every union's ⚭ line for a person, in record order — partner named and
 *  their living status attached (the narrative's tense needs it). Used by the
 *  register for all entries and by the Ahnentafel for the root, whose spouse
 *  isn't an ancestor and would otherwise go unmentioned. */
export function marriageFacts(
  ds: Dataset,
  indi: Individual,
  nameOf: NameOf,
  opts: ReportFactOptions,
  nowYear: number,
): FactLine[] {
  return familiesOf(ds, indi.spouseOf)
    .map((fam) => {
      const partnerId = fam.husband === indi.id ? fam.wife : fam.husband;
      const partner = partnerId ? ds.individuals.get(partnerId) : undefined;
      return marriageFact(fam, partner && nameOf(partner), opts, partner && (isPresumedLiving(partner, ds, nowYear) || !!partner.private), ds);
    })
    .filter((f): f is FactLine => f !== undefined);
}
