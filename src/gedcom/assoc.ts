/**
 * Associations (`ASSO`) — the people a record names who are not its relatives:
 * the godparents at a baptism, the witnesses at a wedding, the priest who
 * officiated. Parish registers are largely made of them, and GEDCOM has
 * carried them since 5.5.1, in two dialects:
 *
 *  - **5.5.1**: `ASSO` at record level, its kind named by `TYPE INDI`/`TYPE FAM`
 *    and its role by a free-text `RELA` ("witness", "boter", "Witness at event
 *    _EVN 29" — one vendor's way of saying *which* event, since the record-level
 *    placement has thrown that away).
 *  - **7.0**: `ASSO` under the record *or* the event it belongs to, its role a
 *    `ROLE` enumeration with a `PHRASE` for anything outside it, and a `@VOID@`
 *    pointer plus `PHRASE` for an associate the file does not record as a person.
 *
 * We read every shape and normalize onto {@link Association}: a role from the
 * 7.0 enumeration, plus the file's own wording kept verbatim so display never
 * puts words in the file's mouth.
 *
 * The `RELA`⇄`ROLE` tables live here rather than in `normalize/migrate.ts`
 * (their first home) because the editor, the merge and the version migration
 * all need the same vocabulary.
 */
import type { Association, AssocRole, Dataset, GedNode } from "./types";
import { childrenByTag, firstChild } from "./node";
import { dateToSortKey, parseDate } from "./date";

/** GEDCOM 7's `ASSO`.`ROLE` enumeration, in the spec's order. */
export const ASSOC_ROLES = [
  "CHIL",
  "CLERGY",
  "FATH",
  "FRIEND",
  "GODP",
  "HUSB",
  "MOTH",
  "MULTIPLE",
  "NGHBR",
  "OFFICIATOR",
  "PARENT",
  "SPOU",
  "WIFE",
  "WITN",
  "OTHER",
] as const;

const ROLE_SET: ReadonlySet<string> = new Set(ASSOC_ROLES);

/**
 * The roles the editor offers, in the order parish research reaches for them.
 * The rest of the enumeration is read and displayed but never offered: `FATH`,
 * `MOTH`, `SPOU` and friends restate a relationship the file already records
 * structurally, and writing one is how a tree acquires two disagreeing answers
 * to the same question.
 */
export const EDITABLE_ASSOC_ROLES: readonly AssocRole[] = [
  "GODP",
  "WITN",
  "CLERGY",
  "OFFICIATOR",
  "FRIEND",
  "NGHBR",
  "MULTIPLE",
  "OTHER",
];

/** Roles that merely restate a family link the tree already carries. */
export const FAMILIAL_ASSOC_ROLES: ReadonlySet<AssocRole> = new Set<AssocRole>([
  "CHIL",
  "FATH",
  "MOTH",
  "PARENT",
  "SPOU",
  "HUSB",
  "WIFE",
]);

/** Free-text `RELA` → `ROLE` enum (English and Slovenian terms). */
export const RELA_TO_ROLE: Record<string, string> = {
  child: "CHIL",
  clergy: "CLERGY",
  priest: "CLERGY",
  duhovnik: "CLERGY",
  father: "FATH",
  friend: "FRIEND",
  prijatelj: "FRIEND",
  godparent: "GODP",
  godfather: "GODP",
  godmother: "GODP",
  boter: "GODP",
  botra: "GODP",
  husband: "HUSB",
  mother: "MOTH",
  neighbor: "NGHBR",
  neighbour: "NGHBR",
  sosed: "NGHBR",
  officiator: "OFFICIATOR",
  parent: "PARENT",
  spouse: "SPOU",
  wife: "WIFE",
  witness: "WITN",
  "priča": "WITN",
  prica: "WITN",
};

export const ROLE_TO_RELA: Record<string, string> = {
  CHIL: "child",
  CLERGY: "clergy",
  FATH: "father",
  FRIEND: "friend",
  GODP: "godparent",
  HUSB: "husband",
  MOTH: "mother",
  MULTIPLE: "multiple birth",
  NGHBR: "neighbor",
  OFFICIATOR: "officiator",
  PARENT: "parent",
  SPOU: "spouse",
  WIFE: "wife",
  WITN: "witness",
};

/** The 7.0 pointer that stands for "a record this file does not have". */
export const VOID_XREF = "@VOID@";

/**
 * Read a free-text `RELA` as a role. Exact match first, then the first word —
 * which is what rescues the 351 `Witness at event _EVN 29` lines one vendor
 * writes, without pretending to understand the rest of the sentence.
 */
export function roleFromRela(text: string): AssocRole {
  const clean = text.trim().toLowerCase();
  if (!clean) return "OTHER";
  const exact = RELA_TO_ROLE[clean];
  if (exact) return exact as AssocRole;
  const firstWord = clean.split(/[\s,;:]+/)[0];
  const byWord = RELA_TO_ROLE[firstWord];
  return (byWord as AssocRole) ?? "OTHER";
}

/** Parse one `ASSO` node. Returns undefined when it names no target at all. */
export function parseAssociation(node: GedNode): Association | undefined {
  const target = node.value?.trim();
  if (!target) return undefined;

  const assoc: Association = { targetId: target, role: "OTHER", raw: node };

  const type = firstChild(node, "TYPE")?.value?.trim().toUpperCase();
  if (type === "INDI" || type === "FAM") assoc.targetKind = type;

  const roleNode = firstChild(node, "ROLE");
  const relaNode = firstChild(node, "RELA");
  if (roleNode) {
    const token = roleNode.value?.trim().toUpperCase() ?? "";
    assoc.role = ROLE_SET.has(token) ? (token as AssocRole) : "OTHER";
    const phrase = firstChild(roleNode, "PHRASE")?.value?.trim();
    if (phrase) assoc.roleText = phrase;
    else if (!ROLE_SET.has(token) && roleNode.value?.trim()) assoc.roleText = roleNode.value.trim();
  } else if (relaNode) {
    const text = relaNode.value?.trim() ?? "";
    assoc.role = roleFromRela(text);
    if (text) assoc.roleText = text;
  }

  // A `@VOID@` association carries the associate's name on the ASSO's own
  // PHRASE — the only place a person outside the file can be named.
  const phrase = firstChild(node, "PHRASE")?.value?.trim();
  if (phrase) assoc.name = phrase;

  const date = firstChild(node, "DATE")?.value;
  if (date) assoc.date = parseDate(date);

  return assoc;
}

/** Every association hanging directly off `node` (a record or an event). */
export function associationsIn(node: GedNode): Association[] {
  const out: Association[] = [];
  for (const child of childrenByTag(node, ["ASSO", "_ASSO"])) {
    const assoc = parseAssociation(child);
    if (assoc) out.push(assoc);
  }
  return out;
}

/** True for an association that names nobody the file records. */
export function isVoidAssociation(assoc: Association): boolean {
  return assoc.targetId.toUpperCase() === VOID_XREF;
}

// ── Who names whom ───────────────────────────────────────────────────────────

/** One record naming another: the "named as godparent of …" side of an ASSO. */
export interface AssocRef {
  /** The record that carries the `ASSO` line. */
  fromId: string;
  fromKind: "individual" | "family";
  /** The event the association hangs under, when it is not record-level. */
  eventTag?: string;
  /** That event's date sort key, so a list of them reads chronologically — a
   *  person stood godparent at one baptism after another, and file order is not
   *  the order they happened in. An undated event is `Infinity`, to sort last:
   *  `dateToSortKey`'s own unknown-date sentinel (9,999,999) is *smaller* than
   *  any real year's key (1874 → 18,740,000), which would put the undated
   *  first. */
  sortKey: number;
  /** That event's year, so the list can say *which* baptism or wedding. */
  year?: number;
  assoc: Association;
}

/**
 * Reverse index of every association in the file: associate id → the records
 * naming them.
 *
 * Associations are stored one-sidedly on purpose — a mirrored `ASSO` on the
 * associate is a second copy to keep in step, and half-updated pairs are how
 * that always ends. The other direction is this view instead, rebuilt per edit
 * generation (see `DatasetDerivations`).
 */
export type AssociationIndex = Map<string, AssocRef[]>;

export function buildAssociationIndex(dataset: Dataset): AssociationIndex {
  const index: AssociationIndex = new Map();

  const add = (ref: AssocRef) => {
    if (isVoidAssociation(ref.assoc)) return; // names a person, points at no record
    const list = index.get(ref.assoc.targetId);
    if (list) list.push(ref);
    else index.set(ref.assoc.targetId, [ref]);
  };

  const walk = (id: string, kind: AssocRef["fromKind"], raw: GedNode) => {
    // A record-level association belongs to no event and so has no date of its
    // own: it sorts with the undated, at the end.
    for (const assoc of associationsIn(raw)) {
      add({ fromId: id, fromKind: kind, sortKey: Number.POSITIVE_INFINITY, assoc });
    }
    for (const child of raw.children) {
      if (child.tag === "ASSO" || child.tag === "_ASSO") continue;
      const assocs = associationsIn(child);
      if (!assocs.length) continue;
      const date = parseDate(firstChild(child, "DATE")?.value ?? "");
      const sortKey = date?.year == null ? Number.POSITIVE_INFINITY : dateToSortKey(date);
      for (const assoc of assocs) {
        add({ fromId: id, fromKind: kind, eventTag: child.tag, sortKey, year: date?.year, assoc });
      }
    }
  };

  for (const indi of dataset.individuals.values()) walk(indi.id, "individual", indi.raw);
  for (const fam of dataset.families.values()) walk(fam.id, "family", fam.raw);
  // Each associate's list reads chronologically: one baptism after another, as
  // they happened, rather than in the order the file happens to store people.
  for (const refs of index.values()) refs.sort((a, b) => a.sortKey - b.sortKey);
  return index;
}

// ── Keeping pointers honest ──────────────────────────────────────────────────

/** One association the merge could not bring across, for the change report. */
export interface UnresolvedAssociation {
  /** The record that carries it, in the merged output. */
  recordId: string;
  /** The associate's id in the incoming file. */
  incomingId: string;
  /** The associate's name, where the incoming file could supply one. */
  name?: string;
}

/**
 * Resolve the associations the merge copied out of the compare file.
 *
 * Each carries a pointer in the compare file's namespace and the
 * `foreignPointer` marker that says so (see {@link GedNode.foreignPointer}).
 * `resolve` maps an incoming id to the main-side record the merge gave that
 * person; an association whose associate never made it into the merged file is
 * dropped and reported, because a pointer to nothing dangles and a pointer left
 * in the wrong namespace can quietly land on an unrelated main record.
 *
 * Also drops a copy that duplicates an association already on the same
 * container — two files naming the same godparent at the same baptism is
 * agreement, not two godparents.
 */
export function remapMergedAssociations(
  records: GedNode[],
  resolve: (incomingId: string) => string | undefined,
): UnresolvedAssociation[] {
  const dropped: UnresolvedAssociation[] = [];

  // `ASSO` and the vendor tags the merge marked alike (`_SHAR`, …): any
  // marked node is the compare file's pointer, wherever it sits.
  const slotKey = (child: GedNode, id: string) =>
    `${child.tag}|${id}|${firstChild(child, "ROLE")?.value ?? firstChild(child, "RELA")?.value ?? ""}`;
  const inContainer = (recordId: string, container: GedNode) => {
    if (!container.children.length) return;
    const seen = new Set<string>();
    // Associations already in the main's own namespace claim their slot first,
    // so an incoming copy of one is recognised as the duplicate it is.
    for (const child of container.children) {
      if (child.foreignPointer || (child.tag !== "ASSO" && !child.tag.startsWith("_"))) continue;
      seen.add(slotKey(child, child.value ?? ""));
    }
    container.children = container.children.filter((child) => {
      if (!child.foreignPointer) return true;
      delete child.foreignPointer;
      const incomingId = child.value?.trim() ?? "";
      // A name-only association names nobody to resolve — it travels as it is.
      if (incomingId.toUpperCase() === VOID_XREF) return true;
      const mainId = resolve(incomingId);
      if (!mainId) {
        dropped.push({ recordId, incomingId, name: firstChild(child, "PHRASE")?.value });
        return false;
      }
      child.value = mainId;
      const key = slotKey(child, mainId);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    for (const child of container.children) inContainer(recordId, child);
  };

  for (const record of records) {
    if (record.tag !== "INDI" && record.tag !== "FAM") continue;
    inContainer(record.xref ?? "", record);
  }
  return dropped;
}

/** A family's own member lines — re-pointed (or dropped) by the relationship
 *  code (`removeIndividual`, the duplicate merge's spouse/child steps), never
 *  by the generic pointer pass below. */
function isMemberLine(record: GedNode, line: GedNode, depth: number): boolean {
  return record.tag === "FAM" && depth === 1 && (line.tag === "HUSB" || line.tag === "WIFE" || line.tag === "CHIL");
}

/**
 * The INDI/FAM records (besides the targets' own) holding a pointer to any of
 * `targetIds` at any depth — an `ASSO`, an `ALIA`, `ANCI`/`DESI`, a vendor `_`
 * pointer — family member lines aside. It is the set a caller must snapshot
 * before {@link repointAssociations}, since such a line can be carried by any
 * record in the file, not just by the people involved.
 */
export function recordsNaming(records: Iterable<GedNode>, targetIds: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const names = (record: GedNode, node: GedNode, depth: number): boolean =>
    node.children.some((c) => {
      const v = c.value?.trim();
      return (!!v && targetIds.has(v) && !isMemberLine(record, c, depth + 1)) || names(record, c, depth + 1);
    });
  for (const r of records) {
    if ((r.tag === "INDI" || r.tag === "FAM") && r.xref && !targetIds.has(r.xref) && names(r, r, 0)) out.push(r.xref);
  }
  return out;
}

/**
 * Repoint or drop every line naming `fromId` — `ASSO`, `ALIA`, a vendor `_`
 * pointer, at any depth of any other person or family; family member lines
 * are the relationship code's.
 *
 * `toId` repoints (a duplicate merged into its survivor keeps being the child's
 * godparent); a line that would then point at its own record (an `ALIA`
 * between the two duplicates) is dropped, as are those the survivor carried
 * over from the absorbed record. Omitting `toId` drops each such line with its
 * subtree (the person is gone, and a pointer to nothing is exactly the
 * dangling reference the health check would report afterwards).
 *
 * Returns the ids of the records it changed, so callers can rebuild and patch
 * precisely those.
 */
export function repointAssociations(
  records: Iterable<GedNode>,
  fromId: string,
  toId?: string,
): string[] {
  const touched: string[] = [];
  const inNode = (record: GedNode, node: GedNode, depth: number): boolean => {
    let changed = false;
    const kept: GedNode[] = [];
    for (const child of node.children) {
      const repointed = child.value?.trim() === fromId && !isMemberLine(record, child, depth + 1);
      if (repointed) {
        changed = true;
        if (!toId) continue; // dropped when there is nothing to point at
        child.value = toId;
      }
      if (toId && (repointed || record.xref === toId) && child.value?.trim() === record.xref) {
        changed = true;
        continue;
      }
      changed = inNode(record, child, depth + 1) || changed;
      kept.push(child);
    }
    if (changed) node.children = kept;
    return changed;
  };
  for (const record of records) {
    if ((record.tag !== "INDI" && record.tag !== "FAM") || !record.xref || record.xref === fromId) continue;
    if (inNode(record, record, 0)) touched.push(record.xref);
  }
  return touched;
}
