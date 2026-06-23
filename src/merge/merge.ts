import { looksLikeUrl } from "../gedcom/builder";
import {
  addObjeToSource,
  attachSourceCitation,
  bumpSourceCacheVersion,
  EVENT_CHILD_ORDER,
  EVENT_LINK_TAG,
  FAM_CHILD_ORDER,
  INDI_CHILD_ORDER,
  insertOrdered,
  insertRecord,
  NAME_CHILD_ORDER,
  nextXref,
} from "../gedcom/edit";
import { findExistingSource, sourceContentKey } from "../gedcom/source";
import type { Dataset, GedNode } from "../gedcom/types";
import { parseDate } from "../gedcom/date";
import type { MatchResult } from "../match/types";
import { displayName } from "../match/relatives";
import { inferPlaceExportFormat } from "../normalize/profile";
import { linkKey } from "../normalize/links";
import { clampBeforeDeathZone, dateToSortKey, individualFieldRows, minDeathZoneKey } from "../review/fields";
import { defaultChoice, decisionKey, type CandidateDecision, type FieldChoice } from "../review/types";

/** A translator (i18next `t`); only used for human-readable field labels. */
type Translate = (key: string, opts?: Record<string, unknown>) => string;

/** One field the merge wrote into a master record. */
export interface FieldChange {
  recordId: string;
  field: string;
  from: string;
  to: string;
  action: FieldChoice;
  /** Marks the placeholder change for a freshly added person/family record. */
  newRecord?: boolean;
  /** Marks the placeholder change for a deleted person/family record. */
  removedRecord?: boolean;
  /** Event name (e.g. "Birth", "Marriage") this field belongs to, so the
   *  preview can show it once as a header above its date/place/note/source. */
  group?: string;
  /** Set when an existing event was modified (not newly added/removed) — the preview
   *  renders these pieces in place of `from`/`to`, coloring each by whether the edit
   *  actually touched it, instead of treating the whole line as one new value. */
  segments?: { text: string; state: "same" | "changed" | "removed" }[];
  /** True when `to` is a verbatim, un-chosen copy of the incoming file's value (the
   *  user took "incoming" by default, didn't combine it with master or type it by
   *  hand) — the preview colors these like other incoming-sourced data rather than
   *  as an edit. Only meaningful for merge-produced changes. */
  unedited?: boolean;
}

/** A confirmed change the engine did not yet apply (relationship/links). */
export interface DeferredChange {
  recordId: string;
  field: string;
  reason: string;
}

/** A spouse shown on a family's preview card (husband first, then wife). */
export interface FamilySpouseInfo {
  /** Individual xref, when resolvable (lets the UI look up sex/lifespan). */
  id?: string;
  name: string;
}

/**
 * A non-standard (vendor `_TAG`) node copied in from the incoming file as part
 * of a merge, kept live (with its parent) inside the merged tree so the save
 * preview can strip it — per tag name — if the user opts out.
 */
export interface CustomTagNode {
  parent: GedNode;
  node: GedNode;
}

export interface ChangeReport {
  changes: FieldChange[];
  deferred: DeferredChange[];
  /** Distinct master records touched. */
  recordsChanged: number;
  /** New individual records added from the incoming file. */
  newPersons: number;
  /** New family records created to stitch merged relationships together. */
  newFamilies: number;
  /** Display label per touched record id, for grouping the preview/report. */
  recordLabels: Record<string, string>;
  /** Whether each touched record is an individual or a family. */
  recordKinds: Record<string, "individual" | "family">;
  /** Husband/wife (in that order) for each touched family record. */
  familySpouses: Record<string, FamilySpouseInfo[]>;
  /** Non-standard tags copied in from the incoming file, grouped by tag name,
   *  for the save preview's "exclude this tag" list. */
  customTags: Record<string, CustomTagNode[]>;
}

export interface MergeResult {
  /** A clone of the master record forest with confirmed edits applied. */
  records: GedNode[];
  report: ChangeReport;
}

/**
 * Relationship and family-event fields handled structurally (parents/partners by
 * `applyIndividualRelations`, marriage/children by `applyIndividualFamilies`) —
 * so `applyRows` skips them rather than treating them as scalar individual fields.
 */
const INDI_HANDLED = new Set([
  "father",
  "mother",
]);

/** Map an event sub-field key suffix to its GEDCOM sub-tag. */
const SUB_TAG: Record<string, string> = { date: "DATE", place: "PLAC", addr: "ADDR", note: "NOTE", agency: "AGNC" };

/** Translation key for a bare sub-field label (event name shown separately as the group header). */
const SUB_LABEL_KEY: Record<string, string> = {
  date: "event.colDate",
  place: "event.colPlace",
  addr: "event.colAddr",
  note: "event.colNote",
  agency: "event.colAgency",
};

/** Order in which an event's changed sub-fields are joined into one preview line. */
const SUB_JOIN_ORDER = ["value", "date", "place", "addr", "note", "agency"];

interface EventSubEdit {
  sub: string;
  field: string;
  from: string;
  to: string;
  action: FieldChoice;
}

/**
 * Combines an event's changed sub-fields (date/value/place/addr/note/agency) into
 * one preview line — e.g. "Occupation: + šivilja v pokoju · 1998" — instead of a
 * separate "Date:"/"Occupation:" line each, matching the single-line look already
 * used when a whole event is added or removed as a unit. Falls back to one row per
 * sub-field when they don't share the same action (the user picked "incoming" for
 * one and "both"/"master" for another), since a single from/to pair can't represent that.
 */
function combineEventEdits(recordId: string, group: string, entries: EventSubEdit[]): FieldChange[] {
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
 * Apply confirmed match decisions to a clone of the master tree, taking each
 * field the user chose from the incoming side (or "both"). Untouched records are
 * left as identical clones, so serializing the result yields a minimal diff
 * against the original master.
 *
 * Individuals: scalar fields (sex, primary name, event date/place/address).
 * Families: marriage fields plus structural stitching — missing spouses and
 * children from the incoming family are linked to their matched master person
 * (via `matches`) or, when genuinely new, added as fresh records with the right
 * FAMC/FAMS/HUSB/WIFE/CHIL pointers.
 *
 * Individual relationship fields and links are still recorded as deferred.
 */
export function mergeDecisions(
  master: Dataset,
  compare: Dataset,
  decisions: Map<string, CandidateDecision>,
  matches: MatchResult,
  t: Translate,
): MergeResult {
  const records = master.records.map(cloneNode);
  const sourXrefMap = buildSourXrefMap(compare.records, records);
  const indiNodes = new Map<string, GedNode>();
  const famNodes = new Map<string, GedNode>();
  for (const r of records) {
    if (!r.xref) continue;
    if (r.tag === "INDI") indiNodes.set(r.xref, r);
    else if (r.tag === "FAM") famNodes.set(r.xref, r);
  }

  const report: ChangeReport = {
    changes: [],
    deferred: [],
    recordsChanged: 0,
    newPersons: 0,
    newFamilies: 0,
    recordLabels: {},
    recordKinds: {},
    familySpouses: {},
    customTags: {},
  };
  const touched = new Set<string>();
  // How the master writes places, so incoming places can be reshaped to match.
  const placeFmt = inferPlaceExportFormat(master);
  // How the master stores record-level links, so newly added links match (e.g.
  // a plain WWW line, Family Historian's _WEBTAG block, or an OBJE/FILE record).
  const linkFormat = detectLinkFormat(master);
  const ctx = makeContext(master, compare, matches, records, indiNodes, famNodes, report, touched, t, sourXrefMap);

  for (const [key, decision] of decisions) {
    if (decision.status !== "confirmed") continue;
    const { kind, masterId, compareId } = parseKey(key);
    if (kind !== "individual") continue; // families are merged via their spouses

    const target = indiNodes.get(masterId);
    const masterIndi = master.individuals.get(masterId);
    const incoming = compare.individuals.get(compareId);
    if (!target || !masterIndi || !incoming) continue;
    report.recordLabels[masterId] = displayName(masterIndi.names[0]);
    const rejectedEvents = decision.rejectedEvents?.length ? new Set(decision.rejectedEvents) : undefined;
    const rows = individualFieldRows(t, masterIndi, incoming, master, compare, placeFmt, rejectedEvents);
    applyRows(target, incoming.raw, masterId, rows, decision.fields, report, touched, INDI_HANDLED, t, linkFormat, records, sourXrefMap);
    applyIndividualRelations(masterId, masterIndi, incoming, rows, decision.fields, master, compare, ctx);
    applyIndividualFamilies(masterId, masterIndi, incoming, rows, decision.fields, master, compare, ctx);
    sortEventsByDate(target);
  }

  // Derive record kinds from node maps built during merge.
  for (const c of report.changes) {
    if (report.recordKinds[c.recordId]) continue;
    if (indiNodes.has(c.recordId)) report.recordKinds[c.recordId] = "individual";
    else if (famNodes.has(c.recordId)) report.recordKinds[c.recordId] = "family";
  }

  // Label each touched family by its husband/wife (pre-existing or newly
  // stitched in), husband first then wife, for the save-preview family card.
  for (const [id, kind] of Object.entries(report.recordKinds)) {
    if (kind !== "family") continue;
    const famNode = famNodes.get(id);
    if (!famNode) continue;
    const entries: FamilySpouseInfo[] = [];
    for (const role of ["HUSB", "WIFE"] as const) {
      const spouseId = famNode.children.find((c) => c.tag === role)?.value;
      if (spouseId) entries.push({ id: spouseId, name: ctx.label(spouseId) });
    }
    if (entries.length) {
      report.recordLabels[id] = entries.map((e) => e.name).join(" + ");
      report.familySpouses[id] = entries;
    }
  }

  // Import any SOUR/REPO records from compare that are now referenced in the
  // merged output but absent from it (e.g. citations on newly-added people).
  importSourRecords(records, compare, sourXrefMap, report.customTags);

  report.recordsChanged = touched.size;
  return { records, report };
}

interface Row {
  key: string;
  label: string;
  master: string;
  incoming: string;
  state: string;
  masterLinks?: string[];
  incomingLinks?: string[];
  isEventHeader?: boolean;
  /** True per-tag-array index of this event row's underlying event on each
   * side (-1 if absent) — see `FieldRow.eventMasterIdx`/`eventCompareIdx`. */
  eventMasterIdx?: number;
  eventCompareIdx?: number;
}

function applyRows(
  target: GedNode,
  incomingRecord: GedNode,
  recordId: string,
  rows: Row[],
  fields: Record<string, FieldChoice>,
  report: ChangeReport,
  touched: Set<string>,
  handled: Set<string>,
  t: Translate,
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
      const added = applyLinks(target, row.incomingLinks ?? [], row.masterLinks ?? [], linkFormat, records);
      if (added.length) {
        report.changes.push({ recordId, field: row.label, from: row.master, to: added.join("\n"), action: choice, unedited: choice === "incoming" });
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
      applied = setChild(target, "SEX", incomingRecord, choice, INDI_CHILD_ORDER, undefined, report.customTags);
    } else if (row.key === "nickname") {
      applied = applyNickname(target, incomingRecord, choice, report.customTags);
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
        applied = applyEventSources(target, incomingRecord, tag, choice, masterIdx, compareIdx, INDI_CHILD_ORDER, sourMap, report.customTags, newEventNodes);
      } else {
        const subTag = SUB_TAG[sub];
        // Places are already reshaped into the master's layout when the
        // incoming file was loaded, so the raw incoming node can be copied
        // directly like any other field.
        if (subTag) applied = applyEventSub(target, incomingRecord, tag, subTag, choice, masterIdx, compareIdx, INDI_CHILD_ORDER, report.customTags, newEventNodes);
      }
    }

    if (applied) {
      const subMatch = row.key.match(/\.(date|place|addr|note|agency|sources|value)$/);
      const eventKey = subMatch ? row.key.slice(0, -subMatch[0].length) : undefined;
      const group = eventKey ? eventGroups.get(eventKey) : undefined;
      const sub = subMatch?.[1];
      if (eventKey && group && sub && sub !== "sources") {
        let entries = eventEdits.get(eventKey);
        if (!entries) { entries = []; eventEdits.set(eventKey, entries); }
        entries.push({ sub, field: row.label, from: row.master, to: row.incoming, action: choice });
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
function applyLinks(
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
function detectLinkFormat(master: Dataset): LinkFormat {
  const objeFiles = new Map<string, string>();
  for (const rec of master.records) {
    if (rec.tag !== "OBJE" || !rec.xref) continue;
    const file = rec.children.find((c) => c.tag === "FILE")?.value?.trim();
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
function applyName(
  target: GedNode,
  incomingRecord: GedNode,
  choice: FieldChoice,
  sourMap: SourXrefMap,
  customTags: Record<string, CustomTagNode[]>,
): boolean {
  const incName = incomingRecord.children.find((c) => c.tag === "NAME");
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
function applyNotes(
  target: GedNode,
  incoming: GedNode,
  choice: FieldChoice,
  sourMap: SourXrefMap,
  order: string[],
  customTags: Record<string, CustomTagNode[]>,
): boolean {
  const incNotes = incoming.children.filter((c) => c.tag === "NOTE");
  if (!incNotes.length) return false;
  if (choice !== "both") target.children = target.children.filter((c) => c.tag !== "NOTE");
  for (const n of incNotes) {
    const clone = cloneNodeRemapped(n, sourMap);
    collectCustomTags(clone, customTags);
    insertOrdered(target, clone, order);
  }
  return true;
}

/** Set the NICK sub-node on the primary NAME record from the incoming side. */
function applyNickname(
  target: GedNode,
  incomingRecord: GedNode,
  choice: FieldChoice,
  customTags: Record<string, CustomTagNode[]>,
): boolean {
  const incName = incomingRecord.children.find((c) => c.tag === "NAME");
  if (!incName) return false;
  const incNick = incName.children.find((c) => c.tag === "NICK");
  if (!incNick) return false;
  let name = target.children.find((c) => c.tag === "NAME");
  if (!name) {
    name = newNode("NAME");
    insertAt(target, 0, name);
  }
  return setChild(name, "NICK", incName, choice, NAME_CHILD_ORDER, incNick, customTags);
}

/** Copy the incoming record's additional NAME nodes (everything after the first). */
function applyAdditionalNames(
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
    const existing = target.children.filter((c) => c.tag === tag)[masterIdx];
    if (existing) return existing;
  }
  const cacheKey = `${tag}:${compareIdx}`;
  const cached = newEventNodes?.get(cacheKey);
  if (cached) return cached;
  const created = newNode(tag);
  insertOrdered(target, created, order);
  newEventNodes?.set(cacheKey, created);
  return created;
}

/** Copy the direct value on an event line (e.g. occupation text) from incoming to master. */
function applyEventValue(
  target: GedNode,
  incomingRecord: GedNode,
  tag: string,
  choice: FieldChoice,
  masterIdx: number,
  compareIdx: number,
  order: string[] = [],
  newEventNodes?: Map<string, GedNode>,
): boolean {
  const incEvent = compareIdx >= 0 ? incomingRecord.children.filter((c) => c.tag === tag)[compareIdx] : undefined;
  if (!incEvent?.value) return false;
  if (choice === "incoming" || choice === "both") {
    const event = resolveEventNode(target, tag, masterIdx, compareIdx, order, newEventNodes);
    event.value = incEvent.value;
    return true;
  }
  return false;
}

/** Apply an event's date/place/address by copying the incoming sub-node. */
function applyEventSub(
  target: GedNode,
  incomingRecord: GedNode,
  tag: string,
  subTag: string,
  choice: FieldChoice,
  masterIdx: number,
  compareIdx: number,
  order: string[] = [],
  customTags: Record<string, CustomTagNode[]> = {},
  newEventNodes?: Map<string, GedNode>,
): boolean {
  const incEvent = compareIdx >= 0 ? incomingRecord.children.filter((c) => c.tag === tag)[compareIdx] : undefined;
  const incSub = incEvent?.children.find((c) => c.tag === subTag);
  if (!incSub) return false;
  const event = resolveEventNode(target, tag, masterIdx, compareIdx, order, newEventNodes);
  return setChild(event, subTag, incEvent!, choice, EVENT_CHILD_ORDER, incSub, customTags);
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
function applyEventSources(
  target: GedNode,
  incomingRecord: GedNode,
  tag: string,
  choice: FieldChoice,
  masterIdx: number,
  compareIdx: number,
  order: string[],
  sourMap: SourXrefMap,
  customTags: Record<string, CustomTagNode[]> = {},
  newEventNodes?: Map<string, GedNode>,
): boolean {
  const incEvent = compareIdx >= 0 ? incomingRecord.children.filter((c) => c.tag === tag)[compareIdx] : undefined;
  const incSours = incEvent?.children.filter((c) => c.tag === "SOUR") ?? [];
  const incLinks = eventLinkUrls(incEvent);
  if (incSours.length === 0 && incLinks.length === 0) return false;
  const event = resolveEventNode(target, tag, masterIdx, compareIdx, order, newEventNodes);
  if (incSours.length) {
    if (choice !== "both") event.children = event.children.filter((c) => c.tag !== "SOUR");
    for (const s of incSours) {
      const clone = cloneNodeRemapped(s, sourMap);
      collectCustomTags(clone, customTags);
      insertOrdered(event, clone, EVENT_CHILD_ORDER);
    }
  }
  if (incLinks.length) {
    const existing = new Set(eventLinkUrls(event).map(linkKey));
    if (choice !== "both") {
      event.children = event.children.filter((c) => !EVENT_LINK_TAGS.has(c.tag));
      existing.clear();
    }
    for (const url of incLinks) {
      const key = linkKey(url);
      if (existing.has(key)) continue;
      existing.add(key);
      insertOrdered(event, newNode(EVENT_LINK_TAG, url), EVENT_CHILD_ORDER);
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
function setChild(
  parent: GedNode,
  tag: string,
  incomingParent: GedNode,
  choice: FieldChoice,
  order: string[],
  incChildOverride?: GedNode,
  customTags: Record<string, CustomTagNode[]> = {},
): boolean {
  const incChild = incChildOverride ?? incomingParent.children.find((c) => c.tag === tag);
  if (!incChild) return false;
  const clone = cloneNode(incChild);
  collectCustomTags(clone, customTags);
  const idx = parent.children.findIndex((c) => c.tag === tag);
  if (choice === "both" || idx < 0) {
    insertOrdered(parent, clone, order);
  } else {
    parent.children[idx] = clone;
  }
  return true;
}

function insertAt(parent: GedNode, index: number, child: GedNode): void {
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
function sortEventsByDate(record: GedNode): void {
  const suffixStart = INDI_CHILD_ORDER.indexOf("FAMC");
  const tagRank = (tag: string) => {
    const i = INDI_CHILD_ORDER.indexOf(tag);
    return i === -1 ? Infinity : i;
  };
  const isEvent = (node: GedNode) => {
    const r = tagRank(node.tag);
    if (r >= 2 && r < suffixStart) return true;
    return r === Infinity && node.tag.startsWith("_") && node.children.some((c) => c.tag === "DATE");
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

  const eventDate = (node: GedNode) => parseDate(node.children.find((c) => c.tag === "DATE")?.value ?? "");
  const minDeathKey = minDeathZoneKey(events.map((node) => ({ tag: node.tag, date: eventDate(node) })));
  const dateKey = (node: GedNode): number =>
    clampBeforeDeathZone(node.tag, dateToSortKey(eventDate(node)), minDeathKey);

  events.sort((a, b) => dateKey(a) - dateKey(b) || tagRank(a.tag) - tagRank(b.tag));
  eventIndices.forEach((idx, i) => {
    record.children[idx] = events[i];
  });
}

function newNode(tag: string, value?: string, xref?: string): GedNode {
  const node: GedNode = { level: 0, tag, children: [] };
  if (value !== undefined) node.value = value;
  if (xref !== undefined) node.xref = xref;
  return node;
}

function cloneNode(n: GedNode): GedNode {
  const c: GedNode = { level: n.level, tag: n.tag, children: n.children.map(cloneNode) };
  if (n.xref !== undefined) c.xref = n.xref;
  if (n.value !== undefined) c.value = n.value;
  return c;
}

/**
 * Walks a subtree just copied in from the incoming file and records any
 * non-standard tag found within it (the GEDCOM `_TAG` vendor-extension
 * convention — e.g. `_ITALIC`, `_PAREN`), so the save preview can offer to
 * drop it. `node` itself is never recorded, only its descendants, since the
 * caller always passes a known structural node (NAME, SOUR, DATE, …), never a
 * vendor extension.
 */
function collectCustomTags(node: GedNode, registry: Record<string, CustomTagNode[]>): void {
  for (const child of node.children) {
    if (child.tag.startsWith("_")) {
      (registry[child.tag] ??= []).push({ parent: node, node: child });
    }
    collectCustomTags(child, registry);
  }
}

// ---------------------------------------------------------------------------
// SOUR / REPO import helpers
// ---------------------------------------------------------------------------

/**
 * Map from a compare file's SOUR/REPO xref to the xref it will carry in the
 * merged output. Usually the same; only differs when the compare xref collides
 * with a master xref that points to a different record.
 */
type SourXrefMap = ReadonlyMap<string, string>;

/**
 * Pre-compute the xref translation table for all compare SOUR/REPO records.
 * A compare record describing the same real-world source as an existing
 * master one (per `sourceContentKey` — same TITL/ABBR/AUTH/…, regardless of
 * xref) maps straight to that master xref, so merging never mints a
 * duplicate record for a source the master already has. Otherwise: records
 * whose xref does not exist in the master are mapped to themselves; xref
 * collisions (with an unrelated record) get a fresh xref of the same type
 * (S… / R…) that avoids all existing master xrefs.
 */
function buildSourXrefMap(compareRecords: GedNode[], masterRecords: GedNode[]): Map<string, string> {
  const map = new Map<string, string>();
  const used = new Set(masterRecords.filter((r) => r.xref).map((r) => r.xref as string));

  const masterByContent = new Map<string, string>();
  for (const rec of masterRecords) {
    if ((rec.tag !== "SOUR" && rec.tag !== "REPO") || !rec.xref) continue;
    const key = sourceContentKey(rec);
    if (key && !masterByContent.has(`${rec.tag}:${key}`)) masterByContent.set(`${rec.tag}:${key}`, rec.xref);
  }

  for (const rec of compareRecords) {
    if ((rec.tag !== "SOUR" && rec.tag !== "REPO") || !rec.xref) continue;
    const key = sourceContentKey(rec);
    const existing = key ? masterByContent.get(`${rec.tag}:${key}`) : undefined;
    if (existing) {
      map.set(rec.xref, existing);
      continue;
    }
    if (!used.has(rec.xref)) {
      map.set(rec.xref, rec.xref);
      used.add(rec.xref);
    } else {
      const prefix = rec.tag === "REPO" ? "R" : "S";
      let n = 1;
      let fresh: string;
      do { fresh = `@${prefix}${n++}@`; } while (used.has(fresh));
      used.add(fresh);
      map.set(rec.xref, fresh);
    }
  }
  return map;
}

/** Deep-clone `n`, substituting any SOUR/REPO pointer values via `sourMap`. */
function cloneNodeRemapped(n: GedNode, sourMap: SourXrefMap): GedNode {
  const c: GedNode = { level: n.level, tag: n.tag, children: n.children.map((ch) => cloneNodeRemapped(ch, sourMap)) };
  if (n.xref !== undefined) c.xref = n.xref;
  if (n.value !== undefined) {
    const isSourPointer = (n.tag === "SOUR" || n.tag === "REPO") && /^@[^@]+@$/.test(n.value);
    c.value = isSourPointer ? (sourMap.get(n.value) ?? n.value) : n.value;
  }
  return c;
}

/**
 * After all merge decisions have been applied, scan the merged output for
 * SOUR/REPO xref pointers that don't yet have a corresponding top-level record
 * and import them from the compare file. Handles transitive dependencies
 * (a SOUR that references a REPO that also needs importing) by iterating to
 * fixpoint. The `sourMap` ensures imported records land under the correct output
 * xref and that any internal REPO pointers inside a SOUR are also remapped.
 */
function importSourRecords(
  records: GedNode[],
  compare: Dataset,
  sourMap: SourXrefMap,
  customTags: Record<string, CustomTagNode[]>,
): GedNode[] {
  const importedNodes: GedNode[] = [];
  // Reverse map: output xref → compare xref (only entries that were renamed).
  const reverseMap = new Map<string, string>();
  for (const [cXref, outXref] of sourMap) reverseMap.set(outXref, cXref);

  // Indexed lookup for compare SOUR/REPO records.
  const compareIndex = new Map<string, GedNode>();
  for (const rec of compare.records) {
    if ((rec.tag === "SOUR" || rec.tag === "REPO") && rec.xref) compareIndex.set(rec.xref, rec);
  }

  const collectSourRefs = (node: GedNode, out: Set<string>): void => {
    if ((node.tag === "SOUR" || node.tag === "REPO") && node.value && /^@[^@]+@$/.test(node.value)) {
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
  const incSours = incomingEventNode.children.filter((c) => c.tag === "SOUR");
  if (!incSours.length) return [];
  const sourMap = buildSourXrefMap(compare.records, dataset.records);
  for (const s of incSours) insertOrdered(eventNode, cloneNodeRemapped(s, sourMap), EVENT_CHILD_ORDER);
  const imported = importSourRecords(dataset.records, compare, sourMap, {});
  if (imported.length) bumpSourceCacheVersion(dataset.records);
  return imported;
}

// --- family structural merge (spouses & children) --------------------------

interface MergeContext {
  /** incoming individual id → its matched master individual id (if any). */
  incToMaster: Map<string, string>;
  /** Look up a (cloned) master individual record node by xref. */
  indiNode: (id: string) => GedNode | undefined;
  /** Look up a (cloned) master family record node by xref. */
  famNode: (id: string) => GedNode | undefined;
  /** Create a fresh empty FAM record (inserted before TRLR, indexed). */
  createFamily: () => { id: string; node: GedNode };
  /** Resolve an incoming individual to a master id, adding it as a new record
   *  when it has no match. Returns undefined if it can't be resolved. */
  resolve: (incomingId: string) => string | undefined;
  /** Display label for a master id, for the change report. */
  label: (id: string) => string;
  report: ChangeReport;
  touched: Set<string>;
  /** Incoming family ids already stitched in by applyIndividualFamilies, so a
   *  family shared by two confirmed spouses isn't merged in twice. */
  processedFamIds: Set<string>;
  /** Translator for human-readable change/deferred labels. */
  t: Translate;
  /** Compare SOUR/REPO xref → output xref. Used to remap nodes cloned from compare. */
  sourXrefMap: SourXrefMap;
}

function makeContext(
  master: Dataset,
  compare: Dataset,
  matches: MatchResult,
  records: GedNode[],
  indiNodes: Map<string, GedNode>,
  famNodes: Map<string, GedNode>,
  report: ChangeReport,
  touched: Set<string>,
  t: Translate,
  sourXrefMap: SourXrefMap,
): MergeContext {
  const incToMaster = new Map<string, string>();
  for (const c of matches.individuals) incToMaster.set(c.compareId, c.masterId);

  const used = new Set<string>();
  for (const r of records) if (r.xref) used.add(r.xref);
  const counters = new Map<string, number>();
  const allocXref = (prefix = "I"): string => {
    let n = counters.get(prefix) ?? 1;
    let id: string;
    do {
      id = `@${prefix}${n++}@`;
    } while (used.has(id));
    counters.set(prefix, n);
    used.add(id);
    return id;
  };

  const createFamily = (): { id: string; node: GedNode } => {
    const id = allocXref("F");
    const node = newNode("FAM");
    node.xref = id;
    insertRecord(records, node);
    famNodes.set(id, node);
    report.changes.push({ recordId: id, field: t("merge.field.newFamily"), from: "", to: "", action: "incoming", newRecord: true });
    report.newFamilies++;
    touched.add(id);
    return { id, node };
  };

  const addedLabels = new Map<string, string>();
  const addedFromIncoming = new Map<string, string>(); // incomingId → new master id

  const addNewIndividual = (incomingId: string): string | undefined => {
    const cached = addedFromIncoming.get(incomingId);
    if (cached) return cached;
    const incIndi = compare.individuals.get(incomingId);
    if (!incIndi) return undefined;
    const newId = allocXref();
    const node = cloneNodeRemapped(incIndi.raw, sourXrefMap);
    collectCustomTags(node, report.customTags);
    node.xref = newId;
    // Drop incoming family pointers; we re-link only into the family being merged.
    node.children = node.children.filter((c) => c.tag !== "FAMC" && c.tag !== "FAMS");
    insertRecord(records, node);
    indiNodes.set(newId, node);
    addedFromIncoming.set(incomingId, newId);
    const name = displayName(incIndi.names[0]);
    addedLabels.set(newId, name);
    report.recordLabels[newId] = name;
    report.changes.push({ recordId: newId, field: t("merge.field.newPerson"), from: "", to: name, action: "incoming", newRecord: true });
    report.newPersons++;
    touched.add(newId);
    return newId;
  };

  return {
    incToMaster,
    indiNode: (id) => indiNodes.get(id),
    famNode: (id) => famNodes.get(id),
    createFamily,
    resolve: (incomingId) => incToMaster.get(incomingId) ?? addNewIndividual(incomingId),
    label: (id) =>
      addedLabels.get(id) ?? displayName(master.individuals.get(id)?.names[0]),
    report,
    touched,
    processedFamIds: new Set<string>(),
    t,
    sourXrefMap,
  };
}

/**
 * Stitch an incoming family's spouses and/or children into a master family node.
 * Spouse slots are read from the (possibly already-edited) node so it works on
 * both existing and freshly-created families. Each missing spouse/child is
 * resolved to a master record (matched or newly added) and wired up.
 */
function applyFamilyStructure(
  famNode: GedNode,
  incFam: import("../gedcom/types").Family,
  ctx: MergeContext,
  opts: { spouses: boolean; children: boolean },
): void {
  const famId = famNode.xref;
  if (!famId) return;
  const slotValue = (tag: string) => famNode.children.find((c) => c.tag === tag)?.value;

  if (opts.spouses) {
    const spouses: Array<["HUSB" | "WIFE", string | undefined]> = [
      ["HUSB", incFam.husband],
      ["WIFE", incFam.wife],
    ];
    for (const [role, incSlot] of spouses) {
      if (!incSlot) continue;
      const targetId = ctx.resolve(incSlot);
      if (!targetId) continue;
      const masterSlot = slotValue(role);
      if (masterSlot) {
        if (masterSlot !== targetId) {
          ctx.report.deferred.push({
            recordId: famId,
            field: ctx.t(role === "HUSB" ? "merge.field.husband" : "merge.field.wife"),
            reason: ctx.t("merge.reason.masterHasSpouse"),
          });
        }
        continue;
      }
      if (addPointer(famNode, role, targetId, FAM_CHILD_ORDER)) {
        linkBack(ctx, targetId, "FAMS", famId);
        ctx.report.changes.push({
          recordId: famId,
          field: ctx.t(role === "HUSB" ? "merge.field.husband" : "merge.field.wife"),
          from: "",
          to: ctx.label(targetId),
          action: "incoming",
          unedited: true,
        });
        ctx.touched.add(famId);
      }
    }
  }

  if (opts.children) {
    const existing = new Set(
      famNode.children.filter((c) => c.tag === "CHIL").map((c) => c.value),
    );
    for (const incChild of incFam.children) {
      const known = ctx.incToMaster.get(incChild);
      if (known && existing.has(known)) continue;
      const targetId = ctx.resolve(incChild);
      if (!targetId || existing.has(targetId)) continue;
      if (addPointer(famNode, "CHIL", targetId, FAM_CHILD_ORDER)) {
        existing.add(targetId);
        linkBack(ctx, targetId, "FAMC", famId);
        ctx.report.changes.push({
          recordId: famId,
          field: ctx.t("merge.field.child"),
          from: "",
          to: ctx.label(targetId),
          action: "incoming",
          unedited: true,
        });
        ctx.touched.add(famId);
      }
    }
  }
}

/** True when the user's choice for a row means "take from incoming". */
function wantsIncoming(rows: Row[], fields: Record<string, FieldChoice>, key: string): boolean {
  const row = rows.find((r) => r.key === key);
  if (!row || row.state === "agree" || row.state === "master-only") return false;
  return (fields[key] ?? defaultChoice(row as never)) !== "master";
}

/**
 * Stitch a confirmed individual's parents taken from the incoming side into the
 * person's child-family (created if absent). The parent is linked to the matched
 * master person when known, else added as a new record.
 */
function applyIndividualRelations(
  masterId: string,
  _masterIndi: import("../gedcom/types").Individual,
  incomingIndi: import("../gedcom/types").Individual,
  rows: Row[],
  fields: Record<string, FieldChoice>,
  master: Dataset,
  compare: Dataset,
  ctx: MergeContext,
): void {
  const parents: Array<["father" | "mother", "HUSB" | "WIFE", string]> = [
    ["father", "HUSB", "merge.field.father"],
    ["mother", "WIFE", "merge.field.mother"],
  ];
  let childFam: { id: string; node: GedNode } | undefined;
  for (const [key, role, labelKey] of parents) {
    if (!wantsIncoming(rows, fields, key)) continue;
    const incParentId = incomingParentId(incomingIndi, compare, role);
    if (!incParentId) continue;
    const targetId = ctx.resolve(incParentId);
    if (!targetId) continue;
    childFam ??= ensureChildFamily(masterId, master, ctx);
    setSpouseSlot(childFam.node, role, targetId, ctx.t(labelKey), ctx);
  }
}

/**
 * Stitch a confirmed individual's marriages: spouse, marriage facts, and
 * children. Each incoming family the person belongs to is paired with the
 * master family for the same couple (created if absent), then its spouse
 * (if "partners" taken), marriage date/place/addr (per the MARR choices) and
 * children (if "children" taken) are merged in.
 */
function applyIndividualFamilies(
  masterId: string,
  masterIndi: import("../gedcom/types").Individual,
  incomingIndi: import("../gedcom/types").Individual,
  rows: Row[],
  fields: Record<string, FieldChoice>,
  master: Dataset,
  compare: Dataset,
  ctx: MergeContext,
): void {
  for (const incFamId of incomingIndi.spouseOf) {
    // A family with both spouses confirmed as matches is visited once per
    // spouse; only stitch it in on the first visit, or append-style fields
    // (notes, sources, "both" choices) would be applied twice.
    if (ctx.processedFamIds.has(incFamId)) continue;
    const incFam = compare.families.get(incFamId);
    if (!incFam) continue;
    const famKey = `fam.${incFamId}`;

    const takeSpouses = wantsIncoming(rows, fields, `${famKey}.partner`);
    const takeChildren = wantsIncoming(rows, fields, `${famKey}.children`);
    const marriageChoice = (sub: string): FieldChoice | undefined => {
      const key = `${famKey}.MARR.${sub}`;
      return wantsIncoming(rows, fields, key) ? fields[key] ?? "incoming" : undefined;
    };
    const wantMarriage = (["date", "place", "addr", "note", "agency", "sources"] as const).some((s) => marriageChoice(s));
    if (!takeSpouses && !takeChildren && !wantMarriage) continue;
    ctx.processedFamIds.add(incFamId);

    const otherIncId = incFam.husband === incomingIndi.id ? incFam.wife : incFam.husband;
    const otherMasterId = otherIncId ? ctx.incToMaster.get(otherIncId) : undefined;

    let famNode = findMasterSpouseFamily(masterIndi, master, masterId, otherMasterId, ctx);
    if (!famNode) famNode = createPersonFamily(masterId, masterIndi, ctx);

    applyFamilyStructure(famNode, incFam, ctx, { spouses: takeSpouses, children: takeChildren });

    const marrEntries: EventSubEdit[] = [];
    for (const sub of ["date", "place", "addr", "note", "agency"] as const) {
      const choice = marriageChoice(sub);
      if (!choice) continue;
      const subTag = SUB_TAG[sub];
      if (!subTag) continue;
      const rowKey = `${famKey}.MARR.${sub}`;
      const rowIncoming = rows.find((r) => r.key === rowKey)?.incoming ?? "";
      const applied = applyEventSub(famNode, incFam.raw, "MARR", subTag, choice, 0, 0, FAM_CHILD_ORDER, ctx.report.customTags);
      if (applied) {
        marrEntries.push({ sub, field: ctx.t(SUB_LABEL_KEY[sub]), from: "", to: rowIncoming, action: choice });
        ctx.touched.add(famNode.xref!);
      }
    }
    ctx.report.changes.push(...combineEventEdits(famNode.xref!, ctx.t("event.MARR"), marrEntries));

    const marrSourcesChoice = marriageChoice("sources");
    if (marrSourcesChoice && applyEventSources(famNode, incFam.raw, "MARR", marrSourcesChoice, 0, 0, FAM_CHILD_ORDER, ctx.sourXrefMap, ctx.report.customTags)) {
      ctx.report.changes.push({ recordId: famNode.xref!, field: ctx.t("field.sources"), from: "", to: "", action: marrSourcesChoice, group: ctx.t("event.MARR"), unedited: marrSourcesChoice === "incoming" });
      ctx.touched.add(famNode.xref!);
    }

    // Engagement, Separation, Divorce — same pattern as MARR.
    for (const evTag of ["ENGA", "SEPA", "DIV"] as const) {
      const evName = ctx.t(`event.${evTag}`);
      const evEntries: EventSubEdit[] = [];
      for (const sub of ["date", "place", "addr", "note", "agency"] as const) {
        const key = `${famKey}.${evTag}.${sub}`;
        if (!wantsIncoming(rows, fields, key)) continue;
        const choice = fields[key] ?? "incoming";
        const subTag = SUB_TAG[sub];
        if (!subTag) continue;
        const rowIncoming = rows.find((r) => r.key === key)?.incoming ?? "";
        const applied = applyEventSub(famNode, incFam.raw, evTag, subTag, choice, 0, 0, FAM_CHILD_ORDER, ctx.report.customTags);
        if (applied) {
          evEntries.push({ sub, field: ctx.t(SUB_LABEL_KEY[sub]), from: "", to: rowIncoming, action: choice });
          ctx.touched.add(famNode.xref!);
        }
      }
      ctx.report.changes.push(...combineEventEdits(famNode.xref!, evName, evEntries));
      const evSourcesKey = `${famKey}.${evTag}.sources`;
      if (wantsIncoming(rows, fields, evSourcesKey)) {
        const choice = fields[evSourcesKey] ?? "incoming";
        if (applyEventSources(famNode, incFam.raw, evTag, choice, 0, 0, FAM_CHILD_ORDER, ctx.sourXrefMap, ctx.report.customTags)) {
          ctx.report.changes.push({ recordId: famNode.xref!, field: ctx.t("field.sources"), from: "", to: "", action: choice, group: evName, unedited: choice === "incoming" });
          ctx.touched.add(famNode.xref!);
        }
      }
    }

    // Family notes.
    const famNotesKey = `${famKey}.notes`;
    if (wantsIncoming(rows, fields, famNotesKey)) {
      const choice = fields[famNotesKey] ?? "incoming";
      if (applyNotes(famNode, incFam.raw, choice, ctx.sourXrefMap, FAM_CHILD_ORDER, ctx.report.customTags)) {
        ctx.report.changes.push({
          recordId: famNode.xref!,
          field: ctx.t("field.notes"),
          from: "",
          to: incFam.notes?.join("\n") ?? "",
          action: choice,
          unedited: choice === "incoming",
        });
        ctx.touched.add(famNode.xref!);
      }
    }
  }
}

/** Find the master family pairing this person with the given (matched) spouse. */
function findMasterSpouseFamily(
  masterIndi: import("../gedcom/types").Individual,
  master: Dataset,
  masterId: string,
  otherMasterId: string | undefined,
  ctx: MergeContext,
): GedNode | undefined {
  for (const famId of masterIndi.spouseOf) {
    const fam = master.families.get(famId);
    if (!fam) continue;
    const other = fam.husband === masterId ? fam.wife : fam.husband;
    if (otherMasterId ? other === otherMasterId : !other) return ctx.famNode(famId);
  }
  // Single marriage on each side: pair the lone families even without a match id.
  if (masterIndi.spouseOf.length === 1) return ctx.famNode(masterIndi.spouseOf[0]);
  return undefined;
}

/** Create a new family with the master person placed in their sex's slot. */
function createPersonFamily(
  masterId: string,
  masterIndi: import("../gedcom/types").Individual,
  ctx: MergeContext,
): GedNode {
  const fam = ctx.createFamily();
  const role = masterIndi.sex === "F" ? "WIFE" : "HUSB";
  addPointer(fam.node, role, masterId, FAM_CHILD_ORDER);
  linkBack(ctx, masterId, "FAMS", fam.id);
  return fam.node;
}

/** The family node where the master person is a child, creating one if absent. */
function ensureChildFamily(
  masterId: string,
  master: Dataset,
  ctx: MergeContext,
): { id: string; node: GedNode } {
  const existing = master.individuals.get(masterId)?.childOf[0];
  if (existing) {
    const node = ctx.famNode(existing);
    if (node) return { id: existing, node };
  }
  const fam = ctx.createFamily();
  addPointer(fam.node, "CHIL", masterId, FAM_CHILD_ORDER);
  const indi = ctx.indiNode(masterId);
  if (indi) addPointer(indi, "FAMC", fam.id, INDI_CHILD_ORDER);
  return fam;
}

/** Fill a HUSB/WIFE slot if empty; note a conflict if it already differs. */
function setSpouseSlot(
  famNode: GedNode,
  role: "HUSB" | "WIFE",
  personId: string,
  label: string,
  ctx: MergeContext,
): void {
  const famId = famNode.xref!;
  const existing = famNode.children.find((c) => c.tag === role);
  if (existing) {
    if (existing.value !== personId) {
      ctx.report.deferred.push({
        recordId: famId,
        field: label,
        reason: ctx.t(role === "HUSB" ? "merge.reason.familyHasHusband" : "merge.reason.familyHasWife"),
      });
    }
    return;
  }
  addPointer(famNode, role, personId, FAM_CHILD_ORDER);
  linkBack(ctx, personId, "FAMS", famId);
  ctx.report.changes.push({ recordId: famId, field: label, from: "", to: ctx.label(personId), action: "incoming", unedited: true });
  ctx.touched.add(famId);
}

function incomingParentId(
  incomingIndi: import("../gedcom/types").Individual,
  compare: Dataset,
  role: "HUSB" | "WIFE",
): string | undefined {
  const famId = incomingIndi.childOf[0];
  const fam = famId ? compare.families.get(famId) : undefined;
  return role === "HUSB" ? fam?.husband : fam?.wife;
}

/** Add a FAMC/FAMS pointer back on the individual record (if not already there). */
function linkBack(ctx: MergeContext, indiId: string, tag: string, famId: string): void {
  const node = ctx.indiNode(indiId);
  if (node) addPointer(node, tag, famId, INDI_CHILD_ORDER);
}

/**
 * Insert a pointer line (`<tag> <id>`) into a record using canonical ordering.
 * Skips if an identical pointer already exists.
 */
function addPointer(parent: GedNode, tag: string, id: string, order: string[]): boolean {
  if (parent.children.some((c) => c.tag === tag && c.value === id)) return false;
  insertOrdered(parent, newNode(tag, id), order);
  return true;
}

function parseKey(key: string): { kind: string; masterId: string; compareId: string } {
  const [kind, masterId, compareId] = key.split(":");
  return { kind, masterId, compareId };
}

/** Human-readable change report (plain text) to download alongside the merge. */
export function formatReport(report: ChangeReport, title = "GED Merge change report"): string {
  const lines: string[] = [];
  lines.push(title);
  lines.push("=".repeat(title.length));
  lines.push("");
  lines.push(`Records changed:  ${report.recordsChanged}`);
  lines.push(`Fields applied:   ${report.changes.length}`);
  lines.push(`New persons:      ${report.newPersons}`);
  lines.push(`New families:     ${report.newFamilies}`);
  lines.push(`Deferred:         ${report.deferred.length}`);
  lines.push("");

  const recordHeader = (id: string) => {
    const label = report.recordLabels[id];
    return label ? `${label}  ${id}` : id;
  };

  const meaningful = report.changes.filter((c) => c.field);
  if (meaningful.length) {
    lines.push("Applied changes");
    lines.push("---------------");
    const byRecord = new Map<string, typeof meaningful>();
    for (const c of meaningful) {
      const group = byRecord.get(c.recordId) ?? [];
      group.push(c);
      byRecord.set(c.recordId, group);
    }
    for (const [id, group] of byRecord) {
      const header = recordHeader(id);
      lines.push(header);
      lines.push("-".repeat(header.length));
      for (const c of group) {
        if (!c.to && c.from) {
          lines.push(`  ${c.field}: removed "${c.from}"`);
        } else {
          const verb = c.action === "both" ? "added" : "set";
          lines.push(`  ${c.field}: ${verb} "${c.to}"${c.from ? ` (was "${c.from}")` : ""}`);
        }
      }
      lines.push("");
    }
  }

  if (report.deferred.length) {
    lines.push("Not applied (needs relationship/link merge)");
    lines.push("-------------------------------------------");
    const byRecord = new Map<string, typeof report.deferred>();
    for (const d of report.deferred) {
      const group = byRecord.get(d.recordId) ?? [];
      group.push(d);
      byRecord.set(d.recordId, group);
    }
    for (const [id, group] of byRecord) {
      const header = recordHeader(id);
      lines.push(header);
      lines.push("-".repeat(header.length));
      for (const d of group) lines.push(`  ${d.field}: ${d.reason}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

// Re-export so callers can build the decision key consistently.
export { decisionKey };
