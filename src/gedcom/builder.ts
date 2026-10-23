import { parseDate } from "./date";
import { parseName } from "./name";
import { parsePlace, placeNodeCoord } from "./place";
import { childValue, childrenByTag, firstChild } from "./node";
import { buildSourceContext, objeInfoOf, resolveSourceCitation, type SourceContext } from "./source";
import { isPointer, isVoidPointer, looksLikeUrl, stripTrailingPunct, URL_RE } from "./uri";
import { isPrivateNode } from "./private";
import { associationsIn, parseAssociation } from "./assoc";
import { runSteps, type Steps } from "./steps";
import { readSex } from "./sex";
import { negativeAssertionsOf } from "./negative";
import { nodeSortDate } from "./sortDate";
import { isFsIdNode, readExid } from "./exid";
import { nameTranslationsOf, translationsOf } from "./translation";
import { addressText, contactTagOf, readAddressParts, type AddressContactTag } from "./address";

/** Which `GedEvent` field each contact line is read into. */
const CONTACT_FIELD: Record<AddressContactTag, "phone" | "email" | "fax"> = { PHON: "phone", EMAIL: "email", FAX: "fax" };

// Re-exported so existing importers (merge, normalize) keep their import path.
export { looksLikeUrl };
import type {
  Association,
  ChanCreaUsage,
  ExternalId,
  Dataset,
  Family,
  GedEvent,
  GedNode,
  Individual,
  NoteRef,
  ParseResult,
  SourceCitation,
  Translation,
  PersonName,
  Sex,
} from "./types";

import { ALL_EVENT_TAGS, FAM_EVENT_TAGS, INDI_EVENT_TAGS, LDS_ORDINANCE_TAGS, isChangeStampEvent } from "./eventTags";
import { UPD_STAMP_TYPE } from "./vendorTags";
import { EDITABLE_LINK_TAGS, nextXref } from "./edit/shared";
import { decodeEntities, isHtmlNote, noteToText } from "./noteHtml";

/** An empty, fully-typed `Dataset` — for callers that need a valid compare side
 *  with nothing in it (e.g. single-file chart building). Fresh on every call, so
 *  a consumer mutating its Maps can't poison another. Kept next to
 *  {@link buildDataset} so a new `Dataset` field is added in both places. */
export function emptyDataset(): Dataset {
  return {
    version: "unknown",
    charset: "UTF-8",
    individuals: new Map(),
    families: new Map(),
    records: [],
    warnings: [],
    eol: "\r\n",
    finalNewline: true,
    chanCreaUsage: { recordChan: false, recordCrea: false, eventChan: false, eventCrea: false, recordUpd: false, sharedChan: false, sharedCrea: false, sharedUpd: false },
  };
}

/** Build the typed domain `Dataset` from a parsed line tree. */
export function buildDataset(parsed: ParseResult): Dataset {
  return runSteps(buildDatasetSteps(parsed));
}

/** Records built between two yields of {@link buildDatasetSteps}. */
const RECORDS_PER_STEP = 2_000;
/** Records whose xref is indexed between two yields. */
const XREFS_PER_STEP = 50_000;

/** {@link buildDataset} as a stepped pass (see `steps.ts`), yielding between
 *  its whole-file indexes and every {@link RECORDS_PER_STEP} records — what
 *  the main thread runs in slices. */
export function* buildDatasetSteps(parsed: ParseResult): Steps<Dataset> {
  const individuals = new Map<string, Individual>();
  const families = new Map<string, Family>();
  const records = parsed.records;

  // Two records with one xref: pointers have always bound to the last copy
  // (every index below is last-wins), so that one keeps the id. Each earlier
  // copy is a whole person (or family, source …) of its own and must not be
  // lost, nor serialize under the same id a second time (strict importers
  // reject that) — it takes a fresh, unused xref instead, and the warning
  // names it. Deterministic, so the worker's parse and the main thread's agree.
  // (Indexing ~700k xrefs takes a few hundred milliseconds, so these passes
  // yield too.)
  const lastIndex = new Map<string, number>();
  for (let i = 0; i < records.length; i++) {
    if (i % XREFS_PER_STEP === XREFS_PER_STEP - 1) yield;
    const xref = records[i].xref;
    if (xref) lastIndex.set(xref, i);
  }
  for (let i = 0; i < records.length; i++) {
    if (i % XREFS_PER_STEP === XREFS_PER_STEP - 1) yield;
    const record = records[i];
    if (!record.xref || lastIndex.get(record.xref) === i) continue;
    const prefix = record.xref.match(/^@([A-Za-z]+)/)?.[1] ?? (record.tag.match(/^[A-Za-z]/)?.[0] ?? "X");
    const fresh = nextXref(records, prefix);
    parsed.warnings.push({
      kind: "structure",
      message: `Duplicate xref ${record.xref}: a later ${record.tag} record overrides an earlier record with the same id; the earlier record is kept as ${fresh}.`,
    });
    record.xref = fresh;
  }
  yield;

  // Shared multimedia (OBJE) records hold their URL in a FILE line; records
  // attach them by pointer (`1 OBJE @xref@`), so resolve those up front.
  const media = buildMediaLinks(records);
  yield;
  // Likewise, source (SOUR) and repository (REPO) records are shared and
  // referenced by pointer from event-level citations.
  const sourceCtx = buildSourceContext(records);
  yield;
  // Shared NOTE records hold their text; records reference them by pointer
  // (`1 NOTE @xref@`), so resolve those to real text up front.
  const notes = buildNoteIndex(records);
  yield;

  for (let i = 0; i < records.length; i++) {
    if (i % RECORDS_PER_STEP === RECORDS_PER_STEP - 1) yield;
    const record = records[i];
    if (record.tag === "INDI" && record.xref) {
      individuals.set(record.xref, buildIndividual(record, media, sourceCtx, notes));
    } else if (record.tag === "FAM" && record.xref) {
      families.set(record.xref, buildFamily(record, media, sourceCtx, notes));
    }
  }

  return {
    version: parsed.version,
    charset: parsed.charset,
    individuals,
    families,
    records,
    warnings: parsed.warnings,
    eol: parsed.eol,
    finalNewline: parsed.finalNewline,
    bom: parsed.bom,
    chanCreaUsage: detectChanCreaUsage(records),
  };
}

function detectChanCreaUsage(records: GedNode[]): ChanCreaUsage {
  let recordChan = false, recordCrea = false, eventChan = false, eventCrea = false;
  let sharedChan = false, sharedCrea = false;
  // The `_UPD` tag is MyHeritage's current spelling and the event its older
  // one; a file carrying both (they coexist in the wild) is stamped in the
  // tag form, and a record keeping the event form is refreshed where it is.
  let recordUpd: ChanCreaUsage["recordUpd"] = false;
  let sharedUpd: ChanCreaUsage["sharedUpd"] = false;
  for (const rec of records) {
    // People and families on one side; the shared records the Sources and
    // media tools edit on the other. HEAD and TRLR carry no xref and are
    // nobody's record, so they set no convention.
    const isPersonal = rec.tag === "INDI" || rec.tag === "FAM";
    if (!isPersonal && !rec.xref) continue;
    for (const child of rec.children) {
      if (child.tag === "CHAN") {
        if (isPersonal) recordChan = true; else sharedChan = true;
      } else if (child.tag === "CREA") {
        if (isPersonal) recordCrea = true; else sharedCrea = true;
      } else if (child.tag === UPD_STAMP_TYPE) {
        if (isPersonal) recordUpd = "tag"; else sharedUpd = "tag";
      } else if (isChangeStampEvent(child)) {
        if (isPersonal) recordUpd ||= "event"; else sharedUpd ||= "event";
      }
      if (isPersonal && ALL_EVENT_TAGS.has(child.tag)) {
        for (const sub of child.children) {
          if (sub.tag === "CHAN") eventChan = true;
          else if (sub.tag === "CREA") eventCrea = true;
        }
      }
    }
  }
  return { recordChan, recordCrea, eventChan, eventCrea, recordUpd, sharedChan, sharedCrea, sharedUpd };
}

export function buildIndividual(record: GedNode, media: MediaLinks, sourceCtx: SourceContext, noteIndex: NoteIndex = new Map()): Individual {
  const names: Individual["names"] = [];
  const events: GedEvent[] = [];
  const childOf: string[] = [];
  const spouseOf: string[] = [];
  const links: string[] = [];
  const notes: string[] = [];
  const notesFull: string[] = [];
  const noteRefs: NoteRef[] = [];
  const sources: SourceCitation[] = [];
  const associations: Association[] = [];
  const uids: string[] = [];
  const fsids: string[] = [];
  const exids: ExternalId[] = [];
  let sex: Sex = "U";

  for (const child of record.children) {
    switch (child.tag) {
      case "_UID":
      case "UID":
        if (child.value?.trim()) uids.push(child.value.trim());
        break;
      case "_FID":
      case "_FSFTID":
        if (child.value?.trim()) fsids.push(child.value.trim());
        break;
      // GEDCOM 7's external id: a FamilySearch one joins the vendor-tag ids
      // above, every other kind is kept as it is (see gedcom/exid).
      case "EXID": {
        const exid = readExid(child);
        if (exid && isFsIdNode(child)) fsids.push(exid.id);
        else if (exid) exids.push(exid);
        break;
      }
      case "NAME":
        names.push(withNameTranslations(parseName(child.value, subTagMap(child)), child));
        break;
      case "SEX":
        sex = readSex(child);
        break;
      // `@VOID@` links to no family: the line stays in the raw tree, but it is
      // no relationship to follow (or to prune as broken).
      case "FAMC":
        if (child.value && !isVoidPointer(child.value)) childOf.push(child.value.trim());
        break;
      case "FAMS":
        if (child.value && !isVoidPointer(child.value)) spouseOf.push(child.value.trim());
        break;
      case "NOTE":
      case "SNOTE": {
        collectNote(child, noteIndex, media, notes, links, notesFull, noteRefs);
        break;
      }
      case "SOUR": {
        const citation = resolveSourceCitation(child, sourceCtx);
        if (citation) sources.push(citation);
        break;
      }
      case "ASSO":
      case "_ASSO": {
        const assoc = parseAssociation(child);
        if (assoc) associations.push(assoc);
        break;
      }
      default:
        // Event-borne links travel with the event; everything else is a
        // record-level link.
        if (INDI_EVENT_TAGS.has(child.tag) && !isChangeStampEvent(child)) {
          events.push(buildEvent(child, media, sourceCtx, noteIndex));
        } else if (!INDI_EVENT_TAGS.has(child.tag)) collectLinks(child, media, links);
    }
  }

  const indi: Individual = { id: record.xref!, names, sex, events, childOf, spouseOf, raw: record };
  if (uids.length) indi.uids = dedupe(uids);
  if (fsids.length) indi.fsids = dedupe(fsids);
  if (exids.length) indi.exids = exids;
  if (links.length) indi.links = dedupe(links);
  const editableIndiLinks = collectEditableLinks(record);
  if (editableIndiLinks.length) indi.editableLinks = dedupe(editableIndiLinks);
  const indiMediaLinks = collectMediaLinks(record, media);
  if (indiMediaLinks.length) indi.mediaLinks = dedupe(indiMediaLinks);
  if (notes.length) indi.notes = notes;
  if (notesFull.length && notesFull.join("\x1f") !== notes.join("\x1f")) indi.notesWithLinks = notesFull;
  if (noteRefs.length) indi.noteRefs = noteRefs;
  if (sources.length) indi.sources = sources;
  if (associations.length) {
    readAssocNotes(associations, noteIndex, media);
    indi.associations = associations;
  }
  if (isPrivateNode(record)) indi.private = true;
  const noEvents = negativeAssertionsOf(record);
  if (noEvents.length) indi.noEvents = noEvents;
  return indi;
}

export function buildFamily(record: GedNode, media: MediaLinks, sourceCtx: SourceContext, noteIndex: NoteIndex = new Map()): Family {
  const children: string[] = [];
  const events: GedEvent[] = [];
  const links: string[] = [];
  const notes: string[] = [];
  const notesFull: string[] = [];
  const noteRefs: NoteRef[] = [];
  const sources: SourceCitation[] = [];
  const associations: Association[] = [];
  let husband: string | undefined;
  let wife: string | undefined;

  for (const child of record.children) {
    switch (child.tag) {
      // `@VOID@` names no person — the slot is empty, as for an INDI's FAMC.
      case "HUSB":
        if (!isVoidPointer(child.value)) husband = child.value?.trim();
        break;
      case "WIFE":
        if (!isVoidPointer(child.value)) wife = child.value?.trim();
        break;
      case "CHIL":
        if (child.value && !isVoidPointer(child.value)) children.push(child.value.trim());
        break;
      case "NOTE":
      case "SNOTE": {
        collectNote(child, noteIndex, media, notes, links, notesFull, noteRefs);
        break;
      }
      case "SOUR": {
        const citation = resolveSourceCitation(child, sourceCtx);
        if (citation) sources.push(citation);
        break;
      }
      case "ASSO":
      case "_ASSO": {
        const assoc = parseAssociation(child);
        if (assoc) associations.push(assoc);
        break;
      }
      default:
        if (FAM_EVENT_TAGS.has(child.tag) && !isChangeStampEvent(child)) {
          events.push(buildEvent(child, media, sourceCtx, noteIndex));
        } else if (!FAM_EVENT_TAGS.has(child.tag)) collectLinks(child, media, links);
    }
  }

  const fam: Family = { id: record.xref!, children, events, raw: record };
  if (husband) fam.husband = husband;
  if (wife) fam.wife = wife;
  if (links.length) fam.links = dedupe(links);
  const editableFamLinks = collectEditableLinks(record);
  if (editableFamLinks.length) fam.editableLinks = dedupe(editableFamLinks);
  const famMediaLinks = collectMediaLinks(record, media);
  if (famMediaLinks.length) fam.mediaLinks = dedupe(famMediaLinks);
  if (notes.length) fam.notes = notes;
  if (notesFull.length && notesFull.join("\x1f") !== notes.join("\x1f")) fam.notesWithLinks = notesFull;
  if (noteRefs.length) fam.noteRefs = noteRefs;
  if (sources.length) fam.sources = sources;
  if (associations.length) {
    readAssocNotes(associations, noteIndex, media);
    fam.associations = associations;
  }
  if (isPrivateNode(record)) fam.private = true;
  const noEvents = negativeAssertionsOf(record);
  if (noEvents.length) fam.noEvents = noEvents;
  return fam;
}

/** The LDS-only parts of an ordinance: its temple, its status (with the date
 *  the status was set) and, on a sealing to parents, the family sealed to. */
function readOrdinance(node: GedNode, event: GedEvent): void {
  const temple = firstChild(node, "TEMP")?.value?.trim();
  if (temple) event.temple = temple;
  const stat = firstChild(node, "STAT");
  const status = stat?.value?.trim();
  if (status) event.status = status;
  const statusDate = stat && firstChild(stat, "DATE")?.value?.trim();
  if (statusDate) event.statusDate = statusDate;
  const famc = firstChild(node, "FAMC")?.value?.trim();
  if (famc && isPointer(famc) && !isVoidPointer(famc)) event.family = famc;
}

function buildEvent(node: GedNode, media: MediaLinks, sourceCtx: SourceContext, noteIndex: NoteIndex = new Map()): GedEvent {
  const event: GedEvent = { tag: node.tag };
  if (node.value?.trim()) event.value = node.value.trim();
  const dateNode = firstChild(node, "DATE");
  const placeNode = firstChild(node, "PLAC");
  const addrNode = firstChild(node, "ADDR");
  const typeNode = firstChild(node, "TYPE");
  const agncNode = firstChild(node, "AGNC");
  const causNode = firstChild(node, "CAUS");
  if (dateNode?.value) event.date = parseDate(dateNode.value);
  const time = dateNode && childValue(dateNode, "TIME")?.trim();
  if (time) event.time = time;
  const sortDate = nodeSortDate(node);
  if (sortDate) event.sortDate = sortDate;
  if (placeNode?.value) {
    event.place = parsePlace(placeNode.value);
    if (placeNode.reshapedFrom) event.place.originalRaw = placeNode.reshapedFrom;
    const coord = placeNodeCoord(placeNode);
    if (coord) event.place.coord = coord;
    const form = firstChild(placeNode, "FORM")?.value?.trim();
    if (form) event.place.form = form;
    const placeTr = translationsOf(placeNode);
    if (placeTr.length) event.place.translations = placeTr;
  }
  // The address as one string: the ADDR's own text, or its labelled lines
  // joined when the program wrote only those (see `address.ts`).
  const addrText = addressText(addrNode);
  if (addrText) {
    event.address = parsePlace(addrNode!.value?.trim() ? addrNode!.value : addrText);
    if (addrNode!.reshapedFrom) event.address.originalRaw = addrNode!.reshapedFrom;
  }
  const addrParts = readAddressParts(addrNode);
  if (addrParts) {
    event.addressParts = addrParts;
    const line = addrNode!.value?.trim();
    if (line) event.addressLine = addrNode!.value;
  }
  for (const c of node.children) {
    const contact = contactTagOf(c.tag);
    const v = c.value?.trim();
    if (!contact || !v) continue;
    const key = CONTACT_FIELD[contact];
    event[key] ??= v;
  }
  const ageNode = firstChild(node, "AGE");
  if (ageNode?.value?.trim()) event.age = ageNode.value.trim();
  // A family event's spouses carry their ages one level down. Only a HUSB/WIFE
  // *without* a pointer is that structure — the record-level HUSB is not an
  // event child, so nothing else can be met here.
  for (const [tag, key] of [["HUSB", "husbandAge"], ["WIFE", "wifeAge"]] as const) {
    const spouse = node.children.find((c) => c.tag === tag && !c.value?.trim());
    const v = spouse && firstChild(spouse, "AGE")?.value?.trim();
    if (v) event[key] = v;
  }
  if (typeNode?.value) event.type = typeNode.value.trim();
  if (agncNode?.value) event.agency = agncNode.value.trim();
  if (causNode?.value) event.cause = causNode.value.trim();
  if (LDS_ORDINANCE_TAGS.has(node.tag)) readOrdinance(node, event);
  const links = collectLinks(node, media);
  const noteNode = firstChild(node, NOTE_TAGS);
  if (noteNode) {
    const notePtr = noteNode.value?.trim() ?? "";
    if (isPointer(notePtr)) event.noteXref = notePtr;
    const text = resolveNoteText(noteNode, noteIndex, links);
    const noteStripped = text && stripNoteLinks(text);
    if (noteStripped) event.note = noteStripped;
    const noteFull = text && tidyNoteText(text);
    if (noteFull && noteFull !== noteStripped) event.noteWithLinks = noteFull;
  }
  // Every note the event carries, as editable references — `note` above is the
  // first one only, which is all the display projections ever wanted. GEDCOM
  // puts no limit on them, and one the editor cannot see is one it can lose.
  const eventNoteRefs: NoteRef[] = [];
  for (const child of childrenByTag(node, NOTE_TAGS)) {
    collectNote(child, noteIndex, media, [], links, [], eventNoteRefs);
  }
  if (eventNoteRefs.length) event.noteRefs = eventNoteRefs;
  if (links.length) event.links = dedupe(links);
  const editable = collectEditableLinks(node);
  if (editable.length) event.editableLinks = dedupe(editable);
  const mediaLinks = collectMediaLinks(node, media);
  if (mediaLinks.length) {
    event.mediaLinks = dedupe(mediaLinks);
    const titles = collectMediaTitles(node, media, sourceCtx);
    if (titles) event.mediaTitles = titles;
  }
  const associations = associationsIn(node);
  if (associations.length) {
    readAssocNotes(associations, noteIndex, media);
    event.associations = associations;
  }
  const sources = node.children
    .filter((c) => c.tag === "SOUR")
    .map((c) => resolveSourceCitation(c, sourceCtx))
    .filter((s): s is SourceCitation => !!s);
  if (sources.length) event.sources = sources;
  return event;
}

/** Map of OBJE record xref -> the URLs that record holds. */
export type MediaLinks = Map<string, string[]>;

/** One shared NOTE record's projection: its (CONT/CONC-folded) text plus its
 *  private flag (a private note's URLs are never surfaced as links). */
export interface NoteIndexEntry {
  text: string;
  private: boolean;
  /** The record's translations (`TRAN`), when it has any. */
  translations?: Translation[];
}

/** Map of top-level NOTE record xref -> its text + private flag. */
export type NoteIndex = Map<string, NoteIndexEntry>;

/** Tags whose value is, by convention, a link/URL even without a scheme: the
 *  editable link tags plus a media `FILE` line (detection only — a link edit
 *  never sweeps FILE). */
export const LINK_TAGS = new Set<string>([...EDITABLE_LINK_TAGS, "FILE"]);

// `URL_RE` and `stripTrailingPunct` live in `uri.ts` (the source resolver needs
// them too) and are re-exported here for their callers.
export { stripTrailingPunct, URL_RE } from "./uri";

/** Trim and tidy the lines of a note already reduced to plain text. */
function tidyLines(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * Drop URLs from note text that `collectLinks` already pulled out into a
 * `links` array, so the same URL doesn't also surface as a separate note
 * field to merge, then strip any HTML markup the note was pasted in with
 * (its own wrapping, and whatever wrapped the now-removed URL). Returns the
 * remaining text, or "" if nothing is left.
 */
export function stripNoteLinks(text: string): string {
  return tidyLines(noteToText(text).replace(URL_RE, ""));
}

/** A note reduced to its text — rich-text markup rendered as plain lines (see
 *  `noteHtml`) — with tidy whitespace. */
function tidyNoteText(text: string): string {
  return tidyLines(noteToText(text));
}

/**
 * Index every top-level multimedia (OBJE) record by its xref, mapping to the
 * URLs it contains (typically a single FILE line). Records reference these by
 * pointer, so this lets `collectLinks` resolve `OBJE @xref@` to a real URL.
 */
export function buildMediaLinks(records: GedNode[]): MediaLinks {
  const map: MediaLinks = new Map();
  for (const rec of records) {
    if (rec.tag !== "OBJE" || !rec.xref) continue;
    const links = dedupe(collectLinks(rec, map));
    if (links.length) map.set(rec.xref, links);
  }
  return map;
}

/** The tags a note line goes by: 5.5.1's `NOTE` and GEDCOM 7's shared-note
 *  pointer `SNOTE`. */
export const NOTE_TAGS: readonly string[] = ["NOTE", "SNOTE"];

/**
 * Index every top-level NOTE record by its xref, mapping to the text it holds
 * (CONT/CONC continuations are already folded into the record's value by the
 * parser). Records reference these by pointer (`1 NOTE @xref@`), so this lets
 * `resolveNoteText` turn that pointer back into real text instead of leaking
 * the raw `@N@` id into the UI. GEDCOM 7 spells the shared record and its
 * pointer `SNOTE` (`0 @N1@ SNOTE text`, `1 SNOTE @N1@`); both read alike.
 */
export function buildNoteIndex(records: GedNode[]): NoteIndex {
  const map: NoteIndex = new Map();
  for (const rec of records) {
    if (NOTE_TAGS.includes(rec.tag) && rec.xref && rec.value !== undefined) {
      const translations = translationsOf(rec);
      map.set(rec.xref, { text: rec.value, private: isPrivateNode(rec), ...(translations.length ? { translations } : {}) });
    }
  }
  return map;
}

/**
 * Resolve a NOTE line's text: an inline note returns its own value, while a
 * `@N@` pointer is dereferenced through the shared note index. A pointer's URLs
 * live in the referenced record (not under this node), so when `links` is given
 * any URLs in the resolved text are collected into it.
 */
function resolveNoteText(node: GedNode, notes: NoteIndex, links?: string[]): string | undefined {
  const v = node.value?.trim();
  if (!(v && isPointer(v))) return node.value;
  const entry = notes.get(v);
  // A private note's URLs stay inside the note — never surfaced as links,
  // where they'd be one click from becoming a (public) source citation.
  if (entry && !entry.private && links) {
    // A rich-text note keeps its addresses HTML-escaped (`&amp;` between the
    // query parameters); the harvested link must be the address itself.
    const text = isHtmlNote(entry.text) ? decodeEntities(entry.text) : entry.text;
    for (const m of text.match(URL_RE) ?? []) links.push(stripTrailingPunct(m));
  }
  return entry?.text;
}

/** Collect one record-level NOTE's stripped text and any URLs it carries.
 *  `outFull` receives the same note with its URLs kept in place, for
 *  renderers (reports) that show the note verbatim; `outRefs` receives the
 *  editable reference (verbatim text + shared-record identity + private
 *  flag) — including notes the display arrays drop because only a URL
 *  remains after stripping, so an edit round-trip can't silently discard
 *  them. */
/**
 * Read each association's own notes, which both dialects allow it to carry.
 *
 * Runs here rather than in `parseAssociation` because resolving a shared-note
 * pointer to its text needs the file-wide note index, which the parser has no
 * business knowing about. The note's URLs stay the note's own: they are not
 * harvested into the record's link list, where a godparent's remark would read
 * as a source for the person.
 */
function readAssocNotes(associations: Association[], notes: NoteIndex, media: MediaLinks): void {
  for (const assoc of associations) {
    const refs: NoteRef[] = [];
    for (const child of assoc.raw.children) {
      if (child.tag === "NOTE" || child.tag === "SNOTE") collectNote(child, notes, media, [], [], [], refs);
    }
    if (refs.length) assoc.noteRefs = refs;
  }
}

function collectNote(
  node: GedNode, notes: NoteIndex, media: MediaLinks,
  out: string[], links: string[], outFull: string[], outRefs?: NoteRef[],
): void {
  const ptr = node.value?.trim() ?? "";
  const isPtr = isPointer(ptr);
  const isPrivate = isPtr ? !!notes.get(ptr)?.private : isPrivateNode(node);
  const text = resolveNoteText(node, notes, links);
  const stripped = text && stripNoteLinks(text);
  if (stripped) out.push(stripped);
  const full = text && tidyNoteText(text);
  if (full) outFull.push(full);
  // A pointer is kept even when it doesn't resolve (dangling refs are policed
  // at save time, not silently dropped by a note edit round-trip).
  if (outRefs) {
    const translations = isPtr ? notes.get(ptr)?.translations : translationsOf(node);
    const tr = translations?.length ? { translations } : {};
    if (isPtr) outRefs.push({ xref: ptr, text: text ?? "", ...(isPrivate ? { private: true } : {}), ...tr });
    else if (node.value?.trim()) outRefs.push({ text: node.value, ...(isPrivate ? { private: true } : {}), ...tr });
  }
  // An inline note may also carry sub-tags / embedded media; let collectLinks
  // walk it (unless the note is private — see resolveNoteText). A pointer
  // note's URLs were already handled above.
  if (!isPtr && !isPrivate) collectLinks(node, media, links);
}

/**
 * Recursively gather every URL reachable under `node` (its own value plus all
 * descendants). Link-bearing tags (WWW/URL/_LINK/OBJE.FILE …) contribute their
 * whole value; an `OBJE @xref@` pointer is resolved through the shared media
 * index; any other line contributes http(s) URLs found inside its text (e.g. a
 * URL mentioned in a NOTE).
 */
/**
 * Values of the node's own direct link-bearing tags (WWW/URL/… — the set a
 * link edit rewrites, see `EDITABLE_LINK_TAGS`). This is the editable subset
 * of {@link collectLinks}'s harvest: URLs pulled out of note text, shared
 * media records or nested lines have their home elsewhere — rewriting them
 * as WWW lines would duplicate them, and "removing" them would be a no-op,
 * so the editors must never be handed those.
 */
function collectEditableLinks(node: GedNode): string[] {
  const out: string[] = [];
  for (const child of node.children) {
    const v = child.value?.trim();
    if (v && EDITABLE_LINK_TAGS.includes(child.tag as (typeof EDITABLE_LINK_TAGS)[number])) {
      out.push(v.replace(/\n/g, ""));
    }
  }
  return out;
}

/**
 * URLs resolved from `node`'s own direct `OBJE` children — a pointer child
 * through the shared media index, an inline child from its subtree. These are
 * the removable middle ground between editable WWW lines and note-harvested
 * URLs: deleting the `OBJE` link really removes them (see GedEvent.mediaLinks).
 */
function collectMediaLinks(node: GedNode, media: MediaLinks): string[] {
  const out: string[] = [];
  for (const child of node.children) {
    if (child.tag !== "OBJE") continue;
    const v = child.value?.trim();
    if (v && isPointer(v)) out.push(...(media.get(v) ?? []));
    else collectLinks(child, media, out);
  }
  return out;
}

/** The titles of `node`'s own `OBJE` links, keyed by each link's URL — a shared
 *  media record's from the source context's index, an inline one's from its own
 *  `TITL`. Undefined when none of them is titled, the usual case. */
function collectMediaTitles(node: GedNode, media: MediaLinks, sourceCtx: SourceContext): Record<string, string> | undefined {
  let out: Record<string, string> | undefined;
  for (const child of node.children) {
    if (child.tag !== "OBJE") continue;
    const v = child.value?.trim();
    const pointer = v && isPointer(v) ? v : undefined;
    const title = pointer ? sourceCtx.objeIndex.get(pointer)?.title : objeInfoOf(child).title;
    if (!title) continue;
    for (const url of pointer ? media.get(pointer) ?? [] : collectLinks(child, media)) {
      (out ??= {})[url] ??= title;
    }
  }
  return out;
}

function collectLinks(node: GedNode, media: MediaLinks, out: string[] = []): string[] {
  const v = node.value?.trim();
  if (v) {
    if (node.tag === "OBJE" && isPointer(v)) {
      const resolved = media.get(v);
      if (resolved) out.push(...resolved);
    } else if (LINK_TAGS.has(node.tag) && looksLikeUrl(v)) {
      // A link-bearing tag's value is the URL itself, so a CONT-introduced
      // line break partway through it is a wrap artifact, not real content;
      // drop it to keep the URL intact (CONC wraps never produce one, since
      // they're folded into the value with no separator).
      out.push(v.replace(/\n/g, ""));
    } else {
      const found = v.match(URL_RE);
      if (found) for (const m of found) out.push(stripTrailingPunct(m));
    }
  }
  for (const child of node.children) {
    // `EXID > TYPE` is a vocabulary URI, not a link: it is 7.0's way of saying
    // *what kind* of identifier the EXID is — "https://gedcom.io/terms/v7/RIN"
    // for what 5.5.1 wrote as a RIN, which this app's own upgrade writes (see
    // EXID_TYPE_URI in normalize/migrate). The same string stands on every
    // record carrying that kind of id and points at no research anyone did, so
    // harvesting it hung a 🔗 on the person and offered it as a source to merge.
    if (node.tag === "EXID" && child.tag === "TYPE") continue;
    collectLinks(child, media, out);
  }
  return out;
}

/** De-duplicate links case-insensitively while preserving first-seen order. */
function dedupe(links: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of links) {
    const key = l.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out;
}

function subTagMap(node: GedNode): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of node.children) {
    if (c.value !== undefined) map.set(c.tag, c.value.trim());
  }
  return map;
}

/** A parsed name with the translations its `NAME` line carries attached. */
function withNameTranslations(name: PersonName, node: GedNode): PersonName {
  const translations = nameTranslationsOf(node);
  if (translations.length) name.translations = translations;
  return name;
}
