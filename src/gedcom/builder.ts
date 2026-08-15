import { parseDate } from "./date";
import { parseName } from "./name";
import { parsePlace, placeNodeCoord } from "./place";
import { firstChild } from "./node";
import { buildSourceContext, resolveSourceCitation, type SourceContext } from "./source";
import { isPointer, looksLikeUrl } from "./uri";
import { isPrivateNode } from "./private";

// Re-exported so existing importers (merge, normalize) keep their import path.
export { looksLikeUrl };
import type {
  ChanCreaUsage,
  Dataset,
  Family,
  GedEvent,
  GedNode,
  Individual,
  NoteRef,
  ParseResult,
  SourceCitation,
  Sex,
} from "./types";

import { ALL_EVENT_TAGS, FAM_EVENT_TAGS, INDI_EVENT_TAGS, isChangeStampEvent } from "./eventTags";
import { UPD_STAMP_TYPE } from "./vendorTags";
import { EDITABLE_LINK_TAGS } from "./edit/shared";

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
  const individuals = new Map<string, Individual>();
  const families = new Map<string, Family>();
  // Shared multimedia (OBJE) records hold their URL in a FILE line; records
  // attach them by pointer (`1 OBJE @xref@`), so resolve those up front.
  const media = buildMediaLinks(parsed.records);
  // Likewise, source (SOUR) and repository (REPO) records are shared and
  // referenced by pointer from event-level citations.
  const sourceCtx = buildSourceContext(parsed.records);
  // Shared NOTE records hold their text; records reference them by pointer
  // (`1 NOTE @xref@`), so resolve those to real text up front.
  const notes = buildNoteIndex(parsed.records);

  // Duplicate xrefs last-win in the Maps below (and in every shared-record
  // index above), leaving matching/merge working against a half-hidden record.
  // Surface that — and drop the shadowed raw records too, or both would still
  // serialize and a saved file would carry the same id twice (strict importers
  // reject that, or bind every pointer to whichever copy they read last).
  const seenXrefs = new Set<string>();
  let hasDuplicate = false;
  for (const record of parsed.records) {
    if (!record.xref) continue;
    if (seenXrefs.has(record.xref)) {
      hasDuplicate = true;
      parsed.warnings.push({
        kind: "structure",
        message: `Duplicate xref ${record.xref}: a later ${record.tag} record overrides an earlier record with the same id; the earlier record is dropped.`,
      });
    } else {
      seenXrefs.add(record.xref);
    }
  }
  let records = parsed.records;
  if (hasDuplicate) {
    const lastIndex = new Map<string, number>();
    records.forEach((r, i) => {
      if (r.xref) lastIndex.set(r.xref, i);
    });
    records = records.filter((r, i) => !r.xref || lastIndex.get(r.xref) === i);
  }

  for (const record of records) {
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
  const uids: string[] = [];
  const fsids: string[] = [];
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
      case "NAME":
        names.push(parseName(child.value, subTagMap(child)));
        break;
      case "SEX":
        sex = normalizeSex(child.value);
        break;
      case "FAMC":
        if (child.value) childOf.push(child.value.trim());
        break;
      case "FAMS":
        if (child.value) spouseOf.push(child.value.trim());
        break;
      case "NOTE": {
        collectNote(child, noteIndex, media, notes, links, notesFull, noteRefs);
        break;
      }
      case "SOUR": {
        const citation = resolveSourceCitation(child, sourceCtx);
        if (citation) sources.push(citation);
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
  if (links.length) indi.links = dedupe(links);
  const editableIndiLinks = collectEditableLinks(record);
  if (editableIndiLinks.length) indi.editableLinks = dedupe(editableIndiLinks);
  if (notes.length) indi.notes = notes;
  if (notesFull.length && notesFull.join("\x1f") !== notes.join("\x1f")) indi.notesWithLinks = notesFull;
  if (noteRefs.length) indi.noteRefs = noteRefs;
  if (sources.length) indi.sources = sources;
  if (isPrivateNode(record)) indi.private = true;
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
  let husband: string | undefined;
  let wife: string | undefined;

  for (const child of record.children) {
    switch (child.tag) {
      case "HUSB":
        husband = child.value?.trim();
        break;
      case "WIFE":
        wife = child.value?.trim();
        break;
      case "CHIL":
        if (child.value) children.push(child.value.trim());
        break;
      case "NOTE": {
        collectNote(child, noteIndex, media, notes, links, notesFull, noteRefs);
        break;
      }
      case "SOUR": {
        const citation = resolveSourceCitation(child, sourceCtx);
        if (citation) sources.push(citation);
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
  if (notes.length) fam.notes = notes;
  if (notesFull.length && notesFull.join("\x1f") !== notes.join("\x1f")) fam.notesWithLinks = notesFull;
  if (noteRefs.length) fam.noteRefs = noteRefs;
  if (sources.length) fam.sources = sources;
  if (isPrivateNode(record)) fam.private = true;
  return fam;
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
  if (placeNode?.value) {
    event.place = parsePlace(placeNode.value);
    if (placeNode.reshapedFrom) event.place.originalRaw = placeNode.reshapedFrom;
    const coord = placeNodeCoord(placeNode);
    if (coord) event.place.coord = coord;
    const form = firstChild(placeNode, "FORM")?.value?.trim();
    if (form) event.place.form = form;
  }
  if (addrNode?.value) {
    event.address = parsePlace(addrNode.value);
    if (addrNode.reshapedFrom) event.address.originalRaw = addrNode.reshapedFrom;
  }
  if (typeNode?.value) event.type = typeNode.value.trim();
  if (agncNode?.value) event.agency = agncNode.value.trim();
  if (causNode?.value) event.cause = causNode.value.trim();
  const links = collectLinks(node, media);
  const noteNode = firstChild(node, "NOTE");
  if (noteNode) {
    const notePtr = noteNode.value?.trim() ?? "";
    if (isPointer(notePtr)) event.noteXref = notePtr;
    const text = resolveNoteText(noteNode, noteIndex, links);
    const noteStripped = text && stripNoteLinks(text);
    if (noteStripped) event.note = noteStripped;
    const noteFull = text && tidyNoteText(text);
    if (noteFull && noteFull !== noteStripped) event.noteWithLinks = noteFull;
  }
  if (links.length) event.links = dedupe(links);
  const editable = collectEditableLinks(node);
  if (editable.length) event.editableLinks = dedupe(editable);
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
}

/** Map of top-level NOTE record xref -> its text + private flag. */
export type NoteIndex = Map<string, NoteIndexEntry>;

/** Tags whose value is, by convention, a link/URL even without a scheme. */
export const LINK_TAGS = new Set(["WWW", "URL", "_URL", "_LINK", "_WEBTAG", "FILE"]);

/** Matches one or more http(s) URLs embedded anywhere in a line value.
 *  Shared with citationParse — one spelling of "what counts as a URL". */
export const URL_RE = /https?:\/\/[^\s<>"]+/gi;

/** Closing/void tags that represent a line break in rich-text-pasted note markup. */
const HTML_BLOCK_BREAK_RE = /<\/(?:p|div|li|h[1-6]|blockquote)>|<br\s*\/?>/gi;

/**
 * Recognized rich-text tags (and their closes), e.g. those a word processor
 * or note app leaves behind when a note is pasted in. Deliberately a
 * whitelist rather than "any `<...>`", so a stray "<unknown>" placeholder in
 * real note text isn't mistaken for markup.
 */
const HTML_TAG_RE = /<\/?(?:p|div|span|a|br|b|i|u|em|strong|ul|ol|li|h[1-6]|blockquote)\b[^>]*>/gi;

/** Convert rich-text HTML markup into plain text: block closes/`<br>` become line breaks, then tags are dropped. */
function stripHtmlMarkup(text: string): string {
  return text.replace(HTML_BLOCK_BREAK_RE, "\n").replace(HTML_TAG_RE, "");
}

/** Strip pasted-in HTML markup and tidy whitespace, keeping the text itself. */
function tidyNoteText(text: string): string {
  return stripHtmlMarkup(text)
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
  return tidyNoteText(text.replace(URL_RE, ""));
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

/**
 * Index every top-level NOTE record by its xref, mapping to the text it holds
 * (CONT/CONC continuations are already folded into the record's value by the
 * parser). Records reference these by pointer (`1 NOTE @xref@`), so this lets
 * `resolveNoteText` turn that pointer back into real text instead of leaking
 * the raw `@N@` id into the UI.
 */
export function buildNoteIndex(records: GedNode[]): NoteIndex {
  const map: NoteIndex = new Map();
  for (const rec of records) {
    if (rec.tag === "NOTE" && rec.xref && rec.value !== undefined) {
      map.set(rec.xref, { text: rec.value, private: isPrivateNode(rec) });
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
    for (const m of entry.text.match(URL_RE) ?? []) links.push(stripTrailingPunct(m));
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
    if (isPtr) outRefs.push({ xref: ptr, text: text ?? "", ...(isPrivate ? { private: true } : {}) });
    else if (node.value?.trim()) outRefs.push({ text: node.value, ...(isPrivate ? { private: true } : {}) });
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

/** Drop trailing punctuation a URL regex may swallow from surrounding prose. */
export function stripTrailingPunct(url: string): string {
  return url.replace(/[.,;:)\]}>"']+$/, "");
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

function normalizeSex(value: string | undefined): Sex {
  const v = value?.trim().toUpperCase();
  return v === "M" || v === "F" ? v : "U";
}
