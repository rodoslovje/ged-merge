// Data model for the Timeline chart: the root person and their immediate
// family (parents, siblings, spouses, children) as horizontal lifespan bars on
// a shared year axis, with dated life events and marriages as markers. Pure
// dataset → rows logic, so the geometry-free part is unit-testable; the
// component (ui/TimelineChart.tsx) turns years into pixels.

import type { Dataset, Family, Individual, Sex } from "../gedcom/types";
import {
  birthSortKey,
  birthYear,
  deathYear,
  formatLifespan,
  isDeceased,
  isPresumedLiving,
} from "../gedcom/lifespan";
import { localityParts } from "../gedcom/place";
import type { Translate } from "../locales/i18n";
import { MARRIAGE_SYMBOL, placeLabel } from "./nodeDisplay";

/** The person's relation to the timeline's root, in row-group order. */
export type TimelineRole = "parent" | "sibling" | "person" | "spouse" | "child";

/** A dated marker drawn on a row's bar. */
export interface TimelineMark {
  year: number;
  /** Marriage marks draw the ⚭ glyph; plain life events draw a dot. */
  kind: "event" | "marriage";
  /** Tooltip text: localized event label + original date text (+ locality). */
  label: string;
  /** Marriage display fields (year + locality), for the optional visible
   *  `⚭ 1925 Kranj` label the Marriage chart-settings toggles enable. */
  marriage?: { year?: string; place?: string };
}

/** One person's row: a lifespan bar (when datable) plus its markers. */
export interface TimelineRow {
  /** Stable render/selection key (the person's xref). */
  key: string;
  id: string;
  role: TimelineRole;
  name: string;
  /** Lifespan label ("1817–1921", "1817–", …) — may be "". */
  years: string;
  sex: Sex;
  living: boolean;
  /** First-available place (birth → residence → death) for the place toggle. */
  place?: string;
  /** Bar extent in years; absent when the person has no dated event at all. */
  from?: number;
  to?: number;
  /** `from` is not a recorded birth year — the bar starts at the first known event. */
  openStart: boolean;
  /** `to` is not a recorded death year — living (bar runs to today) or unknown. */
  openEnd: boolean;
  marks: TimelineMark[];
}

export interface TimelineData {
  rows: TimelineRow[];
  /** Axis domain over every bar and mark; absent when nothing is dated. */
  minYear?: number;
  maxYear?: number;
}

/** Name formatter injected by the UI (honours the Name-display settings). */
export type NameOf = (indi: Individual) => string;

/**
 * Build the timeline rows for a root person: parents, then the root among their
 * siblings in birth order, then each union's spouse followed by that union's
 * children. People appearing in two roles (pedigree collapse) keep the first.
 */
export function buildTimeline(
  t: Translate,
  ds: Dataset,
  rootId: string,
  nameOf: NameOf,
  nowYear: number = new Date().getFullYear(),
): TimelineData | undefined {
  const root = ds.individuals.get(rootId);
  if (!root) return undefined;

  const rows: TimelineRow[] = [];
  const seen = new Set<string>();
  const add = (indi: Individual | undefined, role: TimelineRole, marks: TimelineMark[] = []) => {
    if (!indi || seen.has(indi.id)) return;
    seen.add(indi.id);
    rows.push(makeRow(indi, role, nameOf, marks, nowYear));
  };

  // Parents (father then mother), each carrying their own marriage marker.
  const childFamilies = root.childOf
    .map((id) => ds.families.get(id))
    .filter((f): f is Family => f !== undefined);
  for (const roleKey of ["husband", "wife"] as const) {
    for (const fam of childFamilies) {
      const p = fam[roleKey] ? ds.individuals.get(fam[roleKey]!) : undefined;
      if (p) {
        add(p, "parent", marriageMarks(t, [fam]));
        break;
      }
    }
  }

  // The root's generation: siblings and the root interleaved by birth order.
  // The root's row carries their own dated events plus their marriage(s).
  const unions = root.spouseOf
    .map((id) => ds.families.get(id))
    .filter((f): f is Family => f !== undefined);
  const generation = childFamilies
    .flatMap((f) => f.children)
    .filter((id, i, all) => all.indexOf(id) === i && id !== root.id)
    .map((id) => ds.individuals.get(id))
    .filter((s): s is Individual => s !== undefined)
    .map((s) => ({ indi: s, role: "sibling" as TimelineRole }))
    .concat([{ indi: root, role: "person" as TimelineRole }])
    .sort((a, b) => birthSortKey(a.indi) - birthSortKey(b.indi));
  for (const g of generation) {
    add(g.indi, g.role, g.role === "person" ? [...eventMarks(t, root), ...marriageMarks(t, unions)] : []);
  }

  // Each union: the spouse (with that union's marriage marker), then its
  // children in birth order.
  for (const fam of unions) {
    const spouseId = fam.husband === root.id ? fam.wife : fam.husband;
    add(spouseId ? ds.individuals.get(spouseId) : undefined, "spouse", marriageMarks(t, [fam]));
    const kids = fam.children
      .map((id) => ds.individuals.get(id))
      .filter((c): c is Individual => c !== undefined)
      .sort((a, b) => birthSortKey(a) - birthSortKey(b));
    for (const kid of kids) add(kid, "child");
  }

  let min: number | undefined;
  let max: number | undefined;
  for (const r of rows) {
    for (const y of [r.from, r.to, ...r.marks.map((m) => m.year)]) {
      if (y === undefined) continue;
      min = min === undefined ? y : Math.min(min, y);
      max = max === undefined ? y : Math.max(max, y);
    }
  }
  return { rows, minYear: min, maxYear: max };
}

function makeRow(
  indi: Individual,
  role: TimelineRole,
  nameOf: NameOf,
  marks: TimelineMark[],
  nowYear: number,
): TimelineRow {
  const birth = birthYear(indi);
  const death = deathYear(indi);
  const deceased = isDeceased(indi);
  const living = isPresumedLiving(indi, nowYear);

  // Every dated year the record carries, for open bar ends.
  const eventYears = indi.events
    .map((e) => e.date?.year)
    .filter((y): y is number => y !== undefined)
    .concat(marks.map((m) => m.year));

  let from = birth ?? (eventYears.length ? Math.min(...eventYears) : undefined);
  let to = death;
  if (to === undefined && from !== undefined) {
    // No recorded death year: run to today when presumed living, else stop at
    // the last dated event (a bare-birth ancestor gets a zero-length point).
    to = living ? nowYear : Math.max(from, ...eventYears);
  }
  if (from !== undefined && to !== undefined && to < from) [from, to] = [to, from];

  return {
    key: indi.id,
    id: indi.id,
    role,
    name: nameOf(indi),
    years: formatLifespan(birth, death, deceased),
    sex: indi.sex,
    living,
    place: placeLabel(indi),
    from,
    to,
    openStart: from !== undefined && birth === undefined,
    openEnd: to !== undefined && death === undefined,
    marks: [...marks].sort((a, b) => a.year - b.year),
  };
}

/** Dot markers for every dated event on the individual's own record. */
function eventMarks(t: Translate, indi: Individual): TimelineMark[] {
  const out: TimelineMark[] = [];
  for (const e of indi.events) {
    if (e.date?.year === undefined) continue;
    const label = t(`event.${e.tag}`, { defaultValue: e.type || e.tag });
    const place = e.place ? localityParts(e.place)[0] : undefined;
    out.push({
      year: e.date.year,
      kind: "event",
      label: `${label}: ${e.date.raw}${place ? `, ${place}` : ""}`,
    });
  }
  return out;
}

/** ⚭ markers for each family's dated MARR event. */
function marriageMarks(t: Translate, fams: Family[]): TimelineMark[] {
  const out: TimelineMark[] = [];
  for (const fam of fams) {
    const marr = fam.events.find((e) => e.tag === "MARR");
    if (marr?.date?.year === undefined) continue;
    const place = marr.place ? localityParts(marr.place)[0] : undefined;
    out.push({
      year: marr.date.year,
      kind: "marriage",
      label: `${MARRIAGE_SYMBOL} ${t("event.MARR")}: ${marr.date.raw}${place ? `, ${place}` : ""}`,
      marriage: { year: String(marr.date.year), place },
    });
  }
  return out;
}
