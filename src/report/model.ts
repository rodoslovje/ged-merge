// Shared shapes and fact-line helpers for the report builders (the Ahnentafel
// ancestor list and the descendant register). Pure dataset → entries logic,
// kept apart from the builders so both compose the same vocabulary: compact
// glyph fact lines (* born, ~ baptized, ⚭ married, † died, ▭ buried).

import type { Dataset, Family, GedEvent, Individual, Sex } from "../gedcom/types";
import { birthYear, deathYear, formatLifespan, isDeceased, isPresumedLiving } from "../gedcom/lifespan";
import type { Translate } from "../locales/i18n";
import { EVENT_GLYPHS } from "../tree/timeline";
import { MARRIAGE_SYMBOL } from "../tree/nodeDisplay";

/** Name formatter injected by the UI (honours the Name-display settings). */
export type { NameOf } from "../tree/timeline";
import type { NameOf } from "../tree/timeline";

/** One fact line under an entry: `⚭ 4 FEB 1866, Škofja Loka — Marija Oblak`. */
export interface FactLine {
  /** The event tag the line came from (BIRT, BAPM, MARR, DEAT, BURI, …). */
  tag: string;
  /** Classic genealogy symbol (* ~ ⚭ † ▭ — see {@link EVENT_GLYPHS}). */
  glyph: string;
  /** Original date text, exactly as recorded. */
  date?: string;
  place?: string;
  /** Marriage lines carry the partner's display name. */
  spouse?: string;
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
  /** Register report: the parent's display name, for the group heading. */
  parentName?: string;
  facts: FactLine[];
}

export interface ReportGeneration {
  /** 0 = the root person, then one step per generation away from them. */
  gen: number;
  entries: ReportEntry[];
}

export interface ReportData {
  generations: ReportGeneration[];
  /** Total entries across all generations (duplicates included). */
  total: number;
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

export function makeEntry(
  indi: Individual,
  num: number,
  nameOf: NameOf,
  facts: FactLine[],
  nowYear: number,
  dupOf: number | undefined,
): ReportEntry {
  return {
    num,
    id: indi.id,
    sex: indi.sex,
    name: nameOf(indi),
    years: formatLifespan(birthYear(indi), deathYear(indi), isDeceased(indi)),
    living: isPresumedLiving(indi, nowYear),
    dupOf,
    facts: dupOf === undefined ? facts : [],
  };
}

/** A fact line for the first of the given events that has a date or a place. */
export function factFor(indi: Individual, tags: string[]): FactLine | undefined {
  for (const tag of tags) {
    const e = indi.events.find((ev) => ev.tag === tag);
    if (e && dated(e)) {
      return { tag, glyph: EVENT_GLYPHS[tag], date: e.date?.raw, place: factPlace(e) };
    }
  }
  return undefined;
}

/** The union's ⚭ line, when its MARR event carries a date or a place. */
export function marriageFact(fam: Family, spouse: string | undefined): FactLine | undefined {
  const marr = fam.events.find((e) => e.tag === "MARR");
  if (!marr || !dated(marr)) return undefined;
  return { tag: "MARR", glyph: MARRIAGE_SYMBOL, date: marr.date?.raw, place: factPlace(marr), spouse };
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

export function dated(e: GedEvent): boolean {
  return !!e.date?.raw || !!factPlace(e);
}

/** Resolve family ids to their records, keeping order, dropping dangling refs. */
export function familiesOf(ds: Dataset, ids: string[]): Family[] {
  return ids.map((id) => ds.families.get(id)).filter((f): f is Family => f !== undefined);
}
