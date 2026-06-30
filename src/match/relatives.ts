import type { Dataset, GedEvent, Individual, PersonName } from "../gedcom/types";
import type { Translate } from "../locales/i18n";
import { datesTooltipOf, lifespanOf } from "../gedcom/lifespan";

/** Conventional xrefs of "person 1" — the root individual many apps assign to
 * the start/primary person (MacFamilyTree writes `@1@`, others `@I1@`). Used as
 * the default start person when no explicit pointer is present, in priority order. */
const DEFAULT_START_XREFS = ["@1@", "@I1@"];

/**
 * The default start person to pre-select, by descending strength of signal:
 *  1. an explicit `1 _ROOT @xref@` pointer in the HEAD (e.g. RootsMagic);
 *  2. an individual flagged with `_STP` ("start person", e.g. MacFamilyTree);
 *  3. the conventional root individual (`@1@` / `@I1@`).
 * Returns undefined when the file gives no usable signal.
 */
export function defaultStartId(ds: Dataset): string | undefined {
  const head = ds.records.find((r) => r.tag === "HEAD");
  const root = head?.children.find((c) => c.tag === "_ROOT")?.value;
  if (root && ds.individuals.has(root)) return root;

  for (const indi of ds.individuals.values()) {
    if (indi.raw.children.some((c) => c.tag === "_STP")) return indi.id;
  }

  return DEFAULT_START_XREFS.find((id) => ds.individuals.has(id));
}

/** The individual's primary name (first NAME record), if any. */
export function primaryName(indi: Individual): PersonName | undefined {
  return indi.names[0];
}

/** Full display name from a structured name. */
export function displayName(n: PersonName | undefined): string {
  return n?.full || [n?.given, n?.surname].filter(Boolean).join(" ") || "(unnamed)";
}

/**
 * Every name form a person carries — the primary name, its inline married
 * surname and nickname, and every additional `NAME` record (married/maiden/aka/…)
 * — lower-cased into one string for substring search.
 */
export function nameSearchText(indi: Individual): string {
  const parts: (string | undefined)[] = [];
  for (const n of indi.names) parts.push(n.full, n.given, n.surname, n.married, n.nickname);
  return parts.filter(Boolean).join(" ").toLowerCase();
}

/**
 * The married surname to show for a person, from either source the app supports:
 *  - an inline `_MARNM` on the primary name (Gramps/PAF/Brother's Keeper style), or
 *  - a separate `1 NAME … 2 TYPE married` record (the GEDCOM-7 / standard style).
 * Returns undefined when none is recorded.
 */
export function marriedSurnameOf(indi: Individual): string | undefined {
  const inline = indi.names[0]?.married?.trim();
  if (inline) return inline;
  for (const n of indi.names.slice(1)) {
    if (n.type?.toLowerCase() === "married") {
      const surname = (n.surname ?? n.full)?.trim();
      if (surname) return surname;
    }
  }
  return undefined;
}

/** Known `NAME`/`2 TYPE` values with a translated label; anything else is shown as-is. */
const KNOWN_NAME_TYPES = new Set([
  "aka", "birth", "married", "maiden", "nick", "formal", "family", "variation", "religious", "immigrant", "other",
]);

/** `2 TYPE` values offered when editing an additional `NAME` record
 * (nicknames use the primary name's `NICK` sub-tag instead). */
export const ADDITIONAL_NAME_TYPES = [
  "aka", "married", "maiden", "birth", "formal", "family", "variation", "religious", "immigrant", "other",
];

/** Human-readable label for a `2 TYPE` value on a NAME record (e.g. "married", "aka"). */
export function nameTypeLabel(type: string, t: Translate): string {
  const key = type.toLowerCase();
  return KNOWN_NAME_TYPES.has(key) ? t(`nametype.${key}`) : type;
}

/**
 * Additional names beyond the primary one: the primary name's nickname (if
 * any), plus any further `NAME` records — each with its `type` carried over
 * for {@link nameTypeLabel}.
 */
export function additionalNames(indi: Individual): PersonName[] {
  const extra: PersonName[] = [];
  const primary = indi.names[0];
  if (primary?.nickname) extra.push({ full: primary.nickname, type: "nick" });
  extra.push(...indi.names.slice(1));
  return extra;
}

/** Display label "Name 1817–1921" using the shared lifespan format. */
export function lifespanLabel(indi: Individual): string {
  const name = displayName(primaryName(indi));
  const span = lifespanOf(indi);
  return span ? `${name} ${span}` : name;
}

/** Tooltip label "Name (26 Jan 1817 – 3 Mar 1921)" with the full dates. */
export function fullDatesLabel(indi: Individual): string {
  const name = displayName(primaryName(indi));
  const dates = datesTooltipOf(indi);
  return dates ? `${name} (${dates})` : name;
}

/** Birth date for display: the original date text, falling back to the year. */
function birthText(indi: Individual): string | undefined {
  const d = findEvent(indi, "BIRT")?.date;
  return d?.raw || (d?.year != null ? String(d.year) : undefined);
}

/** A short display label for an individual: name plus birth date when known. */
export function label(indi: Individual): string {
  const name = displayName(primaryName(indi));
  const birth = birthText(indi);
  return birth ? `${name} (b. ${birth})` : name;
}

/** Case/space-insensitive comparison of two display fields. */
const fold = (s: string | undefined): string => (s ?? "").trim().toLowerCase();

/**
 * The compare name parts that differ from the master, for an inline title.
 * When both sides carry structured parts we diff given and surname separately;
 * otherwise we fall back to the whole reconstructed name.
 */
function nameDiff(m: PersonName | undefined, c: PersonName | undefined): string[] {
  const diff: string[] = [];
  if ((m?.given || m?.surname) && (c?.given || c?.surname)) {
    if (fold(c?.given) !== fold(m?.given)) diff.push(c?.given ?? "—");
    if (fold(c?.surname) !== fold(m?.surname)) diff.push(c?.surname ?? "—");
  } else if (fold(c?.full) !== fold(m?.full)) {
    diff.push(displayName(c));
  }
  return diff;
}

/**
 * Master-centric title for a candidate pair: the full master label, plus —
 * when the compare record differs — ": " and only the differing parts (given
 * name, surname, birth date) taken from the compare side. A pair that agrees on
 * all three shows the master label alone, never repeating identical data.
 */
export function pairTitle(master: Individual, compare: Individual): string {
  const diff = nameDiff(primaryName(master), primaryName(compare));
  const mb = birthText(master);
  const cb = birthText(compare);
  if (fold(cb) !== fold(mb)) diff.push(`(b. ${cb ?? "—"})`);
  const head = label(master);
  return diff.length ? `${head}: ${diff.join(" ")}` : head;
}

/** A spouse's title within a family pair: name only, collapsed like {@link pairTitle}. */
export function spouseTitle(m: PersonName | undefined, c: PersonName | undefined): string {
  const head = m ? displayName(m) : "?";
  const diff = nameDiff(m, c);
  return diff.length ? `${head}: ${diff.join(" ")}` : head;
}

export function findEvent(indi: Individual, tag: string): GedEvent | undefined {
  return indi.events.find((e) => e.tag === tag);
}

/** Parents resolved via the families where this person is a child. */
export function parentNames(indi: Individual, ds: Dataset): PersonName[] {
  const names: PersonName[] = [];
  for (const famId of indi.childOf) {
    const fam = ds.families.get(famId);
    if (!fam) continue;
    pushName(names, fam.husband, ds);
    pushName(names, fam.wife, ds);
  }
  return names;
}

/** The father's name (husband of the first family this person is a child of). */
export function fatherName(indi: Individual, ds: Dataset): PersonName | undefined {
  return parentByRole(indi, ds, "husband");
}

/** The mother's name (wife of the first family this person is a child of). */
export function motherName(indi: Individual, ds: Dataset): PersonName | undefined {
  return parentByRole(indi, ds, "wife");
}

function parentByRole(
  indi: Individual,
  ds: Dataset,
  role: "husband" | "wife",
): PersonName | undefined {
  for (const famId of indi.childOf) {
    const id = ds.families.get(famId)?.[role];
    const n = id ? ds.individuals.get(id)?.names[0] : undefined;
    if (n) return n;
  }
  return undefined;
}

/** Spouses resolved via the families where this person is a parent. */
export function partnerNames(indi: Individual, ds: Dataset): PersonName[] {
  const names: PersonName[] = [];
  for (const famId of indi.spouseOf) {
    const fam = ds.families.get(famId);
    if (!fam) continue;
    const otherId = fam.husband === indi.id ? fam.wife : fam.husband;
    pushName(names, otherId, ds);
  }
  return names;
}

/** Children resolved via the families where this person is a parent. */
export function childrenNames(indi: Individual, ds: Dataset): PersonName[] {
  const names: PersonName[] = [];
  for (const famId of indi.spouseOf) {
    const fam = ds.families.get(famId);
    if (!fam) continue;
    for (const childId of fam.children) {
      pushName(names, childId, ds);
    }
  }
  return names;
}

function pushName(into: PersonName[], id: string | undefined, ds: Dataset): void {
  if (!id) return;
  const n = ds.individuals.get(id)?.names[0];
  if (n) into.push(n);
}
