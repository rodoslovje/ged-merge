import { looksLikeUrl } from "../gedcom/builder";
import {
  addObjeToSource,
  attachSourceCitation,
  bumpSourceCacheVersion,
  EVENT_CHILD_ORDER,
  EVENT_LINK_TAG,
  INDI_CHILD_ORDER,
  insertOrdered,
  insertRecord,
  markEventTouched,
  NAME_CHILD_ORDER,
  nextXref,
} from "../gedcom/edit";
import { findExistingSource, newSourceCitations, sourceContentKey } from "../gedcom/source";
import type { Dataset, GedNode } from "../gedcom/types";
import { childrenByTag, childText, cloneNode, firstChild, hasChild, removeChildren } from "../gedcom/node";
import { parseDate } from "../gedcom/date";
import { linkKey } from "../normalize/links";
import { lifespanAnchors, zoneSortKey } from "../review/fields";
import { defaultChoice, type FieldChoice, type FieldRow } from "../review/types";
import type { ChangeReport, CustomTagNode, FieldChange } from "./merge";

type Row = FieldRow;

export interface EventSubEdit {
  sub: string;
  field: string;
  from: string;
  to: string;
  action: FieldChoice;
}

/** Map an event sub-field key suffix to its GEDCOM sub-tag. */
export const SUB_TAG: Record<string, string> = { type: "TYPE", date: "DATE", place: "PLAC", addr: "ADDR", note: "NOTE", agency: "AGNC", cause: "CAUS" };

/** Translation key for a bare sub-field label (event name shown separately as the group header). */
export const SUB_LABEL_KEY: Record<string, string> = {
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

/**
 * Combines an event's changed sub-fields (date/value/place/addr/note/agency) into
 * one preview line — e.g. "Occupation: + šivilja v pokoju · 1998" — instead of a
 * separate "Date:"/"Occupation:" line each, matching the single-line look already
 * used when a whole event is added or removed as a unit. Falls back to one row per
 * sub-field when they don't share the same action (the user picked "incoming" for
 * one and "both"/"master" for another), since a single from/to pair can't represent that.
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
): void {
  let nameApplied = false;
  // Map each event's row-key prefix (e.g. "BIRT", "BIRT.0") to its display
  // name, so date/place/note/source changes can be grouped under one header
  // in the save preview instead of repeating the event name on every line.
  const eventGroups = new Map<string, string>();
  // New master events created for an incoming-only event (eventMasterIdx -1),
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
    if (row.state === "agree" || row.state === "master-only") continue;
    // Handled elsewhere (family spouses/children go through applyFamilyStructure).
    if (handled.has(row.key) || row.key.startsWith("fam.")) continue;
    const choice = fields[row.key] ?? defaultChoice(row as never);
    if (choice === "master") continue;

    if (row.key === "links") {
      // The record-level "Sources" row carries both SOUR citations and plain
      // link icons (same shape as an event's sources row), so apply each.
      if (applyRecordSources(target, incomingRecord, choice, INDI_CHILD_ORDER, sourMap, report.customTags)) {
        report.changes.push({ recordId, field: row.label, from: "", to: "", action: choice, unedited: choice === "incoming", sources: newSourceCitations(row.masterSources, row.incomingSources) });
        touched.add(recordId);
      }
      const added = applyLinks(target, row.incomingLinkIcons ?? [], row.masterLinkIcons ?? [], linkFormat, records);
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
      if (nameApplied) continue; // the whole NAME line is taken as a unit
      applied = applyName(target, incomingRecord, choice, sourMap, report.customTags);
      nameApplied = applied;
    } else if (row.key === "sex") {
      applied = setChild(target, "SEX", incomingRecord, choice, INDI_CHILD_ORDER, sourMap, undefined, report.customTags);
    } else if (row.key === "nickname") {
      applied = applyNickname(target, incomingRecord, choice, sourMap, report.customTags);
    } else if (row.key === "additionalNames") {
      applied = applyAdditionalNames(target, incomingRecord, choice, sourMap, report.customTags);
    } else if (row.key === "notes") {
      applied = applyNotes(target, incomingRecord, choice, sourMap, INDI_CHILD_ORDER, report.customTags);
    } else {
      const parts = row.key.split(".");
      const [tag, sub] = parts.length === 3 && /^\d+$/.test(parts[1])
        ? [parts[0], parts[2]]
        : [parts[0], parts[1]];
      // The row's own true per-side array positions, not a position parsed
      // back out of `key` — that numeric suffix is an output-order index from
      // date/place pairing, not necessarily either side's real array index
      // once a tag has more than one instance (see `FieldRow.eventMasterIdx`).
      const masterIdx = row.eventMasterIdx ?? 0;
      const compareIdx = row.eventCompareIdx ?? 0;
      if (sub === "value") {
        applied = applyEventValue(target, incomingRecord, tag, choice, masterIdx, compareIdx, INDI_CHILD_ORDER, newEventNodes);
      } else if (sub === "sources") {
        applied = applyEventSources(target, incomingRecord, tag, choice, masterIdx, compareIdx, INDI_CHILD_ORDER, sourMap, records, report.customTags, newEventNodes);
      } else {
        const subTag = SUB_TAG[sub];
        // Places are already reshaped into the master's layout when the
        // incoming file was loaded, so the raw incoming node can be copied
        // directly like any other field.
        if (subTag) applied = applyEventSub(target, incomingRecord, tag, subTag, choice, masterIdx, compareIdx, INDI_CHILD_ORDER, sourMap, report.customTags, newEventNodes);
      }
    }

    if (applied) {
      const subMatch = row.key.match(/\.(type|date|place|addr|note|agency|cause|sources|value)$/);
      const eventKey = subMatch ? row.key.slice(0, -subMatch[0].length) : undefined;
      const group = eventKey ? eventGroups.get(eventKey) : undefined;
      const sub = subMatch?.[1];
      if (eventKey && group && sub && sub !== "sources") {
        let entries = eventEdits.get(eventKey);
        if (!entries) { entries = []; eventEdits.set(eventKey, entries); }
        entries.push({ sub, field: row.label, from: row.master, to: row.incoming, action: choice });
      } else if (sub === "sources") {
        // Render added citations as the same 📖/🔗 icons the main UI uses,
        // inline on the event's line — not as a separate "Source: …" text row.
        report.changes.push({ recordId, field: row.label, from: "", to: "", action: choice, group, unedited: choice === "incoming", sources: newSourceCitations(row.masterSources, row.incomingSources) });
      } else {
        report.changes.push({ recordId, field: row.label, from: row.master, to: row.incoming, action: choice, group, unedited: choice === "incoming" });
      }
      touched.add(recordId);
    }
  }
  for (const [eventKey, entries] of eventEdits) {
    report.changes.push(...combineEventEdits(recordId, eventGroups.get(eventKey)!, entries));
  }
}

/**
 * How the master file stores a record-level link.
 *  - "WWW": a plain `WWW <url>` line (RootsMagic, Ancestry, Synium, …).
 *  - "WEBTAG": Family Historian's `_WEBTAG` block, with the URL on a `URL`
 *    sub-line (`1 _WEBTAG` / `2 URL <url>`).
 *  - "OBJE": a shared multimedia record holding the URL in `FILE`
 *    (`0 @On@ OBJE` / `1 FILE <url>`), referenced via `1 OBJE @On@`.
 */
export type LinkFormat = "WWW" | "WEBTAG" | "OBJE";

/**
 * Append a link node for each incoming link the master doesn't already have
 * (by `linkKey`), shaped to match the master's own link format. Returns the
 * URLs actually added.
 *
 * Before minting a plain link, checks whether the URL belongs to a paginated
 * archive book (Matricula, parish registers, …) the master already cites as
 * a `SOUR` — same matching `findExistingSource` does for the manual "Add
 * Source" dialog. If so, the incoming link is attached as a `SOUR` citation
 * to that book (reusing its existing `OBJE` page, or adding a new one) so it
 * shows with the book icon and joins that book's page collection, instead of
 * becoming a disconnected generic link.
 */
export function applyLinks(
  target: GedNode,
  incomingLinks: string[],
  masterLinks: string[],
  linkFormat: LinkFormat,
  records: GedNode[],
): string[] {
  const existing = new Set(masterLinks.map(linkKey));
  const added: string[] = [];
  for (const url of incomingLinks) {
    const key = linkKey(url);
    if (existing.has(key)) continue;
    existing.add(key);
    const sourceMatch = findExistingSource(records, url);
    if (sourceMatch) {
      if (!sourceMatch.objeXref) addObjeToSource(records, sourceMatch.sourceXref, url);
      attachSourceCitation(target, sourceMatch.sourceXref, sourceMatch.page, INDI_CHILD_ORDER);
    } else {
      insertOrdered(target, buildLinkNode(linkFormat, url, records), INDI_CHILD_ORDER);
    }
    added.push(url);
  }
  return added;
}

/**
 * Build a new link node for `url`, shaped per `format`. For "OBJE", also
 * appends a new top-level `OBJE` record holding the URL in `FILE` and returns
 * a pointer to it.
 */
function buildLinkNode(format: LinkFormat, url: string, records: GedNode[]): GedNode {
  if (format === "WEBTAG") {
    const webtag = newNode("_WEBTAG");
    webtag.children.push(newNode("URL", url));
    return webtag;
  }
  if (format === "OBJE") {
    const xref = nextXref(records, "O");
    const obje = newNode("OBJE", undefined, xref);
    obje.children.push(newNode("FILE", url));
    // Insert before TRLR (which must stay last) rather than appending.
    const trlrIndex = records.findIndex((r) => r.tag === "TRLR");
    if (trlrIndex === -1) records.push(obje);
    else records.splice(trlrIndex, 0, obje);
    return newNode("OBJE", xref);
  }
  return newNode("WWW", url);
}

/**
 * Which `LinkFormat` the master file uses for its own record-level links, so
 * newly added links are written the same way. Counts `WWW` lines, `_WEBTAG`
 * blocks, and `OBJE` pointers to a media record whose `FILE` is a URL, across
 * all individuals and families (including their events), and picks whichever
 * the master already uses most; defaults to plain `WWW` lines when the master
 * has none of these (or is ambiguous).
 */
export function detectLinkFormat(master: Dataset): LinkFormat {
  const objeFiles = new Map<string, string>();
  for (const rec of master.records) {
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
  for (const indi of master.individuals.values()) visit(indi.raw);
  for (const fam of master.families.values()) visit(fam.raw);

  const max = Math.max(www, webtag, obje);
  if (max === 0) return "WWW";
  if (obje === max) return "OBJE";
  if (webtag === max) return "WEBTAG";
  return "WWW";
}

/** Replace or (for "both") add the primary NAME line from the incoming record. */
export function applyName(
  target: GedNode,
  incomingRecord: GedNode,
  choice: FieldChoice,
  sourMap: SourXrefMap,
  customTags: Record<string, CustomTagNode[]>,
): boolean {
  const incName = firstChild(incomingRecord, "NAME");
  if (!incName) return false;
  const clone = cloneNodeRemapped(incName, sourMap);
  collectCustomTags(clone, customTags);
  const idx = target.children.findIndex((c) => c.tag === "NAME");
  if (choice === "both" || idx < 0) {
    if (idx < 0) insertOrdered(target, clone, INDI_CHILD_ORDER);
    else insertAt(target, idx + 1, clone);
  } else {
    target.children[idx] = clone;
  }
  return true;
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
 * Find the master event a row should write to: `masterEvents[masterIdx]`
 * when the row has a real master-side event, otherwise the new node created
 * for this incoming-only event's `(tag, compareIdx)` — reusing it across that
 * one event's sub-fields via `newEventNodes` instead of minting a separate
 * node per field.
 */
function resolveEventNode(
  target: GedNode,
  tag: string,
  masterIdx: number,
  compareIdx: number,
  order: string[],
  newEventNodes?: Map<string, GedNode>,
): GedNode {
  if (masterIdx >= 0) {
    const existing = childrenByTag(target, tag)[masterIdx];
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

/** Copy the direct value on an event line (e.g. occupation text) from incoming to master. */
export function applyEventValue(
  target: GedNode,
  incomingRecord: GedNode,
  tag: string,
  choice: FieldChoice,
  masterIdx: number,
  compareIdx: number,
  order: string[] = [],
  newEventNodes?: Map<string, GedNode>,
): boolean {
  const incEvent = compareIdx >= 0 ? childrenByTag(incomingRecord, tag)[compareIdx] : undefined;
  if (!incEvent?.value) return false;
  if (choice === "incoming" || choice === "both") {
    const event = resolveEventNode(target, tag, masterIdx, compareIdx, order, newEventNodes);
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
  masterIdx: number,
  compareIdx: number,
  order: string[],
  sourMap: SourXrefMap,
  customTags: Record<string, CustomTagNode[]> = {},
  newEventNodes?: Map<string, GedNode>,
): boolean {
  const incEvent = compareIdx >= 0 ? childrenByTag(incomingRecord, tag)[compareIdx] : undefined;
  const incSub = incEvent ? firstChild(incEvent, subTag) : undefined;
  if (!incSub) return false;
  const event = resolveEventNode(target, tag, masterIdx, compareIdx, order, newEventNodes);
  return setChild(event, subTag, incEvent!, choice, EVENT_CHILD_ORDER, sourMap, incSub, customTags);
}

/**
 * Apply an INDI/FAM record's own (record-level) `SOUR` citations from the
 * incoming record — its direct `SOUR` children, not those nested under an
 * event. "incoming" replaces the master's record-level citations; "both"
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

/** Tags an event's own attached link can use (besides a `SOUR` citation). */
const EVENT_LINK_TAGS = new Set(["WWW", "URL", "_URL", "_LINK", "_WEBTAG"]);

/** An event's own plain links — everything `linksNotCitedAsSource` (review/fields.ts) excludes is already a `SOUR` citation, so this mirrors that by simply reading the raw tags. */
function eventLinkUrls(event: GedNode | undefined): string[] {
  if (!event) return [];
  return event.children.filter((c) => EVENT_LINK_TAGS.has(c.tag) && c.value?.trim()).map((c) => c.value!.trim());
}

/**
 * Copy an event's `SOUR` citations and plain attached links (`WWW`/`_LINK`/…,
 * shown alongside the citations in review) from incoming to master: "incoming"
 * replaces the master's, "both" appends the incoming ones alongside them.
 * Citation values that point at a compare-file `SOUR`/`REPO` record are
 * remapped to that record's id in the merged output.
 */
export function applyEventSources(
  target: GedNode,
  incomingRecord: GedNode,
  tag: string,
  choice: FieldChoice,
  masterIdx: number,
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
  const event = resolveEventNode(target, tag, masterIdx, compareIdx, order, newEventNodes);
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
      // A link into a paginated archive book the master already cites as a
      // SOUR is attached as a citation instead of becoming a disconnected link.
      const sourceMatch = findExistingSource(records, url);
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

/**
 * Sort the record's chronological event children (BIRT, BAPM, RESI, …) by
 * date, matching the order the UI displays them; tag type is a tiebreaker for
 * same-date events. Every other child — NAME/SEX, FAMC/FAMS, NOTE/SOUR/OBJE,
 * ASSO, and any other non-event structure — is left at its exact original
 * index, so a decision touching one event never displaces unrelated nodes
 * elsewhere in the record. A tag the GEDCOM spec defines (ASSO, CHAN, CREA,
 * REFN, …) is never treated as an event even if it happens to carry its own
 * DATE child (a validity period for ASSO, a record-audit timestamp for
 * CHAN/CREA, …) — only a vendor-extension tag (the spec requires those to
 * start with "_", e.g. a custom `_MILT` military-service fact) gets the
 * "has a DATE child" fallback, since that's the one case where an unlisted
 * tag can still be a genuine genealogical event.
 */
export function sortEventsByDate(record: GedNode): void {
  const suffixStart = INDI_CHILD_ORDER.indexOf("FAMC");
  const tagRank = (tag: string) => {
    const i = INDI_CHILD_ORDER.indexOf(tag);
    return i === -1 ? Infinity : i;
  };
  const isEvent = (node: GedNode) => {
    const r = tagRank(node.tag);
    if (r >= 2 && r < suffixStart) return true;
    return r === Infinity && node.tag.startsWith("_") && hasChild(node, "DATE");
  };

  const eventIndices: number[] = [];
  const events: GedNode[] = [];
  record.children.forEach((child, i) => {
    if (isEvent(child)) {
      eventIndices.push(i);
      events.push(child);
    }
  });
  if (events.length < 2) return;

  const eventDate = (node: GedNode) => parseDate(firstChild(node, "DATE")?.value ?? "");
  // Same zone-aware ordering as the Merge comparison and Edit views
  // (`orderedEventTags` / `EventList`), so the saved file lists events in the
  // exact order the user saw — undated life-zone events land mid-lifespan
  // rather than ahead of all dated ones.
  const anchors = lifespanAnchors(events.map((node) => ({ tag: node.tag, date: eventDate(node) })));
  const dateKey = (node: GedNode): number => zoneSortKey(eventDate(node), node.tag, anchors);

  events.sort((a, b) => dateKey(a) - dateKey(b) || tagRank(a.tag) - tagRank(b.tag));
  eventIndices.forEach((idx, i) => {
    record.children[idx] = events[i];
  });
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
 * the same thing as an existing master one maps to the master's xref instead
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
 * the compare xref collides with a master xref that points to a different
 * record.
 */
export type SourXrefMap = ReadonlyMap<string, string>;

/**
 * Pre-compute the xref translation table for all compare shared records
 * (SOUR/REPO/NOTE/OBJE). A compare record describing the same content as an
 * existing master one (per `sharedContentKey`, regardless of xref) maps
 * straight to that master xref, so merging never mints a duplicate record for
 * content the master already has. Otherwise: records whose xref does not
 * exist in the master are mapped to themselves; xref collisions (with an
 * unrelated record) get a fresh xref of the same type (S…/R…/N…/O…) that
 * avoids all existing master xrefs. Without this, a pointer cloned from the
 * compare file could silently resolve to an unrelated master record that
 * happens to share the xref.
 */
export function buildSourXrefMap(compareRecords: GedNode[], masterRecords: GedNode[]): Map<string, string> {
  const map = new Map<string, string>();
  const used = new Set(masterRecords.filter((r) => r.xref).map((r) => r.xref as string));

  const masterByContent = new Map<string, string>();
  for (const rec of masterRecords) {
    if (!SHARED_RECORD_TAGS.has(rec.tag) || !rec.xref) continue;
    const key = sharedContentKey(rec);
    if (key && !masterByContent.has(`${rec.tag}:${key}`)) masterByContent.set(`${rec.tag}:${key}`, rec.xref);
  }

  for (const rec of compareRecords) {
    if (!SHARED_RECORD_TAGS.has(rec.tag) || !rec.xref) continue;
    const key = sharedContentKey(rec);
    const existing = key ? masterByContent.get(`${rec.tag}:${key}`) : undefined;
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
  if (n.value !== undefined) {
    const isSharedPointer = SHARED_RECORD_TAGS.has(n.tag) && /^@[^@]+@$/.test(n.value);
    c.value = isSharedPointer ? (sourMap.get(n.value) ?? n.value) : n.value;
  }
  return c;
}

/**
 * Pointer-valued tags that must not travel with a node cloned wholesale from
 * the compare file: they reference individuals, families, or submitters in the
 * *compare* file's xref namespace, so in the master they would either dangle
 * or — worse — silently resolve to an unrelated record that happens to share
 * the xref. Family links (FAMC/FAMS, incl. the event-level FAMC under
 * ADOP/BIRT) are re-stitched structurally by the merge itself; associations
 * and submitter links have no import path and are dropped (reported as
 * deferred by the caller).
 */
const FOREIGN_POINTER_TAGS = new Set(["FAMC", "FAMS", "ASSO", "ALIA", "SUBM", "ANCI", "DESI"]);

/**
 * Remove every foreign-pointer node (see `FOREIGN_POINTER_TAGS`) from a
 * subtree about to be inserted into the master. Returns the tags removed, so
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
  return importedNodes;
}

/**
 * Copy an incoming-only event's `SOUR` citations into `eventNode`, importing
 * whatever top-level `SOUR`/`REPO` records they reference (and those records'
 * own `REPO` references, transitively) from `compare` into `dataset.records`
 * under a non-colliding xref. Returns the newly-imported top-level records,
 * for the caller to build undo patches from.
 *
 * Used by Edit mode when a direct field edit (e.g. correcting a place)
 * materializes a master event from an incoming-only suggestion: once that
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
