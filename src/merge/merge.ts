import { looksLikeUrl } from "../gedcom/builder";
import { FAM_CHILD_ORDER, INDI_CHILD_ORDER, insertOrdered, insertRecord, nextXref } from "../gedcom/edit";
import type { Dataset, GedNode } from "../gedcom/types";
import type { MatchResult } from "../match/types";
import { displayName } from "../match/relatives";
import { inferPlaceExportFormat } from "../normalize/profile";
import { individualFieldRows, linkKey, matriculaLangCode, withMatriculaLang } from "../review/fields";
import { defaultChoice, decisionKey, type CandidateDecision, type FieldChoice } from "../review/types";
import { reformatPlace, reshapesLayout, type PlaceTargetFormat } from "./placeReformat";

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
}

/** A confirmed change the engine did not yet apply (relationship/links). */
export interface DeferredChange {
  recordId: string;
  field: string;
  reason: string;
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
  /** Incoming places reshaped into the master's layout on export. */
  placesReformatted: number;
  /** Of those, how many had extra detail preserved in a NOTE. */
  placesNoted: number;
  /** Display label per touched record id, for grouping the preview/report. */
  recordLabels: Record<string, string>;
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
const SUB_TAG: Record<string, string> = { date: "DATE", place: "PLAC", addr: "ADDR" };

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
    placesReformatted: 0,
    placesNoted: 0,
    recordLabels: {},
  };
  const touched = new Set<string>();
  // How the master writes places, so incoming places can be reshaped to match.
  const placeFmt = inferPlaceExportFormat(master);
  // The language code the master's own Matricula Online links already use, so
  // newly added links can be rewritten to match (e.g. /sl/ vs /de/).
  const matriculaLang = detectMatriculaLang(master);
  // How the master stores record-level links, so newly added links match (e.g.
  // a plain WWW line, Family Historian's _WEBTAG block, or an OBJE/FILE record).
  const linkFormat = detectLinkFormat(master);
  const ctx = makeContext(master, compare, matches, records, indiNodes, famNodes, report, touched, placeFmt, t);

  for (const [key, decision] of decisions) {
    if (decision.status !== "confirmed") continue;
    const { kind, masterId, compareId } = parseKey(key);
    if (kind !== "individual") continue; // families are merged via their spouses

    const target = indiNodes.get(masterId);
    const masterIndi = master.individuals.get(masterId);
    const incoming = compare.individuals.get(compareId);
    if (!target || !masterIndi || !incoming) continue;
    report.recordLabels[masterId] = displayName(masterIndi.names[0]);
    const rows = individualFieldRows(t, masterIndi, incoming, master, compare);
    applyRows(target, incoming.raw, masterId, rows, decision.fields, report, touched, INDI_HANDLED, placeFmt, t, matriculaLang, linkFormat, records);
    applyIndividualRelations(masterId, masterIndi, incoming, rows, decision.fields, master, compare, ctx);
    applyIndividualFamilies(masterId, masterIndi, incoming, rows, decision.fields, master, compare, ctx);
  }

  // Label each touched family by the spouses we know about (master or added).
  for (const [famId, names] of ctx.famSpouseNames) {
    if (names.length) report.recordLabels[famId] = names.join(" & ");
  }

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
  placeFmt: PlaceTargetFormat,
  t: Translate,
  matriculaLang: string | undefined,
  linkFormat: LinkFormat,
  records: GedNode[],
): void {
  let nameApplied = false;
  // Event tags whose place we already reshaped, so the matching ADDR row is
  // skipped (the PLAC reshape consumed both PLAC and ADDR together).
  const reshaped = new Set<string>();
  for (const row of rows) {
    // Nothing on the incoming side to take, or the two already agree.
    if (row.state === "agree" || row.state === "master-only") continue;
    // Handled elsewhere (family spouses/children go through applyFamilyStructure).
    if (handled.has(row.key) || row.key.startsWith("fam.")) continue;
    const choice = fields[row.key] ?? defaultChoice(row as never);
    if (choice === "master") continue;

    if (row.key === "links") {
      const added = applyLinks(target, row.incomingLinks ?? [], row.masterLinks ?? [], matriculaLang, linkFormat, records);
      if (added.length) {
        report.changes.push({ recordId, field: row.label, from: row.master, to: added.join("\n"), action: choice });
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
      applied = applyName(target, incomingRecord, choice);
      nameApplied = applied;
    } else if (row.key === "sex") {
      applied = setChild(target, "SEX", incomingRecord, choice);
    } else if (row.key === "nickname") {
      applied = applyNickname(target, incomingRecord, choice);
    } else if (row.key === "additionalNames") {
      applied = applyAdditionalNames(target, incomingRecord, choice);
    } else if (row.key === "notes") {
      applied = applyNotes(target, incomingRecord, choice);
    } else {
      const [tag, sub] = row.key.split(".");
      if ((sub === "place" || sub === "addr") && reshapesLayout(placeFmt.layout)) {
        // Reshape PLAC+ADDR together into the master's layout, once per event.
        // The PLAC row drives it; a later ADDR row is then skipped.
        if (reshaped.has(tag)) continue;
        applied = applyReformattedPlace(target, incomingRecord, tag, choice, placeFmt, report);
        reshaped.add(tag);
      } else {
        const subTag = SUB_TAG[sub];
        if (subTag) applied = applyEventSub(target, incomingRecord, tag, subTag, choice);
      }
    }

    if (applied) {
      report.changes.push({ recordId, field: row.label, from: row.master, to: row.incoming, action: choice });
      touched.add(recordId);
    }
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
 * (by `linkKey`), shaped to match the master's own link format. Matricula
 * Online links are rewritten to the master's language code, if one is known.
 * Returns the URLs actually added.
 */
function applyLinks(
  target: GedNode,
  incomingLinks: string[],
  masterLinks: string[],
  matriculaLang: string | undefined,
  linkFormat: LinkFormat,
  records: GedNode[],
): string[] {
  const existing = new Set(masterLinks.map(linkKey));
  const added: string[] = [];
  for (const url of incomingLinks) {
    const key = linkKey(url);
    if (existing.has(key)) continue;
    existing.add(key);
    const value = matriculaLang && matriculaLangCode(url) ? withMatriculaLang(url, matriculaLang) : url;
    target.children.push(buildLinkNode(linkFormat, value, records));
    added.push(value);
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

/**
 * The language code the master file's existing Matricula Online links use
 * most often, so newly added links can be rewritten to match.
 */
function detectMatriculaLang(master: Dataset): string | undefined {
  const counts = new Map<string, number>();
  const consider = (links?: string[]) => {
    for (const url of links ?? []) {
      const lang = matriculaLangCode(url);
      if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
    }
  };
  for (const indi of master.individuals.values()) {
    consider(indi.links);
    for (const e of indi.events) consider(e.links);
  }
  for (const fam of master.families.values()) {
    consider(fam.links);
    for (const e of fam.events) consider(e.links);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [lang, count] of counts) {
    if (count > bestCount) {
      best = lang;
      bestCount = count;
    }
  }
  return best;
}

/** Replace or (for "both") add the primary NAME line from the incoming record. */
function applyName(target: GedNode, incomingRecord: GedNode, choice: FieldChoice): boolean {
  const incName = incomingRecord.children.find((c) => c.tag === "NAME");
  if (!incName) return false;
  const clone = cloneNode(incName);
  const idx = target.children.findIndex((c) => c.tag === "NAME");
  if (choice === "both" || idx < 0) {
    insertAt(target, idx < 0 ? target.children.length : idx + 1, clone);
  } else {
    target.children[idx] = clone;
  }
  return true;
}

/**
 * Copy NOTE children from the incoming record. "incoming" replaces any existing
 * notes; "both" appends them. Used for both individual and family notes.
 */
function applyNotes(target: GedNode, incoming: GedNode, choice: FieldChoice): boolean {
  const incNotes = incoming.children.filter((c) => c.tag === "NOTE");
  if (!incNotes.length) return false;
  if (choice !== "both") target.children = target.children.filter((c) => c.tag !== "NOTE");
  for (const n of incNotes) target.children.push(cloneNode(n));
  return true;
}

/** Set the NICK sub-node on the primary NAME record from the incoming side. */
function applyNickname(target: GedNode, incomingRecord: GedNode, choice: FieldChoice): boolean {
  const incName = incomingRecord.children.find((c) => c.tag === "NAME");
  if (!incName) return false;
  const incNick = incName.children.find((c) => c.tag === "NICK");
  if (!incNick) return false;
  let name = target.children.find((c) => c.tag === "NAME");
  if (!name) {
    name = newNode("NAME");
    insertAt(target, 0, name);
  }
  return setChild(name, "NICK", incName, choice, incNick);
}

/** Copy the incoming record's additional NAME nodes (everything after the first). */
function applyAdditionalNames(target: GedNode, incoming: GedNode, choice: FieldChoice): boolean {
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
  for (const n of incExtra) target.children.push(cloneNode(n));
  return true;
}

/** Apply an event's date/place/address by copying the incoming sub-node. */
function applyEventSub(
  target: GedNode,
  incomingRecord: GedNode,
  tag: string,
  subTag: string,
  choice: FieldChoice,
): boolean {
  const incEvent = incomingRecord.children.find((c) => c.tag === tag);
  const incSub = incEvent?.children.find((c) => c.tag === subTag);
  if (!incSub) return false;
  let event = target.children.find((c) => c.tag === tag);
  if (!event) {
    event = newNode(tag);
    target.children.push(event);
  }
  return setChild(event, subTag, incEvent!, choice, incSub);
}

/**
 * Reshape an incoming event's place into the master's structured layout and
 * write it onto the target event: jurisdiction → PLAC, house number → ADDR, and
 * any leftover (parish/facility) → a NOTE so nothing is dropped. Consumes both
 * the incoming PLAC and ADDR. Returns whether anything was written.
 */
function applyReformattedPlace(
  target: GedNode,
  incomingRecord: GedNode,
  tag: string,
  choice: FieldChoice,
  fmt: PlaceTargetFormat,
  report: ChangeReport,
): boolean {
  const incEvent = incomingRecord.children.find((c) => c.tag === tag);
  if (!incEvent) return false;
  const placRaw = incEvent.children.find((c) => c.tag === "PLAC")?.value;
  const addrRaw = incEvent.children.find((c) => c.tag === "ADDR")?.value;
  if (!placRaw && !addrRaw) return false;

  const r = reformatPlace(placRaw, addrRaw, fmt);
  let event = target.children.find((c) => c.tag === tag);
  if (!event) {
    event = newNode(tag);
    target.children.push(event);
  }

  let applied = false;
  if (setValueChild(event, "PLAC", r.plac, choice)) applied = true;
  if (setValueChild(event, "ADDR", r.addr, choice)) applied = true;
  if (r.note) {
    event.children.push(newNode("NOTE", r.note));
    applied = true;
  }
  if (applied) {
    report.placesReformatted++;
    if (r.note) report.placesNoted++;
  }
  return applied;
}

/** Set (or, for "both", append) a tagged child carrying a plain value. */
function setValueChild(
  parent: GedNode,
  tag: string,
  value: string | undefined,
  choice: FieldChoice,
): boolean {
  if (!value) return false;
  const node = newNode(tag, value);
  const idx = parent.children.findIndex((c) => c.tag === tag);
  if (choice === "both" || idx < 0) parent.children.push(node);
  else parent.children[idx] = node;
  return true;
}

/**
 * Copy a single-valued child (e.g. SEX, or DATE under BIRT) from the incoming
 * side. "incoming" replaces the existing child; "both" appends a second one.
 * Returns false when the incoming side has no such child.
 */
function setChild(
  parent: GedNode,
  tag: string,
  incomingParent: GedNode,
  choice: FieldChoice,
  incChildOverride?: GedNode,
): boolean {
  const incChild = incChildOverride ?? incomingParent.children.find((c) => c.tag === tag);
  if (!incChild) return false;
  const clone = cloneNode(incChild);
  const idx = parent.children.findIndex((c) => c.tag === tag);
  if (choice === "both" || idx < 0) {
    parent.children.push(clone);
  } else {
    parent.children[idx] = clone;
  }
  return true;
}

function insertAt(parent: GedNode, index: number, child: GedNode): void {
  parent.children.splice(index, 0, child);
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
  /** How the master writes places (for reshaping incoming places on export). */
  placeFmt: PlaceTargetFormat;
  /** Spouse display names gathered per family id, used to label the family. */
  famSpouseNames: Map<string, string[]>;
  /** Record a spouse's name against a family (for the merge preview/report). */
  noteSpouse: (famId: string, name: string) => void;
  /** Translator for human-readable change/deferred labels. */
  t: Translate;
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
  placeFmt: PlaceTargetFormat,
  t: Translate,
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

  const famSpouseNames = new Map<string, string[]>();
  const noteSpouse = (famId: string, name: string): void => {
    const arr = famSpouseNames.get(famId) ?? [];
    if (name && !arr.includes(name)) arr.push(name);
    famSpouseNames.set(famId, arr);
  };

  const addedLabels = new Map<string, string>();
  const addedFromIncoming = new Map<string, string>(); // incomingId → new master id

  const addNewIndividual = (incomingId: string): string | undefined => {
    const cached = addedFromIncoming.get(incomingId);
    if (cached) return cached;
    const incIndi = compare.individuals.get(incomingId);
    if (!incIndi) return undefined;
    const newId = allocXref();
    const node = cloneNode(incIndi.raw);
    node.xref = newId;
    // Drop incoming family pointers; we re-link only into the family being merged.
    node.children = node.children.filter((c) => c.tag !== "FAMC" && c.tag !== "FAMS");
    reshapeRecordPlaces(node, placeFmt, report);
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
    placeFmt,
    famSpouseNames,
    noteSpouse,
    t,
  };
}

/**
 * Reshape every place under a record (a newly-added person cloned wholesale)
 * into the master's layout. Each node bearing a PLAC/ADDR has them rewritten —
 * jurisdiction to PLAC, address to ADDR, leftovers to a NOTE.
 */
function reshapeRecordPlaces(record: GedNode, fmt: PlaceTargetFormat, report: ChangeReport): void {
  if (!reshapesLayout(fmt.layout)) return;
  const visit = (node: GedNode): void => {
    const placRaw = node.children.find((c) => c.tag === "PLAC")?.value;
    const addrRaw = node.children.find((c) => c.tag === "ADDR")?.value;
    if (placRaw || addrRaw) {
      const r = reformatPlace(placRaw, addrRaw, fmt);
      node.children = node.children.filter((c) => c.tag !== "PLAC" && c.tag !== "ADDR");
      if (r.plac) node.children.push(newNode("PLAC", r.plac));
      if (r.addr) node.children.push(newNode("ADDR", r.addr));
      if (r.note) node.children.push(newNode("NOTE", r.note));
      report.placesReformatted++;
      if (r.note) report.placesNoted++;
    }
    node.children.forEach(visit);
  };
  visit(record);
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
        ctx.noteSpouse(famId, ctx.label(targetId));
        ctx.report.changes.push({
          recordId: famId,
          field: ctx.t(role === "HUSB" ? "merge.field.husband" : "merge.field.wife"),
          from: "",
          to: ctx.label(targetId),
          action: "incoming",
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
    const incFam = compare.families.get(incFamId);
    if (!incFam) continue;
    const famKey = `fam.${incFamId}`;

    const takeSpouses = wantsIncoming(rows, fields, `${famKey}.partner`);
    const takeChildren = wantsIncoming(rows, fields, `${famKey}.children`);
    const marriageChoice = (sub: string): FieldChoice | undefined => {
      const key = `${famKey}.MARR.${sub}`;
      return wantsIncoming(rows, fields, key) ? fields[key] ?? "incoming" : undefined;
    };
    const wantMarriage = (["date", "place", "addr"] as const).some((s) => marriageChoice(s));
    if (!takeSpouses && !takeChildren && !wantMarriage) continue;

    const otherIncId = incFam.husband === incomingIndi.id ? incFam.wife : incFam.husband;
    const otherMasterId = otherIncId ? ctx.incToMaster.get(otherIncId) : undefined;

    let famNode = findMasterSpouseFamily(masterIndi, master, masterId, otherMasterId, ctx);
    if (!famNode) famNode = createPersonFamily(masterId, masterIndi, ctx);

    applyFamilyStructure(famNode, incFam, ctx, { spouses: takeSpouses, children: takeChildren });

    const reshapeMarr = reshapesLayout(ctx.placeFmt.layout);
    let marrReshaped = false;
    for (const sub of ["date", "place", "addr"] as const) {
      const choice = marriageChoice(sub);
      if (!choice) continue;
      let applied: boolean;
      if ((sub === "place" || sub === "addr") && reshapeMarr) {
        // PLAC+ADDR are reshaped together, once, into the master's layout.
        if (marrReshaped) continue;
        applied = applyReformattedPlace(famNode, incFam.raw, "MARR", choice, ctx.placeFmt, ctx.report);
        marrReshaped = true;
      } else {
        applied = applyEventSub(famNode, incFam.raw, "MARR", SUB_TAG[sub], choice);
      }
      if (applied) {
        ctx.report.changes.push({
          recordId: famNode.xref!,
          field: ctx.t(`merge.field.marriage.${sub}`),
          from: "",
          to: incFam.events.find((e) => e.tag === "MARR")?.[sub === "addr" ? "address" : sub]?.raw ?? "",
          action: choice,
        });
        ctx.touched.add(famNode.xref!);
      }
    }

    // Engagement, Separation, Divorce — same pattern as MARR.
    for (const evTag of ["ENGA", "SEPA", "DIV"] as const) {
      const evName = ctx.t(`event.${evTag}`);
      const reshapeEv = reshapesLayout(ctx.placeFmt.layout);
      let evReshaped = false;
      for (const sub of ["date", "place", "addr"] as const) {
        const key = `${famKey}.${evTag}.${sub}`;
        if (!wantsIncoming(rows, fields, key)) continue;
        const choice = fields[key] ?? "incoming";
        let applied: boolean;
        if ((sub === "place" || sub === "addr") && reshapeEv) {
          if (evReshaped) continue;
          applied = applyReformattedPlace(famNode, incFam.raw, evTag, choice, ctx.placeFmt, ctx.report);
          evReshaped = true;
        } else {
          applied = applyEventSub(famNode, incFam.raw, evTag, SUB_TAG[sub], choice);
        }
        if (applied) {
          ctx.report.changes.push({
            recordId: famNode.xref!,
            field: ctx.t(`event.${sub}`, { event: evName }),
            from: "",
            to: incFam.events.find((e) => e.tag === evTag)?.[sub === "addr" ? "address" : sub]?.raw ?? "",
            action: choice,
          });
          ctx.touched.add(famNode.xref!);
        }
      }
    }

    // Family notes.
    const famNotesKey = `${famKey}.notes`;
    if (wantsIncoming(rows, fields, famNotesKey)) {
      const choice = fields[famNotesKey] ?? "incoming";
      if (applyNotes(famNode, incFam.raw, choice)) {
        ctx.report.changes.push({
          recordId: famNode.xref!,
          field: ctx.t("field.notes"),
          from: "",
          to: incFam.notes?.join("\n") ?? "",
          action: choice,
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
  ctx.noteSpouse(fam.id, ctx.label(masterId));
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
  ctx.noteSpouse(famId, ctx.label(personId));
  ctx.report.changes.push({ recordId: famId, field: label, from: "", to: ctx.label(personId), action: "incoming" });
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
export function formatReport(report: ChangeReport): string {
  const lines: string[] = [];
  lines.push("GED Merge change report");
  lines.push("=======================");
  lines.push("");
  lines.push(`Records changed:  ${report.recordsChanged}`);
  lines.push(`Fields applied:   ${report.changes.length}`);
  lines.push(`New persons:      ${report.newPersons}`);
  lines.push(`New families:     ${report.newFamilies}`);
  if (report.placesReformatted) {
    const noted = report.placesNoted ? ` (${report.placesNoted} kept extra detail in a note)` : "";
    lines.push(`Places reshaped:  ${report.placesReformatted}${noted}`);
  }
  lines.push(`Deferred:         ${report.deferred.length}`);
  lines.push("");

  if (report.changes.length) {
    lines.push("Applied changes");
    lines.push("---------------");
    for (const c of report.changes) {
      const verb = c.action === "both" ? "added" : "set";
      lines.push(`${c.recordId}  ${c.field}: ${verb} "${c.to}"${c.from ? ` (was "${c.from}")` : ""}`);
    }
    lines.push("");
  }

  if (report.deferred.length) {
    lines.push("Not applied (needs relationship/link merge)");
    lines.push("-------------------------------------------");
    for (const d of report.deferred) {
      lines.push(`${d.recordId}  ${d.field}: ${d.reason}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// Re-export so callers can build the decision key consistently.
export { decisionKey };
