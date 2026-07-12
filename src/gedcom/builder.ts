import { parseDate } from "./date";
import { parseName } from "./name";
import { parsePlace } from "./place";
import { firstChild } from "./node";
import { buildSourceContext, resolveSourceCitation, type SourceContext } from "./source";
import { isPointer, looksLikeUrl } from "./uri";

// Re-exported so existing importers (merge, normalize) keep their import path.
export { looksLikeUrl };
import type {
  ChanCreaUsage,
  Dataset,
  Family,
  GedEvent,
  GedNode,
  Individual,
  ParseResult,
  SourceCitation,
  Sex,
} from "./types";

import { ALL_EVENT_TAGS, FAM_EVENT_TAGS, INDI_EVENT_TAGS } from "./eventTags";

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
    chanCreaUsage: { recordChan: false, recordCrea: false, eventChan: false, eventCrea: false },
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
  outer: for (const rec of records) {
    if (rec.tag !== "INDI" && rec.tag !== "FAM") continue;
    for (const child of rec.children) {
      if (child.tag === "CHAN") recordChan = true;
      else if (child.tag === "CREA") recordCrea = true;
      if (ALL_EVENT_TAGS.has(child.tag)) {
        for (const sub of child.children) {
          if (sub.tag === "CHAN") eventChan = true;
          else if (sub.tag === "CREA") eventCrea = true;
        }
      }
      if (recordChan && recordCrea && eventChan && eventCrea) break outer;
    }
  }
  return { recordChan, recordCrea, eventChan, eventCrea };
}

export function buildIndividual(record: GedNode, media: MediaLinks, sourceCtx: SourceContext, noteIndex: NoteIndex = new Map()): Individual {
  const names: Individual["names"] = [];
  const events: GedEvent[] = [];
  const childOf: string[] = [];
  const spouseOf: string[] = [];
  const links: string[] = [];
  const notes: string[] = [];
  const notesFull: string[] = [];
  const sources: SourceCitation[] = [];
  let sex: Sex = "U";

  for (const child of record.children) {
    switch (child.tag) {
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
        collectNote(child, noteIndex, media, notes, links, notesFull);
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
        if (INDI_EVENT_TAGS.has(child.tag)) events.push(buildEvent(child, media, sourceCtx, noteIndex));
        else collectLinks(child, media, links);
    }
  }

  const indi: Individual = { id: record.xref!, names, sex, events, childOf, spouseOf, raw: record };
  if (links.length) indi.links = dedupe(links);
  if (notes.length) indi.notes = notes;
  if (notesFull.length && notesFull.join("\x1f") !== notes.join("\x1f")) indi.notesWithLinks = notesFull;
  if (sources.length) indi.sources = sources;
  return indi;
}

export function buildFamily(record: GedNode, media: MediaLinks, sourceCtx: SourceContext, noteIndex: NoteIndex = new Map()): Family {
  const children: string[] = [];
  const events: GedEvent[] = [];
  const links: string[] = [];
  const notes: string[] = [];
  const notesFull: string[] = [];
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
        collectNote(child, noteIndex, media, notes, links, notesFull);
        break;
      }
      case "SOUR": {
        const citation = resolveSourceCitation(child, sourceCtx);
        if (citation) sources.push(citation);
        break;
      }
      default:
        if (FAM_EVENT_TAGS.has(child.tag)) events.push(buildEvent(child, media, sourceCtx, noteIndex));
        else collectLinks(child, media, links);
    }
  }

  const fam: Family = { id: record.xref!, children, events, raw: record };
  if (husband) fam.husband = husband;
  if (wife) fam.wife = wife;
  if (links.length) fam.links = dedupe(links);
  if (notes.length) fam.notes = notes;
  if (notesFull.length && notesFull.join("\x1f") !== notes.join("\x1f")) fam.notesWithLinks = notesFull;
  if (sources.length) fam.sources = sources;
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
    const text = resolveNoteText(noteNode, noteIndex, links);
    const noteStripped = text && stripNoteLinks(text);
    if (noteStripped) event.note = noteStripped;
    const noteFull = text && tidyNoteText(text);
    if (noteFull && noteFull !== noteStripped) event.noteWithLinks = noteFull;
  }
  if (links.length) event.links = dedupe(links);
  const sources = node.children
    .filter((c) => c.tag === "SOUR")
    .map((c) => resolveSourceCitation(c, sourceCtx))
    .filter((s): s is SourceCitation => !!s);
  if (sources.length) event.sources = sources;
  return event;
}

/** Map of OBJE record xref -> the URLs that record holds. */
export type MediaLinks = Map<string, string[]>;

/** Map of top-level NOTE record xref -> its (CONT/CONC-folded) text. */
export type NoteIndex = Map<string, string>;

/** Tags whose value is, by convention, a link/URL even without a scheme. */
export const LINK_TAGS = new Set(["WWW", "URL", "_URL", "_LINK", "_WEBTAG", "FILE"]);

/** Matches one or more http(s) URLs embedded anywhere in a line value. */
const URL_RE = /https?:\/\/[^\s<>"]+/gi;

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
function stripNoteLinks(text: string): string {
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
    if (rec.tag === "NOTE" && rec.xref && rec.value !== undefined) map.set(rec.xref, rec.value);
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
  const text = notes.get(v);
  if (text && links) for (const m of text.match(URL_RE) ?? []) links.push(stripTrailingPunct(m));
  return text;
}

/** Collect one record-level NOTE's stripped text and any URLs it carries.
 *  `outFull` receives the same note with its URLs kept in place, for
 *  renderers (reports) that show the note verbatim. */
function collectNote(node: GedNode, notes: NoteIndex, media: MediaLinks, out: string[], links: string[], outFull: string[]): void {
  const isPtr = isPointer(node.value?.trim() ?? "");
  const text = resolveNoteText(node, notes, links);
  const stripped = text && stripNoteLinks(text);
  if (stripped) out.push(stripped);
  const full = text && tidyNoteText(text);
  if (full) outFull.push(full);
  // An inline note may also carry sub-tags / embedded media; let collectLinks
  // walk it. A pointer note has no such children, and its URLs were already
  // pulled from the resolved text above.
  if (!isPtr) collectLinks(node, media, links);
}

/**
 * Recursively gather every URL reachable under `node` (its own value plus all
 * descendants). Link-bearing tags (WWW/URL/_LINK/OBJE.FILE …) contribute their
 * whole value; an `OBJE @xref@` pointer is resolved through the shared media
 * index; any other line contributes http(s) URLs found inside its text (e.g. a
 * URL mentioned in a NOTE).
 */
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
  for (const child of node.children) collectLinks(child, media, out);
  return out;
}

/** Drop trailing punctuation a URL regex may swallow from surrounding prose. */
function stripTrailingPunct(url: string): string {
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
