import type { Dataset, Family, GedDate, Individual } from "../gedcom/types";
import { isBirthChildLink } from "../gedcom/couple";
import {
  BIRTH_TAGS, FATHER_AGE, MOTHER_AGE, birthDateText, birthFromStatedAges, birthYear, estimateBirthYear,
} from "../gedcom/lifespan";

/**
 * Birth and marriage estimates — one computation shared by the Batch actions
 * ("Estimate birth", "Estimate marriage") and the health check's row fixes, so
 * both tools always propose the same date for the same record.
 */

/** The first and last day a date can name, as `Y*10000 + M*100 + D`; an open
 *  side (BEF, TO / AFT, FROM) is ±Infinity. `sure` is false for an estimate
 *  (ABT, EST, CAL), read as the span it names. Undefined without a year. */
export function daySpan(d: GedDate): { from: number; to: number; sure: boolean } | undefined {
  if (d.year == null) return undefined;
  const lo = (y: number, m?: number, day?: number) => y * 10000 + (m ?? 1) * 100 + (day ?? 1);
  const hi = (y: number, m?: number, day?: number) => y * 10000 + (m ?? 12) * 100 + (day ?? 31);
  const own = { from: lo(d.year, d.month, d.day), to: hi(d.year, d.month, d.day) };
  switch (d.qualifier) {
    case "exact": case "interpreted": return { ...own, sure: true };
    case "about": return { ...own, sure: false };
    // BEF names the day before it starts; TO ends a period on its last day.
    case "before": return { from: -Infinity, to: own.from - 1, sure: true };
    case "to": return { from: -Infinity, to: own.to, sure: true };
    case "after": case "from": return { from: own.from, to: Infinity, sure: true };
    case "between": case "range":
      return d.year2 == null ? undefined : { from: own.from, to: hi(d.year2, d.month2, d.day2), sure: true };
    default: return undefined;
  }
}

/** The birth/baptism date that bounds a person's birth most tightly from
 *  above — a stated one first, else an estimate — with that bound's last day. */
export function birthBound(indi: Individual): { date: GedDate; to: number; sure: boolean } | undefined {
  let best: { date: GedDate; to: number; sure: boolean } | undefined;
  for (const ev of indi.events) {
    if (!(BIRTH_TAGS as readonly string[]).includes(ev.tag) || !ev.date) continue;
    const span = daySpan(ev.date);
    if (!span || span.to === Infinity) continue;
    const better = !best || (span.sure && !best.sure) || (span.sure === best.sure && span.to < best.to);
    if (better) best = { date: ev.date, to: span.to, sure: span.sure };
  }
  return best;
}

const GEDCOM_MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** The marriage date a family's eldest child's birth proves: `BEF` that
 *  birth, written in standard GEDCOM. Undefined when the birth names no last
 *  day to put it before (a period, an AFT, another calendar). */
export function marriageBefore(birth: GedDate): string | undefined {
  if (birth.calendar && birth.calendar !== "GREGORIAN") return undefined;
  if (!["exact", "interpreted", "before"].includes(birth.qualifier) || birth.year == null) return undefined;
  const parts = [birth.day, birth.month ? GEDCOM_MONTHS[birth.month - 1] : undefined, birth.year].filter((p) => p != null);
  return `BEF ${parts.join(" ")}`;
}

/** Rounding grain for birth estimates — a guess on a multiple of 5
 *  (ABT 1880, not ABT 1878) reads as the approximation it is. */
const ESTIMATE_ROUND = 5;
/** Years per child-order position when anchoring on a dated sibling. */
const SIBLING_STEP = 1;

const roundEstimate = (y: number) => Math.round(y / ESTIMATE_ROUND) * ESTIMATE_ROUND;

/**
 * The years the estimate action would write, keyed by person id — people it
 * would skip (already dated, or nothing to estimate from) get no entry. Pure
 * dry-run of {@link estimateBirthBatch}'s computation, shared with the panel's
 * per-row preview.
 */
export function previewBirthEstimates(ds: Dataset, ids: string[]): Map<string, number> {
  // Every ABT guess is rounded to the nearest 5 years: a generation offset
  // would land on oddly specific years (ABT 1878) that read like
  // computed-from-a-record precision; ABT 1880 looks like the rough guess it is.
  const estimates = new Map<string, number>();
  /** Parent-derived estimates, grouped by the family the person is a child of —
   *  these all share one number, so they take the sibling pass below. */
  const parentDerived = new Map<string, string[]>();
  for (const id of ids) {
    const indi = ds.individuals.get(id);
    if (!indi) continue;
    // Any recorded birth/baptism date — even one without a parseable year —
    // is the researcher's data; never overwrite it with an estimate.
    if (birthYear(indi) !== undefined || birthDateText(indi) !== undefined) continue;
    // An age the person's records state is evidence, not a generation's
    // guess: it wins, unrounded, and stays out of the sibling spreading.
    const stated = birthFromStatedAges(indi, ds);
    if (stated) {
      estimates.set(id, stated.year);
      continue;
    }
    const est = estimateBirthYear(indi, ds);
    if (est) estimates.set(id, roundEstimate(est.estimatedYear));
    if (est && est.relation !== "father" && est.relation !== "mother") continue;
    // Parent-derived (or absent) estimate: queue for the sibling pass, keyed
    // by the driving parent's family — or, with no estimate at all, by a
    // family holding a dated sibling, the one relative estimateBirthYear
    // itself never looks at.
    const famId = est
      ? (indi.childOf.find((fid) => {
          const fam = ds.families.get(fid);
          return fam?.husband === est.relativeId || fam?.wife === est.relativeId;
        }) ?? indi.childOf[0])
      : indi.childOf.find((fid) =>
          (ds.families.get(fid)?.children ?? []).some((cid) => birthYear(ds.individuals.get(cid)) !== undefined),
        );
    if (famId) parentDerived.set(famId, [...(parentDerived.get(famId) ?? []), id]);
  }
  // Sibling pass: a dated sibling is closer evidence than a parent's
  // generation. Children are taken in the order the family lists them
  // (usually birth order), and each estimate re-anchors on the nearest dated
  // one, SIBLING_STEP per list position away — then rounded like every other
  // guess, so close siblings may share an ABT year. With no dated sibling the
  // shared parent guess stands. Estimates driven by the person's own
  // spouse/children keep their number.
  for (const [famId, group] of parentDerived) {
    const order = ds.families.get(famId)?.children ?? [];
    const anchors = order
      .map((cid, i) => ({ i, y: birthYear(ds.individuals.get(cid)) }))
      .filter((a): a is { i: number; y: number } => a.y !== undefined);
    if (anchors.length === 0) continue;
    for (const cid of order.filter((c) => group.includes(c))) {
      const i = order.indexOf(cid);
      let best = anchors[0];
      for (const a of anchors) if (Math.abs(a.i - i) < Math.abs(best.i - i)) best = a;
      estimates.set(cid, roundEstimate(best.y + SIBLING_STEP * (i - best.i)));
    }
  }
  return estimates;
}

/**
 * The `DATE` values the estimate action would write, keyed by person id — the
 * years of {@link previewBirthEstimates}, each with its keyword: `CAL` where
 * the year was calculated from an age the records state (GEDCOM's word for
 * exactly that), `ABT` where it is a guess from relatives.
 */
export function previewBirthEstimateDates(ds: Dataset, ids: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, year] of previewBirthEstimates(ds, ids)) {
    const indi = ds.individuals.get(id);
    out.set(id, `${indi && birthFromStatedAges(indi, ds) ? "CAL" : "ABT"} ${year}`);
  }
  return out;
}

/** Years before an estimated first birth that an `ABT` marriage is placed. */
const MARRIAGE_BEFORE_CHILD = 2;

/**
 * The marriage date family `fam` supports, or undefined when its own date is
 * the better one. Only a recorded `MARR` is dated: a couple with no marriage
 * may never have married, so the estimate must not assert that they did. An
 * undated one is dated only for a couple — a family naming one parent is no
 * couple, most often a child born out of wedlock.
 *  - **Undated marriage:** `BEF` the birth of the eldest child with a stated
 *    birth (a couple marries before their first child is born), else `ABT`
 *    {@link MARRIAGE_BEFORE_CHILD} years before the eldest estimated birth,
 *    else `ABT` the wife's birth plus a mother's age at a first child, else
 *    the husband's plus a father's. `ABT` years are rounded like birth
 *    estimates.
 *  - **A bound later than that birth** (`BEF 1900` for a child of 1885) or
 *    **an estimate the birth precedes** (`ABT 1775` for a child of 1773):
 *    `BEF` the birth — written before an older child was added.
 * Any other date, an estimate the children agree with included, is the
 * researcher's and stays. Only birth links count: an adopted child proves
 * nothing about the marriage. The `BEF` keeps the birth's full date, since
 * that is exactly what it proves (`BEF 1885` would rule out January 1885).
 */
export function marriageEstimate(ds: Dataset, fam: Family): string | undefined {
  const marr = fam.events.find((e) => e.tag === "MARR");
  if (!marr) return undefined;
  let eldest: { to: number; value: string } | undefined;
  let estimated: number | undefined;
  for (const cid of fam.children) {
    const child = ds.individuals.get(cid);
    if (!child || !isBirthChildLink(child, fam.id)) continue;
    const born = birthBound(child);
    if (!born) continue;
    const value = born.sure ? marriageBefore(born.date) : undefined;
    if (value) {
      if (!eldest || born.to < eldest.to) eldest = { to: born.to, value };
    } else if (!born.sure && born.date.year != null) {
      estimated = Math.min(estimated ?? born.date.year, born.date.year);
    }
  }
  const date = marr.date;
  if (!date?.raw.trim()) {
    if (!fam.husband || !fam.wife) return undefined;
    if (eldest) return eldest.value;
    const wife = birthYear(ds.individuals.get(fam.wife));
    const husband = birthYear(ds.individuals.get(fam.husband));
    const guess =
      estimated !== undefined ? estimated - MARRIAGE_BEFORE_CHILD
      : wife !== undefined ? wife + MOTHER_AGE
      : husband !== undefined ? husband + FATHER_AGE
      : undefined;
    return guess === undefined ? undefined : `ABT ${roundEstimate(guess)}`;
  }
  const span = daySpan(date);
  if (!span || !eldest) return undefined;
  // Only an estimate (ABT) or an upper bound (BEF, TO) gives way to the birth.
  if (span.sure && span.from !== -Infinity) return undefined;
  return eldest.to < (span.sure ? span.to : span.from) ? eldest.value : undefined;
}

/**
 * The marriage dates the estimate would write for the unions of `ids`, keyed
 * by family id (see {@link marriageEstimate}); a family is listed once even
 * when both partners are among `ids`.
 */
export function previewMarriageEstimates(ds: Dataset, ids: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const id of ids) {
    for (const famId of ds.individuals.get(id)?.spouseOf ?? []) {
      if (out.has(famId)) continue;
      const fam = ds.families.get(famId);
      const value = fam && marriageEstimate(ds, fam);
      if (value) out.set(famId, value);
    }
  }
  return out;
}
