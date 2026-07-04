// Data model for the Ahnentafel report: the root person's ancestors as the
// classic numbered list (root = 1, a person's father = 2n, mother = 2n + 1),
// grouped by generation. Pure dataset → entries logic, so it's unit-testable;
// the component (ui/AhnentafelReport.tsx) and the text serializer
// (report/text.ts) only render what's built here.

import type { Dataset, Family, GedEvent, Individual, Sex } from "../gedcom/types";
import {
  birthYear,
  deathYear,
  formatLifespan,
  isDeceased,
  isPresumedLiving,
} from "../gedcom/lifespan";
import type { Translate } from "../locales/i18n";
import { EVENT_GLYPHS, eventPlace, type NameOf } from "../tree/timeline";
import { MARRIAGE_SYMBOL } from "../tree/nodeDisplay";

/** One fact line under an entry: `⚭ 4 FEB 1866, Škofja Loka — Marija Oblak`. */
export interface FactLine {
  /** The event tag the line came from (BIRT, BAPM, MARR, DEAT, BURI, …). */
  tag: string;
  /** Classic genealogy symbol (* ~ ⚭ † ▭ — see {@link EVENT_GLYPHS}). */
  glyph: string;
  /** Original date text, exactly as recorded. */
  date?: string;
  place?: string;
  /** Marriage lines carry the other parent's display name. */
  spouse?: string;
}

/** One numbered ancestor. */
export interface AhnEntry {
  num: number;
  id: string;
  sex: Sex;
  name: string;
  /** Lifespan label ("1817–1921", "1817–", …) — may be "". */
  years: string;
  living: boolean;
  /** Pedigree collapse: this ancestor already appeared under this number, and
   *  their line continues there — this entry carries no facts of its own. */
  dupOf?: number;
  facts: FactLine[];
}

export interface AhnGeneration {
  /** 0 = the root person, 1 = parents, 2 = grandparents, … */
  gen: number;
  entries: AhnEntry[];
}

export interface AhnentafelData {
  generations: AhnGeneration[];
  /** Total entries across all generations (duplicates included). */
  total: number;
}

/**
 * Build the numbered ancestor list for a root person. Missing parents simply
 * leave number gaps; an ancestor reached twice (pedigree collapse) becomes a
 * `dupOf` reference to their first number and is not expanded again — which
 * also guards against cyclic parent links.
 */
export function buildAhnentafel(
  ds: Dataset,
  rootId: string,
  nameOf: NameOf,
  nowYear: number = new Date().getFullYear(),
): AhnentafelData | undefined {
  const root = ds.individuals.get(rootId);
  if (!root) return undefined;

  const firstNum = new Map<string, number>();
  const generations: AhnGeneration[] = [];
  let total = 0;
  let queue: { num: number; indi: Individual; marriage?: FactLine }[] = [{ num: 1, indi: root }];

  for (let gen = 0; queue.length > 0; gen++) {
    const entries: AhnEntry[] = [];
    const next: typeof queue = [];

    for (const { num, indi, marriage } of queue) {
      const dupOf = firstNum.get(indi.id);
      entries.push(makeEntry(indi, num, nameOf, marriage, nowYear, dupOf));
      total++;
      if (dupOf !== undefined) continue; // the line already continues there
      firstNum.set(indi.id, num);

      // Parents, each from the first child-family that records that role (the
      // same per-role scan the Timeline uses for multi-FAMC records).
      const families = indi.childOf
        .map((id) => ds.families.get(id))
        .filter((f): f is Family => f !== undefined);
      const famF = families.find((f) => f.husband && ds.individuals.has(f.husband));
      const famM = families.find((f) => f.wife && ds.individuals.has(f.wife));
      const father = famF ? ds.individuals.get(famF.husband!) : undefined;
      const mother = famM ? ds.individuals.get(famM.wife!) : undefined;

      // The parents' ⚭ line goes on the father's entry by convention (his
      // family's record), naming that family's wife; with no father it moves
      // to the mother's entry so the date/place isn't lost.
      if (father) {
        const wife = famF!.wife ? ds.individuals.get(famF!.wife) : undefined;
        next.push({ num: 2 * num, indi: father, marriage: marriageFact(famF!, wife && nameOf(wife)) });
      }
      if (mother) {
        next.push({
          num: 2 * num + 1,
          indi: mother,
          marriage: father ? undefined : marriageFact(famM!, undefined),
        });
      }
    }

    generations.push({ gen, entries });
    queue = next;
  }

  return { generations, total };
}

/** The localized heading for a generation (shared by the page and the .txt). */
export function generationLabel(t: Translate, gen: number): string {
  if (gen <= 3) return t(`ahnentafel.gen.${gen}`);
  return t("ahnentafel.gen.n", { n: gen });
}

function makeEntry(
  indi: Individual,
  num: number,
  nameOf: NameOf,
  marriage: FactLine | undefined,
  nowYear: number,
  dupOf: number | undefined,
): AhnEntry {
  const facts: FactLine[] =
    dupOf === undefined
      ? [
          factFor(indi, ["BIRT"]),
          factFor(indi, ["BAPM", "CHR"]),
          marriage,
          factFor(indi, ["DEAT"]),
          factFor(indi, ["BURI", "CREM"]),
        ].filter((f): f is FactLine => f !== undefined)
      : [];
  return {
    num,
    id: indi.id,
    sex: indi.sex,
    name: nameOf(indi),
    years: formatLifespan(birthYear(indi), deathYear(indi), isDeceased(indi)),
    living: isPresumedLiving(indi, nowYear),
    dupOf,
    facts,
  };
}

/** A fact line for the first of the given events that has a date or a place. */
function factFor(indi: Individual, tags: string[]): FactLine | undefined {
  for (const tag of tags) {
    const e = indi.events.find((ev) => ev.tag === tag);
    if (e && dated(e)) {
      return { tag, glyph: EVENT_GLYPHS[tag], date: e.date?.raw, place: eventPlace(e) };
    }
  }
  return undefined;
}

/** The union's ⚭ line, when its MARR event carries a date or a place. */
function marriageFact(fam: Family, spouse: string | undefined): FactLine | undefined {
  const marr = fam.events.find((e) => e.tag === "MARR");
  if (!marr || !dated(marr)) return undefined;
  return { tag: "MARR", glyph: MARRIAGE_SYMBOL, date: marr.date?.raw, place: eventPlace(marr), spouse };
}

function dated(e: GedEvent): boolean {
  return !!e.date?.raw || !!eventPlace(e);
}
