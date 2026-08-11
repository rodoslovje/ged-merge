// Data model for the Timeline chart: the root person and their immediate
// family (parents, siblings, spouses, children) as horizontal lifespan bars on
// a shared year axis, with dated life events and marriages as markers. Pure
// dataset → rows logic, so the geometry-free part is unit-testable; the
// component (ui/TimelineChart.tsx) turns years into pixels.

import type { Dataset, Family, GedEvent, Individual, Sex } from "../gedcom/types";
import {
  birthSortKey,
  birthYear,
  deathYear,
  formatLifespan,
  isDeceased,
  isPresumedLiving,
} from "../gedcom/lifespan";
import { familiesByMarriage } from "../gedcom/familySort";
import { localityParts } from "../gedcom/place";
import type { Translate } from "../locales/i18n";
import { MARRIAGE_SYMBOL, placeLabel } from "./nodeDisplay";

/** The person's relation to the timeline's root, in row-group order. A parent's
 *  other partner is a step-parent and that union's children are half-siblings;
 *  a spouse's children from their other unions are step-children. Past the
 *  immediate family — grandparents and beyond, grandchildren and beyond — the
 *  blood line alone continues, under the two open-ended roles: how far up or
 *  down each one stands is the kinship label's job, not a role's. */
export type TimelineRole =
  | "ancestor"
  | "parent"
  | "stepparent"
  | "sibling"
  | "halfsibling"
  | "person"
  | "spouse"
  | "child"
  | "stepchild"
  | "descendant";

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
  /** Compact under-bar label for an event mark ("Farmer 1930", "Ljubljana 1945"),
   *  shown when the timeline's event-labels toggle is on. */
  short?: string;
  /** Type glyph drawn on the bar instead of the generic dot, when the event's
   *  tag has a conventional genealogy symbol (see {@link EVENT_GLYPHS}). */
  glyph?: string;
}

/** Classic genealogy symbols for the common event types — language-neutral, so
 *  they need no translation: * born, ~ baptized, † died, ▭ buried, ⌂ residence,
 *  →/← emigrated/immigrated. No conventional symbol exists for occupation or
 *  education; ⚒ and ✎ are the closest widely-understood monochrome marks
 *  (Unicode's 🎓 only renders as colour emoji, 🕮 lacks font support). The one map is
 *  shared by the Timeline and the reports, so every surface draws an event
 *  type the same way. Unmapped events keep the generic dot. */
export const EVENT_GLYPHS: Record<string, string> = {
  BIRT: "*",
  BAPM: "~",
  CHR: "~",
  DEAT: "†",
  BURI: "▭",
  CREM: "▭",
  RESI: "⌂",
  OCCU: "⚒",
  EDUC: "✎",
  EMIG: "→",
  IMMI: "←",
};

/** One residence period, for the optional strip under the lifespan bar. An
 *  explicit range date sets the end; otherwise the period runs to the next
 *  residence, else to the end of the person's bar. */
export interface TimelineResidence {
  from: number;
  to: number;
  place?: string;
  /** Tooltip: localized "Residence" + original date text (+ locality). */
  label: string;
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
  /** Declared private — redacted like the living, without affecting the bar. */
  private?: boolean;
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
  /** Dated residence periods, in year order (see {@link TimelineResidence}). */
  residences: TimelineResidence[];
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
 * Build the timeline rows for a root person: the ancestors above, oldest
 * generation first, then parents, then the root among their siblings in birth
 * order, then each union's spouse followed by that union's children, and the
 * descendants below. People appearing in two roles (pedigree collapse) keep the
 * first.
 *
 * `maxGen` is how many generations either way the chart reaches — 1 (the
 * default) is the immediate family, `null` the whole line in both directions.
 * Beyond the first step the blood line alone continues: a great-grandparent's
 * own siblings and a grandchild's other parent are somebody else's timeline.
 */
export function buildTimeline(
  t: Translate,
  ds: Dataset,
  rootId: string,
  nameOf: NameOf,
  nowYear: number = new Date().getFullYear(),
  maxGen: number | null = 1,
): TimelineData | undefined {
  const root = ds.individuals.get(rootId);
  if (!root) return undefined;
  const reach = maxGen ?? Infinity;

  const rows: TimelineRow[] = [];
  const seen = new Set<string>();
  // Every row carries its own dated events (the UI decides whose to show);
  // callers add the marriage marks that belong to the person's role.
  const add = (indi: Individual | undefined, role: TimelineRole, marriage: TimelineMark[] = []) => {
    if (!indi || seen.has(indi.id)) return;
    seen.add(indi.id);
    rows.push(makeRow(t, indi, role, nameOf, [...eventMarks(t, indi), ...marriage], nowYear, ds));
  };

  // Parents (father then mother), each carrying every marriage of theirs —
  // a remarriage shows on the parent's bar next to the step-parent's row.
  const childFamilies = root.childOf
    .map((id) => ds.families.get(id))
    .filter((f): f is Family => f !== undefined);
  const parents: Individual[] = [];
  for (const roleKey of ["husband", "wife"] as const) {
    for (const fam of childFamilies) {
      const p = fam[roleKey] ? ds.individuals.get(fam[roleKey]!) : undefined;
      if (p) {
        parents.push(p);
        break;
      }
    }
  }

  // Grandparents and above, oldest generation first so the chart reads down the
  // page the way the years run. Emitted before the parents for the same reason.
  const above = generationsOf(ds, parents, reach - 1, parentsStep(ds));
  for (const generation of above.reverse()) {
    for (const a of generation) add(a, "ancestor", marriageMarks(t, familiesByMarriage(ds, a.spouseOf)));
  }
  for (const p of parents) add(p, "parent", marriageMarks(t, familiesByMarriage(ds, p.spouseOf)));

  // A parent's other unions: the partner there is the root's step-parent and
  // that union's children are half-siblings. Both are sorted into the
  // generation below rather than listed here, where a second wife standing
  // above the first wife's children reads as their mother.
  const halfSiblings: Individual[] = [];
  const stepParents: GenerationEntry[] = [];
  for (const parent of parents) {
    for (const fam of familiesByMarriage(ds, parent.spouseOf)) {
      if (root.childOf.includes(fam.id)) continue; // the root's own family
      const partnerId = fam.husband === parent.id ? fam.wife : fam.husband;
      const partner = partnerId ? ds.individuals.get(partnerId) : undefined;
      const kids = fam.children
        .map((cid) => ds.individuals.get(cid))
        .filter((c): c is Individual => c !== undefined);
      halfSiblings.push(...kids);
      if (partner) {
        stepParents.push({
          indi: partner,
          role: "stepparent",
          // Where the union starts: its wedding, else its first child. A union
          // dated by neither says nothing about when it began, so the partner
          // falls back to their own birth and lands beside the parents, as
          // before.
          sortKey: unionStart(fam, kids) ?? birthSortKey(partner),
          marriage: marriageMarks(t, [fam]),
        });
      }
    }
  }

  // The root's generation: siblings, half-siblings and the root interleaved by
  // birth order, with each step-parent at the point their union begins — so the
  // children before that row belong to the marriage above it. The root's row
  // additionally carries their marriage(s).
  const unions = familiesByMarriage(ds, root.spouseOf);
  const generation: GenerationEntry[] = stepParents
    .concat(
      childFamilies
        .flatMap((f) => f.children)
        .filter((id, i, all) => all.indexOf(id) === i && id !== root.id)
        .map((id) => ds.individuals.get(id))
        .filter((s): s is Individual => s !== undefined)
        .map((s) => ({ indi: s, role: "sibling" as TimelineRole, sortKey: birthSortKey(s) })),
    )
    .concat(halfSiblings.map((s) => ({ indi: s, role: "halfsibling" as TimelineRole, sortKey: birthSortKey(s) })))
    .concat([{ indi: root, role: "person" as TimelineRole, sortKey: birthSortKey(root), marriage: marriageMarks(t, unions) }])
    // Stable, and the step-parents lead the array, so a wedding and a birth
    // sharing a key put the wedding first.
    .sort((a, b) => a.sortKey - b.sortKey);
  for (const g of generation) {
    add(g.indi, g.role, g.marriage ?? []);
  }

  // Each union: the spouse (with that union's marriage marker), then that
  // union's children plus the spouse's children from their other unions
  // (the root's step-children), interleaved by birth order.
  for (const fam of unions) {
    const spouseId = fam.husband === root.id ? fam.wife : fam.husband;
    const spouse = spouseId ? ds.individuals.get(spouseId) : undefined;
    add(spouse, "spouse", marriageMarks(t, [fam]));
    const kids = fam.children
      .map((id) => ds.individuals.get(id))
      .filter((c): c is Individual => c !== undefined)
      .map((c) => ({ indi: c, role: "child" as TimelineRole }));
    const stepKids = familiesByMarriage(ds, spouse?.spouseOf ?? [])
      // Not the root's own unions — remarrying the same partner is still "child".
      .filter((f) => f.husband !== root.id && f.wife !== root.id)
      .flatMap((f) => f.children)
      .map((id) => ds.individuals.get(id))
      .filter((c): c is Individual => c !== undefined)
      .map((c) => ({ indi: c, role: "stepchild" as TimelineRole }));
    for (const kid of [...kids, ...stepKids].sort((a, b) => birthSortKey(a.indi) - birthSortKey(b.indi))) {
      add(kid.indi, kid.role);
    }
  }

  // Grandchildren and below, youngest generation last — the mirror of the
  // ancestors above, and the same blood-line-only rule: a grandchild's other
  // parent belongs to their own timeline.
  const ownChildren = unions
    .flatMap((f) => f.children)
    .map((id) => ds.individuals.get(id))
    .filter((c): c is Individual => c !== undefined);
  for (const generation of generationsOf(ds, ownChildren, reach - 1, childrenStep(ds))) {
    for (const d of generation) add(d, "descendant", marriageMarks(t, familiesByMarriage(ds, d.spouseOf)));
  }

  let min: number | undefined;
  let max: number | undefined;
  for (const r of rows) {
    for (const y of [r.from, r.to, ...r.marks.map((m) => m.year), ...r.residences.flatMap((p) => [p.from, p.to])]) {
      if (y === undefined) continue;
      min = min === undefined ? y : Math.min(min, y);
      max = max === undefined ? y : Math.max(max, y);
    }
  }
  return { rows, minYear: min, maxYear: max };
}

function makeRow(
  t: Translate,
  indi: Individual,
  role: TimelineRole,
  nameOf: NameOf,
  marks: TimelineMark[],
  nowYear: number,
  ds: Dataset,
): TimelineRow {
  const birth = birthYear(indi);
  const death = deathYear(indi);
  const deceased = isDeceased(indi);
  const living = isPresumedLiving(indi, ds, nowYear);

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
    private: !!indi.private,
    place: placeLabel(indi),
    from,
    to,
    openStart: from !== undefined && birth === undefined,
    openEnd: to !== undefined && death === undefined,
    marks: [...marks].sort((a, b) => a.year - b.year),
    residences: residencePeriods(t, indi, to),
  };
}

/**
 * The person's dated residence periods, in year order. An explicit range date
 * (`FROM 1950 TO 1960`, `BET 1950 AND 1960`) sets a period's end; otherwise it
 * runs to the next residence's start, else to the end of the person's bar.
 */
function residencePeriods(t: Translate, indi: Individual, barEnd: number | undefined): TimelineResidence[] {
  const resis = indi.events
    .filter((e) => e.tag === "RESI" && e.date?.year !== undefined)
    .sort((a, b) => a.date!.year! - b.date!.year!);
  return resis.map((e, i) => {
    const from = e.date!.year!;
    const to = e.date!.year2 ?? resis[i + 1]?.date?.year ?? barEnd ?? from;
    const place = eventPlace(e);
    return {
      from,
      to: Math.max(from, to),
      place,
      label: `${t("event.RESI")}: ${e.date!.raw}${place ? `, ${place}` : ""}`,
    };
  });
}

/** Dot markers for every dated event on the individual's own record. */
function eventMarks(t: Translate, indi: Individual): TimelineMark[] {
  const out: TimelineMark[] = [];
  for (const e of indi.events) {
    if (e.date?.year === undefined) continue;
    const label = t(`event.${e.tag}`, { defaultValue: e.type || e.tag });
    const place = eventPlace(e);
    out.push({
      year: e.date.year,
      kind: "event",
      label: `${label}: ${e.date.raw}${place ? `, ${place}` : ""}`,
      // The compact lane label leads with the most specific detail recorded:
      // the event's own value ("Farmer"), else its locality, else its name.
      short: `${e.value || place || label} ${e.date.year}`,
      glyph: EVENT_GLYPHS[e.tag],
    });
  }
  return out;
}


/** An event's display location: its street address when recorded (the leading
 *  part, house number kept — more specific than any locality), else the
 *  place's most-specific locality. */
export function eventPlace(e: GedEvent): string | undefined {
  if (e.address?.parts[0]) return e.address.parts[0];
  return e.place ? localityParts(e.place)[0] : undefined;
}

/** One person's parents / one person's children, as {@link generationsOf} steps. */
const parentsStep = (ds: Dataset) => (indi: Individual) =>
  indi.childOf.flatMap((id) => {
    const fam = ds.families.get(id);
    return [fam?.husband, fam?.wife].map((pid) => (pid ? ds.individuals.get(pid) : undefined));
  });
const childrenStep = (ds: Dataset) => (indi: Individual) =>
  familiesByMarriage(ds, indi.spouseOf).flatMap((f) => f.children.map((id) => ds.individuals.get(id)));

/**
 * How many generations the timeline has to offer from this person: the deeper
 * of their ancestor and descendant lines (0 for someone with neither). Feeds the
 * generation stepper's "of N".
 */
export function familyDepth(ds: Dataset, rootId: string): number {
  const root = ds.individuals.get(rootId);
  if (!root) return 0;
  return Math.max(
    generationsOf(ds, [root], Infinity, parentsStep(ds)).length,
    generationsOf(ds, [root], Infinity, childrenStep(ds)).length,
  );
}

/**
 * The next `levels` generations out from `from`, nearest first, each in birth
 * order — `step` names one person's people in that direction (their parents, or
 * their children). Nobody is listed twice across the generations, so a pedigree
 * collapse stands at the first level it reaches; an empty generation ends the
 * walk, since nothing lies beyond it.
 */
function generationsOf(
  ds: Dataset,
  from: Individual[],
  levels: number,
  step: (indi: Individual) => (Individual | undefined)[],
): Individual[][] {
  const out: Individual[][] = [];
  const seen = new Set(from.map((p) => p.id));
  let frontier = from;
  for (let level = 0; level < levels && frontier.length > 0; level++) {
    const next: Individual[] = [];
    for (const p of frontier) {
      for (const n of step(p)) {
        if (!n || seen.has(n.id)) continue;
        seen.add(n.id);
        next.push(n);
      }
    }
    if (next.length === 0) break;
    out.push(coupledOrder(ds, next.sort((a, b) => birthSortKey(a) - birthSortKey(b))));
    frontier = next;
  }
  return out;
}

/**
 * A generation in birth order, but with each married couple kept together: a
 * spouse who stands in the same generation follows their partner immediately,
 * so the pair holds the elder partner's place in the years.
 *
 * A whole generation of ancestors is really a row of couples, and sorting them
 * one by one by birth deals them out interleaved — husband, someone else's wife,
 * another husband — which reads as though nobody was married to anybody. Birth
 * still decides where a couple stands; being married only decides who they
 * stand next to.
 */
function coupledOrder(ds: Dataset, people: Individual[]): Individual[] {
  const here = new Map(people.map((p) => [p.id, p]));
  const placed = new Set<string>();
  const out: Individual[] = [];
  for (const p of people) {
    if (placed.has(p.id)) continue;
    placed.add(p.id);
    out.push(p);
    for (const fam of familiesByMarriage(ds, p.spouseOf)) {
      const otherId = fam.husband === p.id ? fam.wife : fam.husband;
      const other = otherId ? here.get(otherId) : undefined;
      if (!other || placed.has(other.id)) continue;
      placed.add(other.id);
      out.push(other);
    }
  }
  return out;
}

/** One row of the root's own generation, waiting to be sorted into it. */
interface GenerationEntry {
  indi: Individual;
  role: TimelineRole;
  /** Where the row belongs in the generation, on {@link birthSortKey}'s scale. */
  sortKey: number;
  /** Marriage markers the row carries (the root's unions, a step-parent's). */
  marriage?: TimelineMark[];
}

/**
 * When a union began, on {@link birthSortKey}'s scale: its wedding, else its
 * first child's birth. Undefined for a union dated by neither.
 *
 * Deliberately not {@link dateToSortKey}, whose year-only convention sorts a
 * bare year *after* every dated event in it — these keys are weighed against
 * birth keys, where a bare year comes first.
 */
function unionStart(fam: Family, children: Individual[]): number | undefined {
  const marr = fam.events.find((e) => e.tag === "MARR")?.date;
  if (marr?.year !== undefined) return marr.year * 10000 + (marr.month ?? 0) * 100 + (marr.day ?? 0);
  const first = Math.min(...children.map(birthSortKey));
  return Number.isFinite(first) ? first : undefined;
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
