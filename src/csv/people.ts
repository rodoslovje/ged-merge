/**
 * The record registry a CSV import builds its synthetic compare file in.
 *
 * A CSV names the same person in several places — a match row of their own, a
 * partner in one row, a parent in another, the father of two brides who marry
 * years apart — and each mention has to land on *one* INDI carrying all their
 * families, not on a disconnected stand-in per mention. That is what this
 * registry is: the records made so far, indexed well enough to find them again.
 *
 * Shared by the genealogical-index matches import (`giMatches.ts`) and the
 * parish-register index import (`parishIndex.ts`); what differs between them —
 * how a person is recognised across rows, what a relative cell looks like — is
 * each import's own business.
 */
import type { GedNode, Sex } from "../gedcom/types";
import { sexFromGivenName } from "../gedcom/nameSex";

export interface People {
  records: GedNode[];
  /** INDI node by compare id, so pointers can be appended after creation. */
  indi: Map<string, GedNode>;
  /** Couple key → FAM record, so one marriage isn't recorded as two families. */
  famByCouple: Map<string, GedNode>;
  /** FAM id → record, for the families whose spouse slots are only a guess —
   *  see {@link coupleFam} and {@link settleGuessedRoles}. */
  guessedRoles: Map<string, GedNode>;
}

export function newPeople(): People {
  return {
    records: [],
    indi: new Map(),
    famByCouple: new Map(),
    guessedRoles: new Map(),
  };
}

export function node(level: number, tag: string, value: string): GedNode {
  return { level, tag, value, children: [] };
}

export function famNode(xref: string, children: GedNode[]): GedNode {
  return { level: 0, xref, tag: "FAM", children };
}

export function addPerson(people: People, id: string, children: GedNode[]): GedNode {
  const record: GedNode = { level: 0, xref: id, tag: "INDI", children };
  people.records.push(record);
  people.indi.set(id, record);
  return record;
}

export function addPointer(people: People, id: string, tag: "FAMS" | "FAMC", famId: string): void {
  const record = people.indi.get(id);
  if (!record) return;
  if (record.children.some((c) => c.tag === tag && c.value === famId)) return;
  record.children.push(node(1, tag, famId));
}

/** Record a person's sex, when the CSV puts them in a column or role that states
 *  it (a father, a wife, the husband of a family row). Never overwrites. */
export function addSex(people: People, id: string, sex: Sex | undefined): void {
  if (!sex) return;
  const record = people.indi.get(id);
  if (!record || record.children.some((c) => c.tag === "SEX")) return;
  record.children.push(node(1, "SEX", sex));
}

/** Add a child to a family, once. */
export function addChild(fam: GedNode, childId: string): void {
  if (fam.children.some((c) => c.tag === "CHIL" && c.value === childId)) return;
  fam.children.push(node(1, "CHIL", childId));
}

/**
 * The FAM for a couple: the one already recorded when both spouses are known and
 * the CSV has married them elsewhere (as partners in one row, as a child's
 * parents in another), otherwise a fresh record under `fallbackId` with the
 * spouses' FAMS pointers attached.
 *
 * `rolesKnown` says whether the caller can tell husband from wife. A partner
 * cell that names someone without saying which spouse they are is a guess (the
 * row's own person goes to HUSB), and a guess must not outlive the first mention
 * that does know — a father and mother, or a family row's own two columns — or
 * the couple ends up married the wrong way round.
 */
export function coupleFam(
  people: People,
  husbId: string | undefined,
  wifeId: string | undefined,
  fallbackId: string,
  rolesKnown: boolean,
): { id: string; node: GedNode; fresh: boolean } {
  // Order-independent, since the CSV doesn't always say which spouse is which:
  // the same couple must not become two families with the roles swapped.
  const coupleKey = husbId && wifeId ? [husbId, wifeId].sort().join("|") : undefined;
  const known = coupleKey ? people.famByCouple.get(coupleKey) : undefined;
  if (known) {
    const id = known.xref!;
    if (rolesKnown && people.guessedRoles.delete(id)) {
      for (const c of known.children) {
        if (c.tag === "HUSB") c.value = husbId;
        else if (c.tag === "WIFE") c.value = wifeId;
      }
    }
    return { id, node: known, fresh: false };
  }

  const children: GedNode[] = [];
  if (husbId) children.push(node(1, "HUSB", husbId));
  if (wifeId) children.push(node(1, "WIFE", wifeId));
  const record = famNode(fallbackId, children);
  people.records.push(record);
  if (coupleKey) people.famByCouple.set(coupleKey, record);
  if (!rolesKnown) people.guessedRoles.set(fallbackId, record);
  for (const id of [husbId, wifeId]) if (id) addPointer(people, id, "FAMS", fallbackId);
  return { id: fallbackId, node: record, fresh: true };
}

/**
 * Give a sex to everyone the CSV never stated one for, from their given name.
 * The index export has no sex column at all: only a father, a mother, a family
 * row's own two columns and an old-format "Mož:"/"Žena:" partner say it
 * outright, so without this most of an imported file — every child, and every
 * person of a row whose partner carries no role marker — arrives sexless.
 *
 * Runs before {@link settleGuessedRoles}, so a couple whose spouse slots were
 * only a guess can be put right by the names as well.
 */
export function inferSexFromNames(people: People): void {
  for (const [id, record] of people.indi) {
    // "Marija /Hvasti/" → "Marija". addSex leaves a stated sex alone.
    const given = (record.children.find((c) => c.tag === "NAME")?.value ?? "").split("/")[0];
    addSex(people, id, sexFromGivenName(given));
  }
}

/**
 * Last word on the couples whose spouse slots were only a guess: when the sexes
 * picked up elsewhere in the file say the two are the wrong way round, swap
 * them. Runs once the whole CSV is read, so it sees every mention — a woman
 * named as somebody's mother in a later row settles a marriage guessed rows
 * earlier. Silent when the sexes are unknown or agree with the guess.
 */
export function settleGuessedRoles(people: People): void {
  const sexOf = (id: string | undefined): Sex | undefined => {
    const record = id ? people.indi.get(id) : undefined;
    return record?.children.find((c) => c.tag === "SEX")?.value as Sex | undefined;
  };
  for (const fam of people.guessedRoles.values()) {
    const husb = fam.children.find((c) => c.tag === "HUSB");
    const wife = fam.children.find((c) => c.tag === "WIFE");
    if (!husb?.value || !wife?.value) continue;
    const hSex = sexOf(husb.value);
    const wSex = sexOf(wife.value);
    if (hSex === "M" || wSex === "F") continue; // the guess holds
    if (hSex !== "F" && wSex !== "M") continue; // nothing says otherwise
    [husb.value, wife.value] = [wife.value, husb.value];
  }
  people.guessedRoles.clear();
}

/**
 * A date or place cell without the note the index appends to it — a marginal
 * remark from the register itself, marked 🗒 ("+ 20.11.1882", "Podatki na 2
 * straneh") or ✝ (a death recorded on the same page). The note follows the
 * value it annotates, so everything from its opening bracket goes: what stands
 * before it is the real date or place, and dropping the whole cell over a
 * remark cost the record its birth date — an unreadable `28 AUG 1880 (✝ 28 AUG
 * 1880)` scores as a *missing* birth key, which is 15 points off a pair that
 * agrees in every field. The remark itself is not imported: a note saying the
 * child died on its birth day and another saying two years later cannot both
 * be written as a death date, and the register's own words are the reader's to
 * judge (they stay in the link the row carries).
 */
export function withoutAnnotation(value: string): string {
  const at = value.search(/\((?:🗒|✝)/u);
  return (at >= 0 ? value.slice(0, at) : value).trim();
}

/**
 * Strip a trailing "(...)" annotation an index appends to a surname — an
 * archival spelling variant (e.g. the German transliteration "Jakopič
 * (Jakopetsch)" in old church-register extracts) or a maiden/married-name
 * cross-reference (e.g. "Cegnar (Briško)") — so it doesn't pollute the
 * literal surname used both to look up the main individual and to score
 * how well the two records match. Returns the value unchanged when there's
 * no trailing parenthetical.
 */
export function stripSurnameAnnotation(value: string): string {
  return value.replace(/\s*\([^()]*\)\s*$/, "").trim();
}

/** Split a "Given Surname" string into NAME parts (last word = surname). */
export function splitName(full: string): { given: string; surname: string } {
  const stripped = stripSurnameAnnotation(full);
  const idx = stripped.lastIndexOf(" ");
  if (idx < 0) return { given: stripped, surname: "" };
  return { given: stripped.slice(0, idx).trim(), surname: stripped.slice(idx + 1).trim() };
}

/** Push a dated/placed/linked event node, omitting it entirely when date, place
 *  and links are all empty. Links (e.g. a Matricula marriage-book URL) are
 *  attached as the event's own WWW children so review/merge treats them as that
 *  event's citation rather than a disconnected record-level link. */
export function pushEvent(
  into: GedNode[],
  tag: string,
  date: string,
  place: string,
  links: string[] = [],
  extra: GedNode[] = [],
): GedNode | undefined {
  const children: GedNode[] = [];
  const dateValue = withoutAnnotation(date);
  const placeValue = withoutAnnotation(place);
  if (dateValue) children.push(node(2, "DATE", dateValue));
  if (placeValue) children.push(node(2, "PLAC", placeValue));
  for (const url of links) children.push(node(2, "WWW", url));
  children.push(...extra);
  if (!children.length) return undefined;
  const event: GedNode = { level: 1, tag, children };
  into.push(event);
  return event;
}
