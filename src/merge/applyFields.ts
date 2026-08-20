import { looksLikeUrl } from "../gedcom/builder";
import {
  addObjeToSource,
  attachSourceCitation,
  bumpSourceCacheVersion,
  createMediaRecord,
  EDITABLE_LINK_TAGS,
  EVENT_CHILD_ORDER,
  EVENT_LINK_TAG,
  getSourceLookup,
  INDI_CHILD_ORDER,
  insertGrouped,
  insertOrdered,
  insertRecord,
  markEventTouched,
  NAME_CHILD_ORDER,
  SOUR_TRAILING_TAGS,
  writeNameValue,
} from "../gedcom/edit";
import { buildObjeIndex, findExistingSource, matchesPage, newSourceCitations, sourceContentKey } from "../gedcom/source";
import { detectPrivacyStyle, isPrivateNode, setPrivateFlag } from "../gedcom/private";
import type { Dataset, GedNode, PersonName } from "../gedcom/types";
import { childrenByTag, childText, cloneNode, firstChild, hasChild, removeChildren } from "../gedcom/node";
import { parseDate } from "../gedcom/date";
import { parseName } from "../gedcom/name";
import { linkKey } from "../normalize/links";
import { lifespanAnchors, zoneSortKey } from "../review/fields";
import { defaultChoice, type FieldChoice, type FieldRow } from "../review/types";
import type { ChangeReport, CustomTagNode, FieldChange } from "./merge";

type Row = FieldRow;

/** The sub-fields an event row key can end in — the `<sub>` of a `TAG.<sub>`
 *  or `TAG.<n>.<sub>` key minted by `individualFieldRows`. */
const EVENT_SUB_FIELDS = ["type", "date", "place", "addr", "note", "agency", "cause", "sources", "value"] as const;
export type EventSubField = (typeof EVENT_SUB_FIELDS)[number];

function isEventSubField(sub: string | undefined): sub is EventSubField {
  return !!sub && (EVENT_SUB_FIELDS as readonly string[]).includes(sub);
}

/** An individual event row key, parsed into its typed parts. */
export interface ParsedEventRowKey {
  /** GEDCOM event tag ("BIRT", "RESI", …). */
  tag: string;
  /** Which sub-field of the event the row edits. */
  sub: EventSubField;
  /** Row-key prefix identifying the event instance ("BIRT", "RESI.0", …) —
   *  ties the row to its `.header` group in the save preview. */
  eventKey: string;
}

/** Parse an event row key ("BIRT.date", "RESI.0.place", …); undefined for
 *  non-event keys ("given", "father", "notes", …). */
export function parseEventRowKey(key: string): ParsedEventRowKey | undefined {
  const parts = key.split(".");
  // Multi-instance keys carry an output-order index in the middle: TAG.<n>.<sub>.
  const [tag, sub] = parts.length === 3 && /^\d+$/.test(parts[1])
    ? [parts[0], parts[2]]
    : parts.length === 2
      ? [parts[0], parts[1]]
      : [undefined, undefined];
  if (!tag || !isEventSubField(sub)) return undefined;
  return { tag, sub, eventKey: key.slice(0, -(sub.length + 1)) };
}

export interface EventSubEdit {
  sub: EventSubField;
  field: string;
  from: string;
  to: string;
  action: FieldChoice;
}

/** Map an event sub-field key suffix to its GEDCOM sub-tag. */
export const SUB_TAG: Record<string, string> = { type: "TYPE", date: "DATE", place: "PLAC", addr: "ADDR", note: "NOTE", agency: "AGNC", cause: "CAUS" };

/** Translation key for a bare sub-field label (event name shown separately as the group header). */
export const SUB_LABEL_KEY: Record<string, string> = {
  value: "event.colValue",
  type: "event.colType",
  date: "event.colDate",
  place: "event.colPlace",
  addr: "event.colAddr",
  note: "event.colNote",
  agency: "event.colAgency",
  cause: "event.colCause",
};

/** Order in which an event's changed sub-fields are joined into one preview line. */
export const SUB_JOIN_ORDER = ["type", "value", "date", "place", "addr", "note", "agency", "cause"];

/** The event sub-fields that may legally repeat under one event, so "both" can
 *  genuinely append a second one. Everything else (TYPE, DATE, PLAC, ADDR,
 *  AGNC, CAUS, the line value) is {0:1} per event. */
const REPEATABLE_EVENT_SUBS = new Set<EventSubField>(["note", "sources"]);

/** The choice to actually apply for an event sub-field: "both" on a
 *  single-cardinality sub means "replace" — a second DATE/PLAC under one event
 *  would be invalid GEDCOM, and overwriting while reporting "added" hid what
 *  really happened. Shared by the individual row loop and the family-event
 *  application in applyRelations. */
export function effectiveEventSubChoice(sub: EventSubField, choice: FieldChoice): FieldChoice {
  return choice === "both" && !REPEATABLE_EVENT_SUBS.has(sub) ? "incoming" : choice;
}

/**
 * Whether "both" genuinely keeps both values for this row. False for the
 * single-cardinality fields (SEX, NICK, an event's TYPE/DATE/PLAC/… sub-tag or
 * line value — individual or family), where the engine treats "both" as
 * "incoming"; the review panels use this to offer only the choices that mean
 * what they say.
 */
export function rowCanKeepBoth(key: string): boolean {
  if (key === "sex" || key === "nickname") return false;
  const parsed = parseEventRowKey(key);
  if (parsed) return effectiveEventSubChoice(parsed.sub, "both") === "both";
  // Family event rows: fam.<incFamId>.<TAG>.<sub>.
  const parts = key.split(".");
  const famSub = key.startsWith("fam.") && parts.length >= 4 ? parts[parts.length - 1] : undefined;
  if (isEventSubField(famSub)) return effectiveEventSubChoice(famSub, "both") === "both";
  return true;
}

/**
 * Combines an event's changed sub-fields (date/value/place/addr/note/agency) into
 * one preview line — e.g. "Occupation: + šivilja v pokoju · 1998" — instead of a
 * separate "Date:"/"Occupation:" line each, matching the single-line look already
 * used when a whole event is added or removed as a unit. Falls back to one row per
 * sub-field when they don't share the same action (the user picked "incoming" for
 * one and "both"/"main" for another), since a single from/to pair can't represent that.
 */
export function combineEventEdits(recordId: string, group: string, entries: EventSubEdit[]): FieldChange[] {
  if (entries.length === 0) return [];
  if (entries.length === 1) {
    const e = entries[0];
    return [{ recordId, field: e.field, from: e.from, to: e.to, action: e.action, group, unedited: e.action === "incoming" }];
  }
  const action = entries[0].action;
  if (!entries.every((e) => e.action === action)) {
    return entries.map((e) => ({ recordId, field: e.field, from: e.from, to: e.to, action: e.action, group, unedited: e.action === "incoming" }));
  }
  const ordered = [...entries].sort((a, b) => SUB_JOIN_ORDER.indexOf(a.sub) - SUB_JOIN_ORDER.indexOf(b.sub));
  return [{
    recordId,
    field: group,
    from: ordered.map((e) => e.from).filter(Boolean).join(" · "),
    to: ordered.map((e) => e.to).filter(Boolean).join(" · "),
    action,
    group,
    unedited: action === "incoming",
  }];
}

/**
 * Whether `applyRows` may write this row's incoming value over the main's —
 * i.e. whether it is a scalar/event field this module owns. Relatives and
 * family rows are stitched structurally elsewhere and never overwrite, and an
 * event's link row is additive. The record-level "links" (Sources) row *is*
 * included: its "incoming" choice strips the main's SOUR citations, which is
 * exactly the destructive overwrite the edited-after-confirm gate exists to
 * stop — a citation added in Edit after confirming must not be silently
 * replaced at save time.
 *
 * Shared by `applyRows` and {@link snapshotMainValues} so the set of rows the
 * merge can overwrite is the same set the confirm-time snapshot records.
 */
export function isOverwritableRow(row: Row, handled: Set<string>): boolean {
  if (row.isGroupHeader || row.isEventHeader) return false;
  if (handled.has(row.key) || row.key.startsWith("fam.")) return false;
  if (row.key.endsWith(".links")) return false;
  return true;
}

/**
 * The main side's current value for every overwritable row, for stamping onto a
 * decision as it is confirmed (see `CandidateDecision.mainFields`).
 *
 * Empty values are omitted: a missing key and an empty string mean the same
 * thing here — the main had nothing in that field — so storing every blank row
 * would only bloat the persisted session.
 *
 * Callers must build `rows` the way the merge does (`individualFieldRows` with
 * the same dataset pair and no `showAge`), or the strings won't be comparable.
 */
export function snapshotMainValues(rows: Row[], handled: Set<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    if (!isOverwritableRow(row, handled) || !row.main) continue;
    out[row.key] = row.main;
  }
  return out;
}

export function applyRows(
  target: GedNode,
  incomingRecord: GedNode,
  recordId: string,
  rows: Row[],
  fields: Record<string, FieldChoice>,
  report: ChangeReport,
  touched: Set<string>,
  handled: Set<string>,
  t: (key: string, opts?: Record<string, unknown>) => string,
  linkFormat: LinkFormat,
  records: GedNode[],
  sourMap: SourXrefMap,
  /** The main's values when the match was confirmed — see `mainFields`. Absent
   *  for decisions confirmed before this was recorded, which keep the old
   *  behaviour (the incoming choice always wins). */
  mainAtConfirm?: Record<string, string>,
): void {
  // Map each event's row-key prefix (e.g. "BIRT", "BIRT.0") to its display
  // name, so date/place/note/source changes can be grouped under one header
  // in the save preview instead of repeating the event name on every line.
  const eventGroups = new Map<string, string>();
  // New main events created for an incoming-only event (eventMainIdx -1),
  // keyed by `${tag}:${eventCompareIdx}` — that pair uniquely identifies the
  // incoming event across this record's rows. Without this cache, each of a
  // new event's sub-fields (date/place/value/…) would create its own separate
  // node instead of all landing on the one node for that event.
  const newEventNodes = new Map<string, GedNode>();
  for (const row of rows) {
    if (row.isEventHeader) eventGroups.set(row.key.replace(/\.header$/, ""), row.label);
  }
  // Sub-field edits (date/value/place/addr/note/agency) for each event instance,
  // collected here instead of pushed straight to `report.changes` so they can be
  // combined into one preview line via `combineEventEdits` once the row loop ends.
  const eventEdits = new Map<string, EventSubEdit[]>();
  for (const row of rows) {
    // Nothing on the incoming side to take, or the two already agree.
    if (row.state === "agree" || row.state === "main-only") continue;
    // Handled elsewhere (family spouses/children go through applyFamilyStructure).
    if (handled.has(row.key) || row.key.startsWith("fam.")) continue;
    let choice = fields[row.key] ?? defaultChoice(row as never);
    if (choice === "main") continue;
    const parsed = parseEventRowKey(row.key);

    // "Both" on a field that can hold only one value (SEX, NICK, an event's
    // TYPE/DATE/PLAC/… sub-tag or line value) cannot keep two: writing a second
    // sub-node would be invalid GEDCOM, so it means "replace" — i.e. exactly
    // "incoming", held to the same edited-after-confirm gate below. Only the
    // genuinely repeatable rows (names, notes, sources, links, ids) append.
    if (choice === "both" && !rowCanKeepBoth(row.key)) choice = "incoming";

    // An Edit-mode change made *after* this match was confirmed wins over the
    // incoming value: the field choice was made against a value the user has
    // since replaced, so honouring it would silently undo the later edit. Only
    // "incoming" is gated — a surviving "both" appends and destroys nothing.
    if (
      choice === "incoming" &&
      mainAtConfirm &&
      isOverwritableRow(row, handled) &&
      row.main !== (mainAtConfirm[row.key] ?? "")
    ) {
      report.deferred.push({ recordId, field: row.label, reason: t("merge.reason.editedAfterConfirm") });
      continue;
    }

    if (row.key === "links") {
      // The record-level "Sources" row carries both SOUR citations and plain
      // link icons (same shape as an event's sources row), so apply each.
      if (applyRecordSources(target, incomingRecord, choice, INDI_CHILD_ORDER, sourMap, report.customTags)) {
        report.changes.push({ recordId, field: row.label, from: "", to: "", action: choice, unedited: choice === "incoming", sources: newSourceCitations(row.mainSources, row.incomingSources) });
        touched.add(recordId);
      }
      const added = applyLinks(target, row.incomingLinkIcons ?? [], row.mainLinkIcons ?? [], linkFormat, records, reservedXrefs(sourMap));
      if (added.length) {
        report.changes.push({ recordId, field: row.label, from: "", to: "", action: choice, unedited: choice === "incoming", links: added });
        touched.add(recordId);
      }
      continue;
    }
    if (row.key.endsWith(".links")) {
      report.deferred.push({ recordId, field: row.label, reason: t("merge.reason.linkNotImplemented") });
      continue;
    }

    let applied = false;
    if (row.key === "given" || row.key === "surname") {
      applied = applyNamePart(target, incomingRecord, row.key, choice, sourMap, report.customTags);
    } else if (row.key === "sex") {
      applied = setChild(target, "SEX", incomingRecord, choice, INDI_CHILD_ORDER, sourMap, undefined, report.customTags);
    } else if (row.key === "nickname") {
      applied = applyNickname(target, incomingRecord, choice, sourMap, report.customTags);
    } else if (row.key === "additionalNames") {
      applied = applyAdditionalNames(target, incomingRecord, choice, sourMap, report.customTags);
    } else if (row.key === "notes") {
      applied = applyNotes(target, incomingRecord, choice, sourMap, INDI_CHILD_ORDER, report.customTags);
    } else if (row.key === "fsid") {
      applied = applyFsIds(target, incomingRecord, choice);
    } else if (row.key === "private") {
      applied = applyPrivateFlag(target, records);
    } else if (parsed) {
      const { tag, sub } = parsed;
      // The row's own true per-side array positions, not a position parsed
      // back out of `key` — that numeric suffix is an output-order index from
      // date/place pairing, not necessarily either side's real array index
      // once a tag has more than one instance (see `FieldRow.eventMainIdx`).
      const mainIdx = row.eventMainIdx ?? 0;
      const compareIdx = row.eventCompareIdx ?? 0;
      if (sub === "value") {
        applied = applyEventValue(target, incomingRecord, tag, choice, mainIdx, compareIdx, INDI_CHILD_ORDER, newEventNodes);
      } else if (sub === "sources") {
        applied = applyEventSources(target, incomingRecord, tag, choice, mainIdx, compareIdx, INDI_CHILD_ORDER, sourMap, records, report.customTags, newEventNodes);
      } else {
        // Places are already reshaped into the main's layout when the
        // incoming file was loaded, so the raw incoming node can be copied
        // directly like any other field.
        applied = applyEventSub(target, incomingRecord, tag, SUB_TAG[sub], choice, mainIdx, compareIdx, INDI_CHILD_ORDER, sourMap, report.customTags, newEventNodes);
      }
    }

    if (applied) {
      const group = parsed ? eventGroups.get(parsed.eventKey) : undefined;
      if (parsed && group && parsed.sub !== "sources") {
        let entries = eventEdits.get(parsed.eventKey);
        if (!entries) { entries = []; eventEdits.set(parsed.eventKey, entries); }
        entries.push({ sub: parsed.sub, field: row.label, from: row.main, to: row.incoming, action: choice });
      } else if (parsed?.sub === "sources") {
        // Render added citations as the same 📖/🔗 icons the main UI uses,
        // inline on the event's line — not as a separate "Source: …" text row.
        report.changes.push({ recordId, field: row.label, from: "", to: "", action: choice, group, unedited: choice === "incoming", sources: newSourceCitations(row.mainSources, row.incomingSources) });
      } else {
        const identity = row.key === "given" || row.key === "surname" || row.key === "sex";
        report.changes.push({ recordId, field: row.label, from: row.main, to: row.incoming, action: choice, group, unedited: choice === "incoming", identity: identity || undefined });
      }
      touched.add(recordId);
    }
  }
  for (const [eventKey, entries] of eventEdits) {
    report.changes.push(...combineEventEdits(recordId, eventGroups.get(eventKey)!, entries));
  }
}

/**
 * How the main file stores a record-level link.
 *  - "WWW": a plain `WWW <url>` line (RootsMagic, Ancestry, Synium, …).
 *  - "WEBTAG": Family Historian's `_WEBTAG` block, with the URL on a `URL`
 *    sub-line (`1 _WEBTAG` / `2 URL <url>`).
 *  - "OBJE": a shared multimedia record holding the URL in `FILE`
 *    (`0 @On@ OBJE` / `1 FILE <url>`), referenced via `1 OBJE @On@`.
 */
export type LinkFormat = "WWW" | "WEBTAG" | "OBJE";

/**
 * Append a link node for each incoming link the main doesn't already have
 * (by `linkKey`), shaped to match the main's own link format. Returns the
 * URLs actually added.
 *
 * Before minting a plain link, checks whether the URL belongs to a paginated
 * archive book (Matricula, parish registers, …) the main already cites as
 * a `SOUR` — same matching `findExistingSource` does for the manual "Add
 * Source" dialog. If so, the incoming link is attached as a `SOUR` citation
 * to that book (reusing its existing `OBJE` page, or adding a new one) so it
 * shows with the book icon and joins that book's page collection, instead of
 * becoming a disconnected generic link.
 */
export function applyLinks(
  target: GedNode,
  incomingLinks: string[],
  mainLinks: string[],
  linkFormat: LinkFormat,
  records: GedNode[],
  /** Output xrefs already promised to compare shared records (the values of
   *  the SourXrefMap) — a minted link record must not squat on one, or the
   *  promised import would be skipped and its pointers would resolve here. */
  reservedXrefs?: ReadonlySet<string>,
): string[] {
  const existing = new Set(mainLinks.map(linkKey));
  const added: string[] = [];
  for (const url of incomingLinks) {
    const key = linkKey(url);
    if (existing.has(key)) continue;
    existing.add(key);
    // The cached lookup makes this O(1) per link instead of a full-forest
    // scan; addObjeToSource/createMediaRecord bump the cache version, so a
    // page OBJE minted for one link is visible to the next link's lookup.
    const sourceMatch = findExistingSource(records, url, undefined, getSourceLookup(records));
    if (sourceMatch) {
      if (!sourceMatch.objeXref) addObjeToSource(records, sourceMatch.sourceXref, url);
      attachSourceCitation(target, sourceMatch.sourceXref, sourceMatch.page, INDI_CHILD_ORDER);
    } else {
      insertOrdered(target, buildLinkNode(linkFormat, url, records, reservedXrefs), INDI_CHILD_ORDER);
    }
    added.push(url);
  }
  return added;
}

/**
 * Build a new link node for `url`, shaped per `format`. For "OBJE", the
 * shared `createMediaRecord` mints the top-level record — same FORM habit,
 * record grouping, xref bookkeeping and cache bump as an editor-added one —
 * and this returns a pointer to it.
 */
function buildLinkNode(format: LinkFormat, url: string, records: GedNode[], reservedXrefs?: ReadonlySet<string>): GedNode {
  if (format === "WEBTAG") {
    const webtag = newNode("_WEBTAG");
    webtag.children.push(newNode("URL", url));
    return webtag;
  }
  if (format === "OBJE") {
    const obje = createMediaRecord(records, url, undefined, reservedXrefs);
    return newNode("OBJE", obje.xref);
  }
  return newNode("WWW", url);
}

/**
 * Which `LinkFormat` the main file uses for its own record-level links, so
 * newly added links are written the same way. Counts `WWW` lines, `_WEBTAG`
 * blocks, and `OBJE` pointers to a media record whose `FILE` is a URL, across
 * all individuals and families (including their events), and picks whichever
 * the main already uses most; defaults to plain `WWW` lines when the main
 * has none of these (or is ambiguous).
 */
export function detectLinkFormat(main: Dataset): LinkFormat {
  const objeFiles = new Map<string, string>();
  for (const rec of main.records) {
    if (rec.tag !== "OBJE" || !rec.xref) continue;
    const file = firstChild(rec, "FILE")?.value?.trim();
    if (file) objeFiles.set(rec.xref, file);
  }

  let www = 0;
  let webtag = 0;
  let obje = 0;
  const visit = (node: GedNode): void => {
    if (node.tag === "WWW" && node.value) www++;
    else if (node.tag === "_WEBTAG") webtag++;
    else if (node.tag === "OBJE" && node.value) {
      const file = objeFiles.get(node.value.trim());
      if (file && looksLikeUrl(file)) obje++;
    }
    for (const child of node.children) visit(child);
  };
  for (const indi of main.individuals.values()) visit(indi.raw);
  for (const fam of main.families.values()) visit(fam.raw);

  const max = Math.max(www, webtag, obje);
  if (max === 0) return "WWW";
  if (obje === max) return "OBJE";
  if (webtag === max) return "WEBTAG";
  return "WWW";
}

/** Build the sub-tag map `parseName` expects from a NAME node's children.
 *  `SECG` is left out: parseName folds it into the given name, and writing
 *  that fold back into the slash value would duplicate the sub-tag's content. */
function parseNameNode(name: GedNode): PersonName {
  const subTags = new Map<string, string>();
  for (const c of name.children) {
    if (c.tag === "SECG" || subTags.has(c.tag) || !c.value?.trim()) continue;
    subTags.set(c.tag, c.value.trim());
  }
  return parseName(name.value, subTags);
}

/**
 * Apply one name-part row (given or surname) on its own, so the two rows'
 * choices are honoured independently — given=incoming with surname=main must
 * not smuggle the incoming surname in.
 *
 * "both" keeps both full names by appending the incoming NAME as an
 * additional name record (once — the other part row choosing "both" finds it
 * already there). A scalar "incoming" rewrites only that part of the main's
 * primary NAME value, keeping the other part, any inline suffix, and all
 * sub-structure (NICK, SOUR, NSFX, …): the nickname and additional-names rows
 * own their own merges, and swapping the whole node would overrule them.
 */
export function applyNamePart(
  target: GedNode,
  incomingRecord: GedNode,
  part: "given" | "surname",
  choice: FieldChoice,
  sourMap: SourXrefMap,
  customTags: Record<string, CustomTagNode[]>,
): boolean {
  const incName = firstChild(incomingRecord, "NAME");
  if (!incName) return false;
  if (choice === "both") {
    const clone = cloneNodeRemapped(incName, sourMap);
    const cloneValue = (clone.value ?? "").trim();
    if (childrenByTag(target, "NAME").some((n) => (n.value ?? "").trim() === cloneValue)) return false;
    collectCustomTags(clone, customTags);
    const idx = target.children.findIndex((c) => c.tag === "NAME");
    if (idx < 0) insertOrdered(target, clone, INDI_CHILD_ORDER);
    else insertAt(target, idx + 1, clone);
    return true;
  }
  const incParsed = parseNameNode(incName);
  const incPart = part === "given" ? incParsed.given : incParsed.surname;
  if (!incPart) return false;
  let name = firstChild(target, "NAME");
  if (!name) {
    name = newNode("NAME");
    insertOrdered(target, name, INDI_CHILD_ORDER);
  }
  const current = parseNameNode(name);
  const given = part === "given" ? incPart : current.given ?? "";
  const surname = part === "surname" ? incPart : current.surname ?? "";
  const before = name.value;
  writeNameValue(name, given, surname);
  return name.value !== before;
}

/**
 * Copy NOTE children from the incoming record. "incoming" replaces any existing
 * notes; "both" appends them. Used for both individual and family notes — pass
 * the matching canonical order so a brand-new NOTE lands before any trailing
 * CHAN/CREA rather than after it.
 */
export function applyNotes(
  target: GedNode,
  incoming: GedNode,
  choice: FieldChoice,
  sourMap: SourXrefMap,
  order: string[],
  customTags: Record<string, CustomTagNode[]>,
): boolean {
  const incNotes = childrenByTag(incoming, "NOTE");
  if (!incNotes.length) return false;
  if (choice !== "both") removeChildren(target, "NOTE");
  for (const n of incNotes) {
    const clone = cloneNodeRemapped(n, sourMap);
    collectCustomTags(clone, customTags);
    insertOrdered(target, clone, order);
  }
  return true;
}

/**
 * Add the private flag to `target` (in the main file's own dialect) when the
 * incoming side declares it. Additive only: merging never *removes* a
 * main-side privacy marker (that row is "main-only" and never reaches here).
 */
export function applyPrivateFlag(target: GedNode, records: GedNode[]): boolean {
  if (isPrivateNode(target)) return false;
  setPrivateFlag(target, true, detectPrivacyStyle(records), records);
  return true;
}

/** FamilySearch person-id tags (MacFamilyTree `_FID`, RootsMagic `_FSFTID`). */
const FSID_TAGS = ["_FID", "_FSFTID"];

/**
 * Copy the incoming record's FamilySearch id(s) onto the main record,
 * uppercased to the ids' canonical form. New ids are written with the main's
 * own fs-tag dialect when it has one (else the incoming tag), and — like a
 * carried `_UID` — placed with {@link insertGrouped} so they stay ahead of any
 * trailing CHAN/CREA audit stamps. On a conflict, "incoming" replaces the
 * main's first id in place; "both" keeps both. Ids differing only in case
 * count as already present.
 */
export function applyFsIds(target: GedNode, incomingRecord: GedNode, choice: FieldChoice): boolean {
  const incoming = incomingRecord.children.filter((c) => FSID_TAGS.includes(c.tag) && c.value?.trim());
  if (!incoming.length) return false;
  const existing = target.children.filter((c) => FSID_TAGS.includes(c.tag));
  const have = new Set(existing.map((c) => (c.value ?? "").trim().toUpperCase()));
  const fresh = incoming
    .map((c) => c.value!.trim().toUpperCase())
    .filter((v, i, a) => !have.has(v) && a.indexOf(v) === i);
  if (!fresh.length) return false;
  const tag = existing[existing.length - 1]?.tag ?? incoming[0].tag;
  let rest = fresh;
  if (choice !== "both" && existing.length) {
    existing[0].value = fresh[0];
    rest = fresh.slice(1);
  }
  for (const value of rest) {
    insertGrouped(target, { level: target.level + 1, tag, value, children: [] }, ["CHAN", "CREA"]);
  }
  return true;
}

/** Set the NICK sub-node on the primary NAME record from the incoming side. */
export function applyNickname(
  target: GedNode,
  incomingRecord: GedNode,
  choice: FieldChoice,
  sourMap: SourXrefMap,
  customTags: Record<string, CustomTagNode[]>,
): boolean {
  const incName = firstChild(incomingRecord, "NAME");
  if (!incName) return false;
  const incNick = firstChild(incName, "NICK");
  if (!incNick) return false;
  let name = firstChild(target, "NAME");
  if (!name) {
    name = newNode("NAME");
    insertAt(target, 0, name);
  }
  return setChild(name, "NICK", incName, choice, NAME_CHILD_ORDER, sourMap, incNick, customTags);
}

/** Copy the incoming record's additional NAME nodes (everything after the first). */
export function applyAdditionalNames(
  target: GedNode,
  incoming: GedNode,
  choice: FieldChoice,
  sourMap: SourXrefMap,
  customTags: Record<string, CustomTagNode[]>,
): boolean {
  let firstSeen = false;
  const incExtra: GedNode[] = [];
  for (const c of incoming.children) {
    if (c.tag !== "NAME") continue;
    if (!firstSeen) { firstSeen = true; continue; }
    incExtra.push(c);
  }
  if (incExtra.length === 0) return false;
  if (choice !== "both") {
    // Strip target's extra NAMEs, keeping only the primary one.
    let primaryKept = false;
    target.children = target.children.filter((c) => {
      if (c.tag !== "NAME") return true;
      if (!primaryKept) { primaryKept = true; return true; }
      return false;
    });
  }
  for (const n of incExtra) {
    const clone = cloneNodeRemapped(n, sourMap);
    collectCustomTags(clone, customTags);
    insertOrdered(target, clone, INDI_CHILD_ORDER);
  }
  return true;
}

/**
 * Find the main event a row should write to: `mainEvents[mainIdx]`
 * when the row has a real main-side event, otherwise the new node created
 * for this incoming-only event's `(tag, compareIdx)` — reusing it across that
 * one event's sub-fields via `newEventNodes` instead of minting a separate
 * node per field.
 */
function resolveEventNode(
  target: GedNode,
  tag: string,
  mainIdx: number,
  compareIdx: number,
  order: string[],
  newEventNodes?: Map<string, GedNode>,
): GedNode {
  if (mainIdx >= 0) {
    const existing = childrenByTag(target, tag)[mainIdx];
    if (existing) {
      markEventTouched(existing, "changed");
      return existing;
    }
  }
  const cacheKey = `${tag}:${compareIdx}`;
  const cached = newEventNodes?.get(cacheKey);
  if (cached) return cached;
  const created = newNode(tag);
  markEventTouched(created, "new");
  insertOrdered(target, created, order);
  newEventNodes?.set(cacheKey, created);
  return created;
}

/** Copy the direct value on an event line (e.g. occupation text) from incoming to main. */
export function applyEventValue(
  target: GedNode,
  incomingRecord: GedNode,
  tag: string,
  choice: FieldChoice,
  mainIdx: number,
  compareIdx: number,
  order: string[] = [],
  newEventNodes?: Map<string, GedNode>,
): boolean {
  const incEvent = compareIdx >= 0 ? childrenByTag(incomingRecord, tag)[compareIdx] : undefined;
  if (!incEvent?.value) return false;
  if (choice === "incoming" || choice === "both") {
    const event = resolveEventNode(target, tag, mainIdx, compareIdx, order, newEventNodes);
    event.value = incEvent.value;
    return true;
  }
  return false;
}

/** Apply an event's date/place/address by copying the incoming sub-node. */
export function applyEventSub(
  target: GedNode,
  incomingRecord: GedNode,
  tag: string,
  subTag: string,
  choice: FieldChoice,
  mainIdx: number,
  compareIdx: number,
  order: string[],
  sourMap: SourXrefMap,
  customTags: Record<string, CustomTagNode[]> = {},
  newEventNodes?: Map<string, GedNode>,
): boolean {
  const incEvent = compareIdx >= 0 ? childrenByTag(incomingRecord, tag)[compareIdx] : undefined;
  const incSub = incEvent ? firstChild(incEvent, subTag) : undefined;
  if (!incSub) return false;
  const event = resolveEventNode(target, tag, mainIdx, compareIdx, order, newEventNodes);
  return setChild(event, subTag, incEvent!, choice, EVENT_CHILD_ORDER, sourMap, incSub, customTags);
}

/**
 * Apply an INDI/FAM record's own (record-level) `SOUR` citations from the
 * incoming record — its direct `SOUR` children, not those nested under an
 * event. "incoming" replaces the main's record-level citations; "both"
 * appends them. Mirrors `applyEventSources` but for the record node itself.
 * Plain record-level links are handled separately by `applyLinks`.
 */
export function applyRecordSources(
  target: GedNode,
  incomingRecord: GedNode,
  choice: FieldChoice,
  order: string[],
  sourMap: SourXrefMap,
  customTags: Record<string, CustomTagNode[]> = {},
): boolean {
  const incSours = childrenByTag(incomingRecord, "SOUR");
  if (incSours.length === 0) return false;
  if (choice !== "both") removeChildren(target, "SOUR");
  for (const s of incSours) {
    const clone = cloneNodeRemapped(s, sourMap);
    collectCustomTags(clone, customTags);
    insertOrdered(target, clone, order);
  }
  return true;
}

/** Tags an event's own attached link can use (besides a `SOUR` citation) —
 *  the edit layer's shared list, so review, edit and merge agree. */
const EVENT_LINK_TAGS = new Set<string>(EDITABLE_LINK_TAGS);

/** An event's own plain links — everything `linksNotCitedAsSource` (review/fields.ts) excludes is already a `SOUR` citation, so this mirrors that by simply reading the raw tags. */
function eventLinkUrls(event: GedNode | undefined): string[] {
  if (!event) return [];
  return event.children.filter((c) => EVENT_LINK_TAGS.has(c.tag) && c.value?.trim()).map((c) => c.value!.trim());
}

/**
 * Copy an event's `SOUR` citations and plain attached links (`WWW`/`_LINK`/…,
 * shown alongside the citations in review) from incoming to main: "incoming"
 * replaces the main's, "both" appends the incoming ones alongside them.
 * Citation values that point at a compare-file `SOUR`/`REPO` record are
 * remapped to that record's id in the merged output.
 */
export function applyEventSources(
  target: GedNode,
  incomingRecord: GedNode,
  tag: string,
  choice: FieldChoice,
  mainIdx: number,
  compareIdx: number,
  order: string[],
  sourMap: SourXrefMap,
  records: GedNode[],
  customTags: Record<string, CustomTagNode[]> = {},
  newEventNodes?: Map<string, GedNode>,
): boolean {
  const incEvent = compareIdx >= 0 ? childrenByTag(incomingRecord, tag)[compareIdx] : undefined;
  const incSours = incEvent ? childrenByTag(incEvent, "SOUR") : [];
  const incLinks = eventLinkUrls(incEvent);
  if (incSours.length === 0 && incLinks.length === 0) return false;
  const event = resolveEventNode(target, tag, mainIdx, compareIdx, order, newEventNodes);
  if (incSours.length) {
    if (choice !== "both") removeChildren(event, "SOUR");
    for (const s of incSours) {
      const clone = cloneNodeRemapped(s, sourMap);
      collectCustomTags(clone, customTags);
      insertOrdered(event, clone, EVENT_CHILD_ORDER);
    }
  }
  if (incLinks.length) {
    const existing = new Set(eventLinkUrls(event).map(linkKey));
    if (choice !== "both") {
      removeChildren(event, [...EVENT_LINK_TAGS]);
      existing.clear();
    }
    for (const url of incLinks) {
      const key = linkKey(url);
      if (existing.has(key)) continue;
      existing.add(key);
      // A link into a paginated archive book the main already cites as a
      // SOUR is attached as a citation instead of becoming a disconnected link.
      const sourceMatch = findExistingSource(records, url, undefined, getSourceLookup(records));
      if (sourceMatch) {
        if (!sourceMatch.objeXref) addObjeToSource(records, sourceMatch.sourceXref, url);
        attachSourceCitation(event, sourceMatch.sourceXref, sourceMatch.page, EVENT_CHILD_ORDER);
      } else {
        insertOrdered(event, newNode(EVENT_LINK_TAG, url), EVENT_CHILD_ORDER);
      }
    }
  }
  return true;
}

/**
 * Copy a single-valued child (e.g. SEX, or DATE under BIRT) from the incoming
 * side. "incoming" replaces the existing child; "both" appends a second one.
 * Returns false when the incoming side has no such child. A brand-new child
 * is inserted per `order` (e.g. `EVENT_CHILD_ORDER`) rather than appended, so
 * it lands among its siblings — before any trailing CHAN/CREA — instead of
 * always landing last.
 */
export function setChild(
  parent: GedNode,
  tag: string,
  incomingParent: GedNode,
  choice: FieldChoice,
  order: string[],
  sourMap: SourXrefMap,
  incChildOverride?: GedNode,
  customTags: Record<string, CustomTagNode[]> = {},
): boolean {
  const incChild = incChildOverride ?? firstChild(incomingParent, tag);
  if (!incChild) return false;
  const clone = cloneNodeRemapped(incChild, sourMap);
  collectCustomTags(clone, customTags);
  const idx = parent.children.findIndex((c) => c.tag === tag);
  if (choice === "both" || idx < 0) {
    insertOrdered(parent, clone, order);
  } else {
    parent.children[idx] = clone;
  }
  return true;
}

export function insertAt(parent: GedNode, index: number, child: GedNode): void {
  parent.children.splice(index, 0, child);
}

/** Where the event block ends in `INDI_CHILD_ORDER` — the first of the
 *  trailing pointer/attachment tags. */
const INDI_EVENT_RANK_END = INDI_CHILD_ORDER.indexOf("FAMC");

/** How `INDI_CHILD_ORDER` ranks a top-level tag; an unlisted tag ranks last. */
function indiTagRank(tag: string): number {
  const i = INDI_CHILD_ORDER.indexOf(tag);
  return i === -1 ? Infinity : i;
}

/**
 * Whether a record child is one of the chronological events (BIRT, BAPM,
 * RESI, …). A tag the GEDCOM spec defines (ASSO, CHAN, CREA, REFN, …) is never
 * treated as an event even if it happens to carry its own DATE child (a
 * validity period for ASSO, a record-audit timestamp for CHAN/CREA, …) — only
 * a vendor-extension tag (the spec requires those to start with "_", e.g. a
 * custom `_MILT` military-service fact) gets the "has a DATE child" fallback,
 * since that's the one case where an unlisted tag can still be a genuine
 * genealogical event.
 */
function isEventChild(node: GedNode): boolean {
  const rank = indiTagRank(node.tag);
  if (rank >= 2 && rank < INDI_EVENT_RANK_END) return true;
  return rank === Infinity && node.tag.startsWith("_") && hasChild(node, "DATE");
}

/**
 * The position-deciding sort key of each event, in the order given. Zone-aware,
 * the same ordering the Merge comparison and Edit views use (`orderedEventTags`
 * / `EventList`), so the saved file lists events in the exact order the user
 * saw — undated life-zone events land mid-lifespan rather than ahead of all
 * dated ones. The keys are computed for the group as a whole, since an undated
 * event's zone is read off the dated events around it.
 */
function eventSortKeys(events: readonly GedNode[]): number[] {
  const eventDate = (node: GedNode) => parseDate(firstChild(node, "DATE")?.value ?? "");
  const anchors = lifespanAnchors(events.map((node) => ({ tag: node.tag, date: eventDate(node) })));
  return events.map((node) => zoneSortKey(eventDate(node), node.tag, anchors));
}

/**
 * Sort the record's chronological event children by date, matching the order
 * the UI displays them; tag type is a tiebreaker for same-date events. Every
 * other child — NAME/SEX, FAMC/FAMS, NOTE/SOUR/OBJE, ASSO, and any other
 * non-event structure — is left at its exact original index, so a decision
 * touching one event never displaces unrelated nodes elsewhere in the record.
 */
export function sortEventsByDate(record: GedNode): void {
  const eventIndices: number[] = [];
  const events: GedNode[] = [];
  record.children.forEach((child, i) => {
    if (isEventChild(child)) {
      eventIndices.push(i);
      events.push(child);
    }
  });
  if (events.length < 2) return;

  const keys = eventSortKeys(events);
  const dateKey = new Map(events.map((node, i) => [node, keys[i]] as const));
  events.sort(
    (a, b) => (dateKey.get(a) ?? 0) - (dateKey.get(b) ?? 0) || indiTagRank(a.tag) - indiTagRank(b.tag),
  );
  eventIndices.forEach((idx, i) => {
    record.children[idx] = events[i];
  });
}

/**
 * What a record's events look like to {@link sortEventsByDate}: every event's
 * tag paired with the key that decides its position, in file order. Two
 * records with equal signatures sort identically, so comparing a person's
 * signature against their pre-edit snapshot answers whether the edit was
 * *structural* — one that added, removed, retagged or re-dated an event, and
 * so has a say in what order the events belong in — as opposed to a value fix
 * (a place completed, a note written, a source attached), which has no
 * business reordering anything. Rewriting a date in a different notation for
 * the same day is not structural either: the key, not the text, is compared.
 */
export function eventOrderSignature(record: GedNode): string {
  const events = record.children.filter(isEventChild);
  const keys = eventSortKeys(events);
  return events.map((node, i) => `${node.tag}@${keys[i]}`).join("|");
}

export function newNode(tag: string, value?: string, xref?: string): GedNode {
  const node: GedNode = { level: 0, tag, children: [] };
  if (value !== undefined) node.value = value;
  if (xref !== undefined) node.xref = xref;
  return node;
}

export { cloneNode };

/**
 * Walks a subtree just copied in from the incoming file and records any
 * non-standard tag found within it (the GEDCOM `_TAG` vendor-extension
 * convention — e.g. `_ITALIC`, `_PAREN`), so the save preview can offer to
 * drop it. `node` itself is never recorded, only its descendants, since the
 * caller always passes a known structural node (NAME, SOUR, DATE, …), never a
 * vendor extension.
 */
export function collectCustomTags(node: GedNode, registry: Record<string, CustomTagNode[]>): void {
  for (const child of node.children) {
    if (child.tag.startsWith("_")) {
      (registry[child.tag] ??= []).push({ parent: node, node: child });
    }
    collectCustomTags(child, registry);
  }
}

// ---------------------------------------------------------------------------
// Shared-record (SOUR / REPO / NOTE / OBJE) import helpers
// ---------------------------------------------------------------------------

/**
 * Top-level record types that other records reference by pointer and that can
 * therefore be carried across from the compare file: their pointers are
 * remapped via the xref map and the records themselves imported on demand.
 * (INDI/FAM pointers are handled structurally by the merge instead, and
 * anything else — see `stripForeignPointers` — has no import path.)
 */
const SHARED_RECORD_TAGS = new Set(["SOUR", "REPO", "NOTE", "OBJE"]);

/** Fresh-xref prefix per shared record type. */
const SHARED_XREF_PREFIX: Record<string, string> = { SOUR: "S", REPO: "R", NOTE: "N", OBJE: "O" };

/**
 * A content-identity key for a shared record, so a compare record describing
 * the same thing as an existing main one maps to the main's xref instead
 * of minting a duplicate. SOUR/REPO key on their descriptive fields
 * (`sourceContentKey`), a NOTE on its full text, an OBJE on the file/URL it
 * wraps. Undefined means "no identity-bearing content" — never match on it.
 */
function sharedContentKey(rec: GedNode): string | undefined {
  if (rec.tag === "SOUR" || rec.tag === "REPO") return sourceContentKey(rec) || undefined;
  if (rec.tag === "NOTE") return rec.value?.trim() || undefined;
  return childText(rec, "FILE"); // OBJE
}

/**
 * Map from a compare file's shared-record (SOUR/REPO/NOTE/OBJE) xref to the
 * xref it will carry in the merged output. Usually the same; only differs when
 * the compare xref collides with a main xref that points to a different
 * record.
 */
export type SourXrefMap = ReadonlyMap<string, string>;

/** The output xrefs a SourXrefMap has promised to compare shared records —
 *  cached per map, since applyRows asks once per record-level links row. */
const reservedXrefsCache = new WeakMap<SourXrefMap, Set<string>>();
export function reservedXrefs(sourMap: SourXrefMap): ReadonlySet<string> {
  let set = reservedXrefsCache.get(sourMap);
  if (!set) {
    set = new Set(sourMap.values());
    reservedXrefsCache.set(sourMap, set);
  }
  return set;
}

/**
 * Pre-compute the xref translation table for all compare shared records
 * (SOUR/REPO/NOTE/OBJE). A compare record describing the same content as an
 * existing main one (per `sharedContentKey`, regardless of xref) maps
 * straight to that main xref, so merging never mints a duplicate record for
 * content the main already has. Otherwise: records whose xref does not
 * exist in the main are mapped to themselves; xref collisions (with an
 * unrelated record) get a fresh xref of the same type (S…/R…/N…/O…) that
 * avoids all existing main xrefs. Without this, a pointer cloned from the
 * compare file could silently resolve to an unrelated main record that
 * happens to share the xref.
 */
export function buildSourXrefMap(compareRecords: GedNode[], mainRecords: GedNode[]): Map<string, string> {
  const map = new Map<string, string>();
  const used = new Set(mainRecords.filter((r) => r.xref).map((r) => r.xref as string));

  const mainByContent = new Map<string, string>();
  for (const rec of mainRecords) {
    if (!SHARED_RECORD_TAGS.has(rec.tag) || !rec.xref) continue;
    const key = sharedContentKey(rec);
    if (key && !mainByContent.has(`${rec.tag}:${key}`)) mainByContent.set(`${rec.tag}:${key}`, rec.xref);
  }

  for (const rec of compareRecords) {
    if (!SHARED_RECORD_TAGS.has(rec.tag) || !rec.xref) continue;
    const key = sharedContentKey(rec);
    const existing = key ? mainByContent.get(`${rec.tag}:${key}`) : undefined;
    if (existing) {
      map.set(rec.xref, existing);
      continue;
    }
    if (!used.has(rec.xref)) {
      map.set(rec.xref, rec.xref);
      used.add(rec.xref);
    } else {
      const prefix = SHARED_XREF_PREFIX[rec.tag];
      let n = 1;
      let fresh: string;
      do { fresh = `@${prefix}${n++}@`; } while (used.has(fresh));
      used.add(fresh);
      map.set(rec.xref, fresh);
    }
  }
  return map;
}

/** Deep-clone `n`, substituting any SOUR/REPO/NOTE/OBJE pointer values via `sourMap`. */
export function cloneNodeRemapped(n: GedNode, sourMap: SourXrefMap): GedNode {
  const c: GedNode = { level: n.level, tag: n.tag, children: n.children.map((ch) => cloneNodeRemapped(ch, sourMap)) };
  if (n.xref !== undefined) c.xref = n.xref;
  if (n.verbatim !== undefined) c.verbatim = n.verbatim;
  if (n.value !== undefined) {
    const isSharedPointer = SHARED_RECORD_TAGS.has(n.tag) && /^@[^@]+@$/.test(n.value);
    c.value = isSharedPointer ? (sourMap.get(n.value) ?? n.value) : n.value;
  }
  return c;
}

/**
 * Pointer-valued tags that must not travel with a node cloned wholesale from
 * the compare file: they reference individuals, families, or submitters in the
 * *compare* file's xref namespace, so in the main they would either dangle
 * or — worse — silently resolve to an unrelated record that happens to share
 * the xref. Family links (FAMC/FAMS, incl. the event-level FAMC under
 * ADOP/BIRT) are re-stitched structurally by the merge itself; associations
 * and submitter links have no import path and are dropped (reported as
 * deferred by the caller).
 */
const FOREIGN_POINTER_TAGS = new Set(["FAMC", "FAMS", "ASSO", "ALIA", "SUBM", "ANCI", "DESI"]);

/**
 * Remove every foreign-pointer node (see `FOREIGN_POINTER_TAGS`) from a
 * subtree about to be inserted into the main. Returns the tags removed, so
 * the caller can report dropped associations.
 */
export function stripForeignPointers(node: GedNode): string[] {
  const removed: string[] = [];
  const walk = (n: GedNode): void => {
    n.children = n.children.filter((c) => {
      if (FOREIGN_POINTER_TAGS.has(c.tag) && c.value && /^@[^@]+@$/.test(c.value.trim())) {
        removed.push(c.tag);
        return false;
      }
      return true;
    });
    for (const c of n.children) walk(c);
  };
  walk(node);
  return removed;
}

/**
 * After all merge decisions have been applied, scan the merged output for
 * shared-record (SOUR/REPO/NOTE/OBJE) xref pointers that don't yet have a
 * corresponding top-level record and import them from the compare file.
 * Handles transitive dependencies (a SOUR that references a REPO or OBJE that
 * also needs importing) by iterating to fixpoint. The `sourMap` ensures
 * imported records land under the correct output xref and that any pointers
 * inside them are also remapped.
 */
export function importSourRecords(
  records: GedNode[],
  compare: Dataset,
  sourMap: SourXrefMap,
  customTags: Record<string, CustomTagNode[]>,
): GedNode[] {
  const importedNodes: GedNode[] = [];
  // Reverse map: output xref → compare xref (only entries that were renamed).
  const reverseMap = new Map<string, string>();
  for (const [cXref, outXref] of sourMap) reverseMap.set(outXref, cXref);

  // Indexed lookup for compare shared records.
  const compareIndex = new Map<string, GedNode>();
  for (const rec of compare.records) {
    if (SHARED_RECORD_TAGS.has(rec.tag) && rec.xref) compareIndex.set(rec.xref, rec);
  }

  const collectSourRefs = (node: GedNode, out: Set<string>): void => {
    if (SHARED_RECORD_TAGS.has(node.tag) && node.value && /^@[^@]+@$/.test(node.value)) {
      out.add(node.value);
    }
    for (const child of node.children) collectSourRefs(child, out);
  };

  // Iterate to fixpoint: importing a SOUR may introduce a REPO reference.
  let changed = true;
  while (changed) {
    changed = false;
    const presentXrefs = new Set(records.filter((r) => r.xref).map((r) => r.xref as string));
    const needed = new Set<string>();
    for (const rec of records) collectSourRefs(rec, needed);
    for (const outXref of needed) {
      if (presentXrefs.has(outXref)) continue;
      const cXref = reverseMap.get(outXref) ?? outXref;
      const cRec = compareIndex.get(cXref);
      if (!cRec) continue;
      const imported = cloneNodeRemapped(cRec, sourMap);
      imported.xref = outXref;
      collectCustomTags(imported, customTags);
      insertRecord(records, imported);
      importedNodes.push(imported);
      changed = true;
    }
  }
  // The inserted SOUR/OBJE/REPO records stale any cached source lookup/index
  // a later pass over this same array would otherwise reuse.
  if (importedNodes.length) bumpSourceCacheVersion(records);
  return importedNodes;
}

/**
 * A compare source that content-matched an existing main record is never
 * imported — but the compare file may keep page images for the very pages the
 * merged citations now cite. For every cited page the main record cannot
 * already show, this links the compare file's page `OBJE` (xref remapped)
 * onto the main record; the follow-up `importSourRecords` then imports the
 * `OBJE` records those new links reference. Without this, citations arrive
 * with `PAGE n` while their page images are silently dropped.
 */
export function foldMatchedSourcePages(records: GedNode[], compare: Dataset, sourMap: SourXrefMap): void {
  // Source xref → the pages its citations in the merged output name.
  const citedPages = new Map<string, Set<string>>();
  const collect = (node: GedNode): void => {
    if (node.tag === "SOUR" && !node.xref && node.value && /^@[^@]+@$/.test(node.value.trim())) {
      const page = childText(node, "PAGE");
      if (page) {
        const key = node.value.trim();
        let pages = citedPages.get(key);
        if (!pages) citedPages.set(key, (pages = new Set()));
        pages.add(page);
      }
    }
    for (const child of node.children) collect(child);
  };
  for (const rec of records) collect(rec);
  if (!citedPages.size) return;

  const mainObje = buildObjeIndex(records);
  const compareObje = buildObjeIndex(compare.records);
  let changed = false;
  for (const [cXref, outXref] of sourMap) {
    const pages = citedPages.get(outXref);
    if (!pages?.size) continue;
    // Only a *pre-existing* main record needs the fold: a fresh-xref import
    // brings the whole compare record across, page links included.
    const mainRec = records.find((r) => r.tag === "SOUR" && r.xref === outXref);
    if (!mainRec) continue;
    const compareRec = compare.records.find((r) => r.tag === "SOUR" && r.xref === cXref);
    if (!compareRec) continue;
    const covered = mainRec.children
      .filter((c) => c.tag === "OBJE" && c.value)
      .map((c) => mainObje.get(c.value!.trim()))
      .filter((c): c is NonNullable<typeof c> => Boolean(c));
    const donors = childrenByTag(compareRec, "OBJE")
      .map((c) => ({ xref: c.value?.trim(), info: c.value ? compareObje.get(c.value.trim()) : undefined }))
      .filter((d): d is { xref: string; info: NonNullable<typeof d.info> } => Boolean(d.xref && d.info?.url));
    for (const page of pages) {
      if (covered.some((c) => matchesPage(c, page))) continue;
      const donor = donors.find((d) => matchesPage(d.info, page));
      if (!donor) continue;
      const outObje = sourMap.get(donor.xref) ?? donor.xref;
      if (mainRec.children.some((c) => c.tag === "OBJE" && c.value?.trim() === outObje)) continue;
      insertGrouped(mainRec, { level: mainRec.level + 1, tag: "OBJE", value: outObje, children: [] }, SOUR_TRAILING_TAGS);
      covered.push(donor.info);
      changed = true;
    }
  }
  if (changed) bumpSourceCacheVersion(records);
}

/**
 * Copy an incoming-only event's `SOUR` citations into `eventNode`, importing
 * whatever top-level `SOUR`/`REPO` records they reference (and those records'
 * own `REPO` references, transitively) from `compare` into `dataset.records`
 * under a non-colliding xref. Returns the newly-imported top-level records,
 * for the caller to build undo patches from.
 *
 * Used by Edit mode when a direct field edit (e.g. correcting a place)
 * materializes a main event from an incoming-only suggestion: once that
 * happens the event is excluded from all further merge-engine consideration
 * (see EditView's `rejectIncomingEvent`), so its sources must be brought
 * across right now via the same xref-import logic `mergeDecisions` uses, or
 * they're lost for good.
 */
export function materializeEventSources(
  dataset: Dataset,
  compare: Dataset,
  eventNode: GedNode,
  incomingEventNode: GedNode,
): GedNode[] {
  const incSours = childrenByTag(incomingEventNode, "SOUR");
  if (!incSours.length) return [];
  const sourMap = buildSourXrefMap(compare.records, dataset.records);
  for (const s of incSours) insertOrdered(eventNode, cloneNodeRemapped(s, sourMap), EVENT_CHILD_ORDER);
  const imported = importSourRecords(dataset.records, compare, sourMap, {});
  if (imported.length) bumpSourceCacheVersion(dataset.records);
  return imported;
}
