import type { GedNode } from "../../gedcom/types";
import { memoOnContent } from "../../gedcom/edit/cache";
import { childrenByTag, childText, cloneNode, firstChild, nodeFingerprint } from "../../gedcom/node";
import {
  EVENT_CHILD_ORDER,
  FAM_CHILD_ORDER,
  INDI_CHILD_ORDER,
  insertGrouped,
  insertOrdered,
  insertRecord,
  nextXref,
} from "../../gedcom/edit/shared";
import { detectPlaceLayout } from "../../normalize/profile";
import { FAM_EVENT_TAGS, INDI_EVENT_TAGS } from "../../gedcom/eventTags";
import {
  type BookType,
  MEDIA_TRAILING,
  type ReshapeCounts,
  type ReshapeEnrichment,
  type ReshapeGroup,
  type ReshapeMeta,
  type ReshapeOptions,
  type ReshapeShape,
  type ReshapeSite,
  SOUR_TRAILING,
} from "./model";
import {
  buildGroups,
  foldMergedGroups,
  isSettledPointer,
  type RelocationContext,
  relocationTarget,
  resolveFormatOptions,
  SITE_BOOK_TYPE,
  sourcesHoldingPages,
} from "./report";
import { baptismTargetTag, classifyBookType, type ScanHit, scanOccurrences } from "./scan";
import { pageObjeTitle, parseMatriculaUrl, placeholderMediaTitle, recognizeSourceUrl, siteTitle } from "./urls";
import { addObjeToSource, createSourceRecord, SOUR_FIELD_TRAILING } from "../../gedcom/edit/sources";
import { dateFixContext, type DateFixContext, proposeDateFix } from "../fixDates";
import { normalizeDateString } from "../../normalize/date";
import { splitFsRegisters, yearSpan } from "./enrich";
import type { NormChange, SourceLayout } from "../../normalize/types";
import {
  buildObjeIndex,
  detectSourceCoverage,
  looseKey,
  repoLinkWanted,
  sourceTitle,
  writesCallNumbers,
} from "../../gedcom/source";
import {
  countryCodeOfName,
  countryFacetName,
  countryNameOf,
  foldCountryName,
  placeCountryFacet,
  stateOf,
  titleCountryFacet,
} from "../../geo/placeCountry";
import { familySearchImageIndex, familySearchPageUrl, linkKey, parseFamilySearchUrl } from "../../normalize/links";

// ---------------------------------------------------------------------------
// Apply

/** Remove one URL from free text, tidying leftover artifacts conservatively —
 *  never rewrapping or reformatting the user's remaining prose. */
function removeUrlFromText(text: string, url: string): string {
  return (
    text
      .replace(url, "")
      .replace(/\(\s*\)/g, "")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/^[\s:–—,-]+|[\s:–—,-]+$/g, "")
      // An Ancestry-style "…; URL: <link>" tail leaves its bare label
      // dangling once the link is gone.
      .replace(/[\s;,:]*\bURL$/i, "")
  );
}

/** Whether leftover note text still says anything (letters or digits). */
/** A citation's own PAGE text with the link's page number worked in — the
 *  reader's words ("line 12") are evidence too, so they stay beside it
 *  ("9, line 12"), the way a PAGE's prose survives its URL being swapped for
 *  the page. A text already naming that page, or holding the link itself
 *  (swapped in place), needs no prefix. */
function withPage(text: string, page: string, url: string): string {
  if (text.includes(url)) return text.replace(url, page).replace(/[ \t]{2,}/g, " ").trim();
  const escaped = page.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "u").test(text)) return text;
  return `${page}, ${text.trim()}`;
}

function hasContent(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

function spliceChild(parent: GedNode, child: GedNode): boolean {
  const i = parent.children.indexOf(child);
  if (i === -1) return false;
  parent.children.splice(i, 1);
  return true;
}

/** Attach a `SOUR @x@` citation (+PAGE/QUAY) unless the same source+page is
 *  already cited on the container — dedupes repeated links and keeps the whole
 *  apply idempotent. */
function attachCitation(
  container: GedNode,
  sourceXref: string,
  page: string | undefined,
  quay: string | undefined,
  order: string[],
): boolean {
  const existing = childrenByTag(container, "SOUR").find(
    (c) => c.value?.trim() === sourceXref && (childText(c, "PAGE") ?? "") === (page ?? ""),
  );
  if (existing) {
    // The occurrence folds into this citation — the chosen quality still
    // applies to it. Filling a MISSING QUAY is an enrich; one already set is
    // the user's data and stays.
    if (quay && !firstChild(existing, "QUAY")) {
      existing.children.push({ level: existing.level + 1, tag: "QUAY", value: quay, children: [] });
    }
    return false;
  }
  const citation: GedNode = { level: container.level + 1, tag: "SOUR", value: sourceXref, children: [] };
  if (page) citation.children.push({ level: container.level + 2, tag: "PAGE", value: page, children: [] });
  if (quay) citation.children.push({ level: container.level + 2, tag: "QUAY", value: quay, children: [] });
  insertOrdered(container, citation, order);
  return true;
}

/** Diacritic- and case-insensitive comparison key for a place segment. */
function placeSegmentKey(segment: string): string {
  return segment
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();
}

/**
 * Resolve a fetched or URL-derived place against the places the file already
 * uses: the input's first segment is matched (diacritic-insensitively) against
 * the first segment of every existing `PLAC` value, and the file's most
 * frequent full value wins — so "Žabnica, Slovenia" from a grave page, or the
 * diacritic-less slug guess "Sentjur Pri Celju", becomes the file's own
 * "Žabnica,Kranj,Slovenia" in its established place format.
 */
function buildPlaceResolver(records: GedNode[]): {
  resolve: (place: string | undefined) => string | undefined;
  /** The file keeps address detail in separate `ADDR` lines beside `PLAC`. */
  structuredAddr: boolean;
} {
  const bySegment = new Map<string, Map<string, number>>();
  const placeValues: string[] = [];
  let addrCount = 0;
  const walk = (n: GedNode): void => {
    for (const c of n.children) {
      if (c.tag === "ADDR") addrCount++;
      const full = c.tag === "PLAC" ? c.value?.trim() : undefined;
      if (full) {
        placeValues.push(full);
        const key = placeSegmentKey(full.split(",")[0]);
        if (key) {
          let values = bySegment.get(key);
          if (!values) bySegment.set(key, (values = new Map()));
          values.set(full, (values.get(full) ?? 0) + 1);
        }
      }
      walk(c);
    }
  };
  for (const r of records) walk(r);
  const best = new Map<string, string>();
  for (const [key, values] of bySegment) {
    let top: string | undefined;
    let topCount = 0;
    for (const [value, count] of values) {
      if (count > topCount) {
        top = value;
        topCount = count;
      }
    }
    if (top) best.set(key, top);
  }
  return {
    resolve: (place) => {
      if (!place) return place;
      return best.get(placeSegmentKey(place.split(",")[0])) ?? place;
    },
    structuredAddr: detectPlaceLayout(placeValues, addrCount) === "structured-addr",
  };
}

/** The file-format place resolver as a standalone function — the Add Source
 *  dialog uses it so the Kraj field shows the same resolved value ("Ljubljana"
 *  → "Ljubljana,Ljubljana,Slovenia") that commit/cleanup will write. */
export function makePlaceResolver(records: GedNode[]): (place: string | undefined) => string | undefined {
  return buildPlaceResolver(records).resolve;
}

/**
 * Where a source added on the *person* should actually land when the file
 * keeps its citations on events (more event-level `SOUR` citations than
 * record-level ones — a citation-less file counts as event-preferring, the
 * cleanup tool's own default): the event matching the source's register/record
 * type — baptism book → BIRT/BAPM (the file's habit), marriage book → the
 * sole family's MARR, death record → DEAT, grave → BURI. Undefined = keep the
 * record-level placement.
 */
/** The file's own citation-placement habit: whether existing citations sit
 *  mostly on records or on events. */
export function detectCitationPlacement(records: GedNode[]): "event" | "record" {
  // A whole-file count, asked per citation placed: once per state of the file.
  return memoOnContent(records, "citationPlacement", () => countCitationPlacement(records));
}

function countCitationPlacement(records: GedNode[]): "event" | "record" {
  let recordLevel = 0;
  let eventLevel = 0;
  for (const rec of records) {
    if (rec.tag !== "INDI" && rec.tag !== "FAM") continue;
    const eventTags = rec.tag === "INDI" ? INDI_EVENT_TAGS : FAM_EVENT_TAGS;
    for (const child of rec.children) {
      if (child.tag === "SOUR" && child.value) recordLevel++;
      else if (eventTags.has(child.tag)) eventLevel += childrenByTag(child, "SOUR").length;
    }
  }
  return recordLevel > eventLevel ? "record" : "event";
}

export function smartCitationTarget(
  records: GedNode[],
  site: ReshapeSite,
  title: string | undefined,
  opts: { citations?: "event" | "record" | "auto"; baptism?: "BIRT" | "BAPM" | "auto" } = {},
): { eventTag: string; onFam: boolean } | undefined {
  // Placement override: "record" pins citations to the record level; "event"
  // skips the file-habit gate; "auto"/absent follows the file's majority.
  if (opts.citations === "record") return undefined;
  if (opts.citations !== "event" && detectCitationPlacement(records) === "record") return undefined;

  const bookType = SITE_BOOK_TYPE[site] ?? classifyBookType([title]);
  if (bookType === "unknown") return undefined;
  if (bookType === "baptism") {
    const tag = opts.baptism && opts.baptism !== "auto" ? opts.baptism : baptismTargetTag(records);
    return { eventTag: tag, onFam: false };
  }
  if (bookType === "marriage") return { eventTag: "MARR", onFam: true };
  if (bookType === "death") return { eventTag: "DEAT", onFam: false };
  return { eventTag: "BURI", onFam: false };
}

/** Stable identity of one occurrence, for matching a report member to its
 *  re-scanned apply-time hit (per-citation QUAY overrides). */
function occurrenceQuayKey(
  recordXref: string,
  shape: ReshapeShape,
  eventTag: string | undefined,
  eventIndex: number | undefined,
  url: string,
): string {
  return [recordXref, shape, eventTag ?? "", eventIndex ?? "", url].join("|");
}

/** Citation child order for a container: record-level vs event-level. */
function childOrderFor(container: GedNode, rec: GedNode): string[] {
  if (container !== rec) return EVENT_CHILD_ORDER;
  return rec.tag === "FAM" ? FAM_CHILD_ORDER : INDI_CHILD_ORDER;
}

/** Recompute `level` down a subtree after a node moves containers. */
function relevel(node: GedNode, level: number): void {
  node.level = level;
  for (const c of node.children) relevel(c, level + 1);
}

/** What sits at the tail of a media record's `FILE` and of the record — a
 *  carried line goes in front of it. */
const MEDIA_STAMPS = ["CHAN", "CREA", "_UPD"] as const;

/**
 * Copy an inline `OBJE` block's own lines onto the media record that now holds
 * its page: a title that says something (over the one this run made up, never
 * over a record's own), the `FILE`'s form and other sub-lines, notes and any
 * other line. Lines the record already holds are not repeated.
 */
function carryInlineMediaLines(record: GedNode, inline: GedNode, mintedNow: boolean, site: ReshapeSite, url: string): void {
  const inlineFile = firstChild(inline, "FILE");
  const title = childText(inline, "TITL") ?? (inlineFile && childText(inlineFile, "TITL"));
  if (title && !placeholderMediaTitle(title, site, url)) {
    const titl = firstChild(record, "TITL");
    if (!titl) insertGrouped(record, { level: record.level + 1, tag: "TITL", value: title.trim(), children: [] }, MEDIA_TRAILING);
    else if (mintedNow || placeholderMediaTitle(titl.value, site, url)) titl.value = title.trim();
  }
  const carry = (into: GedNode, from: GedNode, skip: ReadonlySet<string>) => {
    for (const line of from.children) {
      if (skip.has(line.tag)) continue;
      const copy = cloneNode(line);
      relevel(copy, into.level + 1);
      const same = firstChild(into, line.tag);
      // The form this run guessed from the address gives way to the one written.
      if (same && mintedNow && line.tag === "FORM") {
        same.value = copy.value;
        continue;
      }
      if (into.children.some((c) => nodeFingerprint(c) === nodeFingerprint(copy))) continue;
      insertGrouped(into, copy, MEDIA_STAMPS);
    }
  };
  const recordFile = firstChild(record, "FILE");
  if (inlineFile && recordFile) carry(recordFile, inlineFile, new Set(["TITL"]));
  carry(record, inline, new Set(["FILE", "TITL", ...MEDIA_STAMPS]));
}

/** Set a single-valued field only when the record doesn't already carry one —
 *  reshape enriches, it never overwrites user data. Inserted ahead of the
 *  record's media links and bookkeeping trailer, not appended after them. */
function fillField(rec: GedNode, tag: string, value: string | undefined): void {
  if (!value || childText(rec, tag)) return;
  insertGrouped(rec, { level: rec.level + 1, tag, value, children: [] }, SOUR_FIELD_TRAILING);
}

/**
 * Renders a fetched source date in the file's own date format, so a value
 * scraped off a page doesn't land in the file in a foreign shape. Sites report
 * dates however they please: "23 Jun 1998" (Ancestry prose), "Apr 12, 1979" (a
 * Google Books newspaper heading — which the GEDCOM parser can't even read),
 * "1784-1830" (a register's span). Readable values are re-rendered in the house
 * style; unreadable ones go through the same repair the Health Check offers, so
 * the tool can't create the very "unparseable date" that fix exists to clean up.
 * Whatever survives neither is written as it came. The file's format is derived
 * lazily (a full DATE walk) and reused — most groups carry no date at all.
 */
function houseDateFormatter(records: GedNode[]): (value: string | undefined) => string | undefined {
  let ctx: DateFixContext | undefined;
  return (value) => {
    if (!value?.trim()) return value;
    ctx ??= dateFixContext({ records });
    return proposeDateFix(value, ctx) ?? normalizeDateString(value, ctx.profile, ctx.sourceOrder) ?? value;
  };
}

/** One `EVEN` block of a source's standard coverage: the event type recorded,
 *  its period and the jurisdiction. */
interface CoverageEvent {
  type: string;
  date?: string;
  place?: string;
}

/** The event tag a register type records, for a coverage `EVEN` payload. */
function coverageTagOf(bookType: BookType, baptismTag: "BIRT" | "BAPM"): string | undefined {
  if (bookType === "baptism") return baptismTag;
  if (bookType === "marriage") return "MARR";
  if (bookType === "death") return "DEAT";
  if (bookType === "burial") return "BURI";
  return undefined;
}

/**
 * The `EVEN` blocks a source's standard coverage states: one per register of a
 * multi-register FamilySearch book ("Marriages … 1805-1812 Births … 1815-1843"
 * → `EVEN MARR` + `EVEN BIRT`, each with its own years), else a single block
 * for the book's own type. Empty when no type is known — a coverage claim
 * needs one, so the caller keeps the flat fields instead.
 */
function coverageEvents(
  bookType: BookType,
  baptismTag: "BIRT" | "BAPM",
  place: string | undefined,
  dateRange: string | undefined,
  book: string | undefined,
): CoverageEvent[] {
  const parts = splitFsRegisters(book);
  if (parts.length > 1) {
    const events = parts.flatMap((part) => {
      const tag = coverageTagOf(classifyBookType([part]), baptismTag);
      return tag ? [{ type: tag, date: yearSpan(part), place }] : [];
    });
    // Only when every register is understood — a partial split would claim
    // less than the book holds.
    if (events.length === parts.length) return events;
  }
  const tag = coverageTagOf(bookType, baptismTag);
  return tag ? [{ type: tag, date: dateRange, place }] : [];
}

/** A year range as the spec's period value ("1896-1911" → "FROM 1896 TO
 *  1911"); anything else is written as it came. */
function coveragePeriod(date: string | undefined): string | undefined {
  const m = date && /^(\d{4})\s*[-–]\s*(\d{4})$/.exec(date.trim());
  return m ? `FROM ${m[1]} TO ${m[2]}` : date;
}

/**
 * Write the standard coverage onto a source record: `1 DATA` holding one
 * `2 EVEN` per register (period + jurisdiction), with `AGNC` under `DATA` —
 * its spec spot, so a flat one moves along. Fill-only: a record already
 * stating an `EVEN` coverage keeps it. False when there is nothing to state
 * (no register type known), so the caller writes the flat fields instead.
 */
function applyStandardCoverage(rec: GedNode, events: CoverageEvent[], agency: string | undefined): boolean {
  if (events.length === 0) return false;
  let data = firstChild(rec, "DATA");
  if (!data) {
    data = { level: rec.level + 1, tag: "DATA", children: [] };
    insertGrouped(rec, data, SOUR_FIELD_TRAILING);
  }
  if (childrenByTag(data, "EVEN").length === 0) {
    for (const ev of events) {
      const even: GedNode = { level: data.level + 1, tag: "EVEN", value: ev.type, children: [] };
      const period = coveragePeriod(ev.date);
      if (period) even.children.push({ level: even.level + 1, tag: "DATE", value: period, children: [] });
      if (ev.place) even.children.push({ level: even.level + 1, tag: "PLAC", value: ev.place, children: [] });
      data.children.push(even);
    }
  }
  const flatAgnc = firstChild(rec, "AGNC");
  if (!childText(data, "AGNC")) {
    const value = flatAgnc?.value?.trim() || agency;
    if (value) data.children.push({ level: data.level + 1, tag: "AGNC", value, children: [] });
  }
  if (flatAgnc) spliceChild(rec, flatAgnc);
  return true;
}

/** The registers a source's own *title* names, when it names several — the
 *  `place - book - collection` titles this tool writes keep the multi-register
 *  book label as one segment, and each register in it becomes its own
 *  coverage entry. */
function coverageEventsFromTitle(
  title: string | undefined,
  abbr: string | undefined,
  place: string | undefined,
  dateRange: string | undefined,
  baptismTag: "BIRT" | "BAPM",
): CoverageEvent[] {
  for (const seg of (title ?? "").split(" - ")) {
    const parts = splitFsRegisters(seg.trim());
    if (parts.length > 1) {
      const events = parts.flatMap((part) => {
        const tag = coverageTagOf(classifyBookType([part]), baptismTag);
        return tag ? [{ type: tag, date: yearSpan(part), place }] : [];
      });
      if (events.length === parts.length) return events;
    }
  }
  const tag = coverageTagOf(classifyBookType([title, abbr]), baptismTag);
  return tag ? [{ type: tag, date: dateRange, place }] : [];
}

/**
 * The Normalize pass for source coverage: restate every existing `SOUR`
 * record in the target shape — flat vendor `PLAC`/`DATE` into the spec's
 * `DATA > EVEN` blocks (register type read from the title, `AGNC` moved to
 * its spot under `DATA`, `FILN` folded into an existing repository link's
 * `CALN`), or the reverse. Conservative on purpose: a record whose register
 * type can't be read, whose coverage names several places (inexpressible as
 * one flat `PLAC`), or whose flat fields disagree with its coverage keeps
 * its shape — nothing is invented and nothing is lost.
 */
/**
 * Move a source's `FILN` onto its repository link as the standard `CALN`, and
 * say which id moved. Nothing happens without a repository to hang it on (the
 * call number is part of the repository citation, so there is nowhere else for
 * it to go), nor where the link already states one.
 */
function foldFilingNumber(rec: GedNode): string | undefined {
  const repoLink = firstChild(rec, "REPO");
  const filn = firstChild(rec, "FILN");
  const value = filn?.value?.trim();
  if (!repoLink?.value || !value || firstChild(repoLink, "CALN")) return undefined;
  repoLink.children.push({ level: repoLink.level + 1, tag: "CALN", value, children: [] });
  spliceChild(rec, filn!);
  return value;
}

export function normalizeSourceCoverage(
  records: GedNode[],
  target: "vendor" | "standard",
  baptismTag: "BIRT" | "BAPM",
): { changed: number; examples: NormChange[] } {
  let changed = 0;
  const examples: NormChange[] = [];
  // Same discipline as the other Normalize passes: up to 12 examples, each a
  // *different* transformation — digit runs collapse in the signature, so a
  // hundred same-book pages give one row, while another register type, place
  // or a moved filing number each earn their own.
  const seen = new Set<string>();
  // The context (which source) is deliberately outside the signature: a
  // hundred books of the same shape still collapse to one example, and the row
  // names the one it stands for rather than none.
  const note = (before: string, after: string, context?: string) => {
    changed++;
    if (examples.length >= 12) return;
    const signature = `${before.replace(/\d+/g, "#")}→${after.replace(/\d+/g, "#")}`;
    if (seen.has(signature)) return;
    seen.add(signature);
    examples.push({ before, after, context });
  };

  for (const rec of records) {
    if (rec.tag !== "SOUR" || !rec.xref) continue;
    const data = firstChild(rec, "DATA");

    if (target === "standard") {
      // The filing number's standard spot is the repository link's call
      // number, whatever shape the source's coverage is already in — so this
      // runs before the "already standard" bail-out below. A source converted
      // by an earlier run (or written standard from the start) kept its FILN
      // for ever otherwise: the only pass that moves it never looked at it.
      const alreadyStandard = !!data && childrenByTag(data, "EVEN").length > 0;
      const early = alreadyStandard ? foldFilingNumber(rec) : undefined;
      if (early) note(`FILN ${early}`, `CALN ${early}`);
      if (alreadyStandard) continue;
      const plac = firstChild(rec, "PLAC");
      const date = firstChild(rec, "DATE");
      if (!plac?.value?.trim() && !date?.value?.trim()) continue;
      const title = sourceTitle(rec);
      // The register type is read from the source's own title, and the example
      // row carries that title with it: a coverage claim the reader cannot
      // trace to something the book itself says is indistinguishable from a
      // guess, however right it happens to be.
      const events = coverageEventsFromTitle(
        title,
        childText(rec, "ABBR"),
        plac?.value?.trim(),
        date?.value?.trim(),
        baptismTag,
      );
      if (events.length === 0) continue; // no register type to state
      applyStandardCoverage(rec, events, undefined);
      if (plac) spliceChild(rec, plac);
      if (date) spliceChild(rec, date);
      const foldedFiln = foldFilingNumber(rec);
      note(
        [plac?.value && `PLAC ${plac.value}`, date?.value && `DATE ${date.value}`, foldedFiln && `FILN ${foldedFiln}`]
          .filter(Boolean)
          .join(" · "),
        [
          ...events.map((ev) =>
            [`EVEN ${ev.type}`, coveragePeriod(ev.date), ev.place && `PLAC ${ev.place}`].filter(Boolean).join(" "),
          ),
          foldedFiln && `CALN ${foldedFiln}`,
        ]
          .filter(Boolean)
          .join(" · "),
        title,
      );
      continue;
    }

    // target === "vendor": flatten the coverage back into the program fields.
    if (!data) continue;
    const evens = childrenByTag(data, "EVEN");
    const dataAgnc = firstChild(data, "AGNC");
    if (evens.length === 0 && !dataAgnc) continue;
    const places = [...new Set(evens.map((e) => childText(e, "PLAC")).filter(Boolean))] as string[];
    if (places.length > 1) continue; // one flat PLAC cannot carry two jurisdictions
    const years = yearSpan(evens.map((e) => childText(e, "DATE")).filter(Boolean).join(" "));
    const flatPlac = childText(rec, "PLAC");
    const flatDate = childText(rec, "DATE");
    if (flatPlac && places[0] && flatPlac !== places[0]) continue; // disagreement is not ours to settle
    if (flatDate && years && flatDate !== years) continue;
    const flatAgnc = childText(rec, "AGNC");
    if (flatAgnc && dataAgnc?.value?.trim() && flatAgnc !== dataAgnc.value.trim()) continue; // same rule for the agency
    // An EVEN carrying anything beyond the DATE/PLAC this pass restates (a
    // NOTE, a vendor tag) cannot be flattened without losing it — leave the
    // whole record in its standard shape.
    if (evens.some((e) => e.children.some((c) => c.tag !== "DATE" && c.tag !== "PLAC"))) continue;
    const before = evens
      .map((e) => [`EVEN ${e.value ?? ""}`.trim(), childText(e, "DATE"), childText(e, "PLAC")].filter(Boolean).join(" "))
      .join(" · ");
    if (places[0] && !flatPlac) {
      insertGrouped(rec, { level: rec.level + 1, tag: "PLAC", value: places[0], children: [] }, SOUR_FIELD_TRAILING);
    }
    if (years && !flatDate) {
      insertGrouped(rec, { level: rec.level + 1, tag: "DATE", value: years, children: [] }, SOUR_FIELD_TRAILING);
    }
    if (dataAgnc?.value?.trim() && !childText(rec, "AGNC")) {
      insertGrouped(
        rec,
        { level: rec.level + 1, tag: "AGNC", value: dataAgnc.value.trim(), children: [] },
        SOUR_FIELD_TRAILING,
      );
    }
    for (const e of evens) spliceChild(data, e);
    if (dataAgnc) spliceChild(data, dataAgnc);
    if (data.children.length === 0 && !data.value?.trim()) spliceChild(rec, data);
    note(
      before || "DATA AGNC",
      [places[0] && `PLAC ${places[0]}`, years && `DATE ${years}`].filter(Boolean).join(" · ") || "AGNC",
      sourceTitle(rec),
    );
  }
  return { changed, examples };
}

/** Repository identity per site: how to spot an existing `REPO` (by its WWW
 *  host) and what to create when the file's convention hangs sources off
 *  repositories. Matricula derives name/WWW per archive instead. */
export const SITE_REPO: Partial<Record<ReshapeSite, { hostRe: RegExp; name: string; www: string }>> = {
  matricula: { hostRe: /data\.matricula-online\.eu/i, name: "Matricula Online", www: "https://data.matricula-online.eu/" },
  geneanet: { hostRe: /geneanet\.org\/cemetery|en\.geneanet\.org/i, name: "Geneanet Cemeteries", www: "https://en.geneanet.org/cemetery/" },
  geneanettree: { hostRe: /gw\.geneanet\.org/i, name: "Geneanet", www: "https://gw.geneanet.org/" },
  findagrave: { hostRe: /findagrave\.com/i, name: "Find a Grave", www: "https://www.findagrave.com/" },
  billiongraves: { hostRe: /billiongraves\.com/i, name: "BillionGraves", www: "https://billiongraves.com/" },
  legacy: { hostRe: /legacy\.com/i, name: "Legacy.com", www: "https://www.legacy.com/" },
  newspapers: { hostRe: /newspapers\.com/i, name: "Newspapers.com", www: "https://www.newspapers.com/" },
  sistory: { hostRe: /sistory\.si/i, name: "SIstory.si", www: "https://www.sistory.si/" },
  dlib: { hostRe: /dlib\.si/i, name: "dLib.si — Digitalna knjižnica Slovenije", www: "https://www.dlib.si/" },
  googlebooks: { hostRe: /books\.google\./i, name: "Google Books", www: "https://books.google.com/" },
  youtube: { hostRe: /youtube\.com|youtu\.be/i, name: "YouTube", www: "https://www.youtube.com/" },
  wikipedia: { hostRe: /wikipedia\.org/i, name: "Wikipedia", www: "https://www.wikipedia.org/" },
  biografija: { hostRe: /slovenska-biografija\.si/i, name: "Slovenska biografija", www: "https://www.slovenska-biografija.si/" },
  obrazi: { hostRe: /obrazislovenskihpokrajin\.si/i, name: "Obrazi slovenskih pokrajin", www: "https://www.obrazislovenskihpokrajin.si/" },
  familysearch: { hostRe: /familysearch\.org/i, name: "FamilySearch.org", www: "https://www.familysearch.org/" },
};

/** The part of a repository's name after the site it belongs to —
 *  "FamilySearch.org - Croatia" holds "Croatia". */
export function repoNameTail(name: string): string {
  return /^.*?\s[-–—]\s(.+)$/.exec(name.trim())?.[1].trim() ?? "";
}

/**
 * The country a repository record stands for: the one its name gives after
 * the site, and only when that tail *is* a country's name. A repository kept
 * for a single collection ("FamilySearch.org - Illinois, Cook County Deaths,
 * 1871-1998") names a country inside a collection title, which is a different
 * thing and must not answer for the country's own record.
 */
export function repoCountryFacet(name: string | undefined): string {
  const tail = repoNameTail(name ?? "");
  if (!tail) return "";
  // A state's own record is its country and the state, and nothing else —
  // "United States, Illinois", or either order for a name typed by hand. A
  // collection title that merely names a state ("Illinois, Cook County Deaths,
  // 1871-1998") has more in it than that, and answers for nobody.
  const parts = tail.split(",").map((s) => s.trim()).filter(Boolean);
  const exactState = (text: string) => {
    const state = stateOf(text);
    return state && foldCountryName(state.name) === foldCountryName(text) ? state : undefined;
  };
  if (parts.length === 1) {
    const state = exactState(parts[0]);
    if (state) return `${state.country}:${looseKey(state.name)}`;
  }
  if (parts.length === 2) {
    for (const [countryPart, statePart] of [[parts[0], parts[1]], [parts[1], parts[0]]]) {
      const state = exactState(statePart);
      if (state && countryCodeOfName(countryPart) === state.country) {
        return `${state.country}:${looseKey(state.name)}`;
      }
    }
  }
  return countryCodeOfName(tail) ? placeCountryFacet(tail) : "";
}

/** Existing REPO for a site: one whose WWW is on the site's host, or one named
 *  after the site — a file keeping a repository per collection may name it
 *  "FamilySearch.org - Croatia Church Books 1516-1994" and give it no WWW at
 *  all. The country's own repository wins when one is wanted, then a record
 *  naming any of `prefer` (the Matricula archive); else the first match. */
function findSiteRepo(
  records: GedNode[],
  hostRe: RegExp,
  siteName: string,
  prefer: (string | undefined)[] = [],
  /** With a specific country wanted, fall back only to a *generic* site
   *  repository — one kept for another country, or for a single collection
   *  ("FamilySearch.org - Croatia Church Books 1516-1994"), would be the wrong
   *  home, and the caller proposes creating the right one. */
  strictFallback = false,
  /** The country the source belongs to, for sites grouped by country. */
  countryFacet = "",
): string | undefined {
  const wanted = prefer.map((p) => (p ? looseKey(p) : "")).filter(Boolean);
  const site = looseKey(siteName);
  let anyMatch: string | undefined;
  let genericMatch: string | undefined;
  for (const rec of records) {
    if (rec.tag !== "REPO" || !rec.xref) continue;
    const www = childText(rec, "WWW") ?? "";
    const name = childText(rec, "NAME") ?? "";
    if (!hostRe.test(www) && !looseKey(name).startsWith(site)) continue;
    if (countryFacet && repoCountryFacet(name) === countryFacet) return rec.xref;
    const haystack = looseKey(`${name} ${www}`);
    if (wanted.some((w) => haystack.includes(w))) return rec.xref;
    anyMatch ??= rec.xref;
    // Generic = named exactly after the site (no country or collection
    // suffix), or a nameless record matched by a bare-host WWW.
    if (name ? site.startsWith(looseKey(name)) : /^https?:\/\/[^/]+\/?$/i.test(www.trim())) genericMatch ??= rec.xref;
  }
  // Strict: only the wanted record, or the site's own general one. A file that
  // keeps a repository per place has several, and handing a link to whichever
  // came first files it under a country it has nothing to do with.
  return strictFallback ? genericMatch : anyMatch;
}

/** The site's REPO for a new source: an existing one matched by WWW host
 *  (preferring the Matricula archive's), else — only when the file's
 *  convention hangs sources off repositories — a newly created record. */
/**
 * What linking a recognized site's repository would do for a new source:
 * the existing `REPO` record it would reuse (matched by WWW host, preferring
 * the Matricula archive's), or the name of the record it would create.
 * Lets the Add Source dialog show/preselect the repository before saving.
 */
/**
 * The repository the file already keeps for a FamilySearch collection: the one
 * its other pages hang off, found by the collection id (`cc=`) their links
 * carry. A bare browse link says nothing about the country its records are
 * from — but the file has answered that question before, and its own answer
 * beats asking FamilySearch again.
 */
function repoOfCitedCollection(records: GedNode[], cc: string | undefined): string | undefined {
  if (!cc) return undefined;
  const objeIndex = buildObjeIndex(records);
  for (const rec of records) {
    if (rec.tag !== "SOUR" || !rec.xref) continue;
    const repo = firstChild(rec, "REPO")?.value?.trim();
    if (!repo) continue;
    for (const child of childrenByTag(rec, "OBJE")) {
      const objeUrl = child.value ? objeIndex.get(child.value.trim())?.url : undefined;
      if (objeUrl && parseFamilySearchUrl(objeUrl)?.cc === cc) return repo;
    }
  }
  return undefined;
}

export function proposedSiteRepo(
  records: GedNode[],
  site: ReshapeSite,
  url: string,
  agency: string | undefined,
  /** What the FamilySearch link covers, once known — the place read off it
   *  picks the file's repository for that place out of several. */
  collection?: FsCollection,
): { xref?: string; createName?: string } | undefined {
  const repoDef = SITE_REPO[site];
  if (!repoDef) return undefined;
  // A page of a collection the file already cites goes where its siblings are,
  // whatever the link alone can be made to say.
  if (site === "familysearch") {
    const sibling = repoOfCitedCollection(records, parseFamilySearchUrl(url)?.cc);
    if (sibling) return { xref: sibling };
  }
  const mat = site === "matricula" ? parseMatriculaUrl(url) : undefined;
  const country = site === "familysearch" ? fsRepoCountry(collection) : undefined;
  const existing = findSiteRepo(
    records,
    repoDef.hostRe,
    repoDef.name,
    [mat?.archiveSlug],
    // FamilySearch repositories are kept per place — a repository for another
    // country (or for one single collection) must not swallow this link, and
    // nor must any of them when the place is still unknown: the site's own
    // general record is the only honest home until the lookup, the citation or
    // a sibling page says where the records are from.
    site === "familysearch" || Boolean(country?.facet),
    country?.facet,
  );
  if (existing) return { xref: existing };
  // Matricula repositories are the holding archive; FamilySearch keeps one per
  // country of records; the other sites are their own repository.
  return { createName: siteRepoName(site, repoDef.name, agency, country?.name) };
}

/** What a FamilySearch link covers, as the repository logic needs it: the
 *  collection it belongs to (title and id) and the place its records are
 *  from. Any of them may be missing. */
export interface FsCollection {
  title?: string;
  id?: string;
  /** The place the records cover ("Chicago, Cook, Illinois, United States") —
   *  the surest statement of the country whose repository holds the source. */
  place?: string;
}

/**
 * The country a FamilySearch source belongs to: the one its place names,
 * else the one its collection title opens with ("Illinois, Cook County
 * Deaths, 1871-1998" is American). Named as the place itself writes it where
 * it says so outright, and in English otherwise — the site and its collection
 * titles are English, so a country read out of one is too.
 */
export function fsRepoCountry(collection: FsCollection | undefined): { facet: string; name: string } | undefined {
  const place = collection?.place?.trim();
  const title = collection?.title ?? "";
  const facet = (place && placeCountryFacet(place)) || titleCountryFacet(title);
  if (!facet) return undefined;
  const written = place && placeCountryFacet(place) === facet ? countryNameOf(place) : undefined;
  const country = written ?? countryFacetName(facet, "en");
  // Where a country's records are published state by state — American ones
  // are, and this file's own places say which state — the state is the
  // repository, since a single "United States" record would hold everything.
  // A national collection ("United States, Census, 1930") names no state and
  // keeps the country itself.
  const state = (place ? stateOf(place) : undefined) ?? stateOf(title);
  if (!state || state.country !== facet) return { facet, name: country };
  // Country first, so a state's record reads as a narrowing of the country's
  // and the two sort together — "United States", "United States, Illinois".
  return { facet: `${facet}:${looseKey(state.name)}`, name: `${country}, ${state.name}` };
}

/** What a new repository for the site is called: the holding archive for
 *  Matricula, the country of the records for FamilySearch, else the site
 *  itself. */
function siteRepoName(
  site: ReshapeSite,
  siteName: string,
  agency: string | undefined,
  country: string | undefined,
): string {
  if (site === "matricula" && agency) return agency;
  if (site === "familysearch" && country) return `${siteName} - ${country}`;
  return siteName;
}

/** Create the site's `REPO` record (name + WWW) — the Add Source dialog's
 *  explicit "＋ new repository" choice, unconditional on the file's layout.
 *  `nameOverride` is the dialog's edited name for the proposal — the record
 *  keeps the site/collection WWW either way. */
export function createSiteRepo(
  records: GedNode[],
  site: ReshapeSite,
  url: string,
  agency: string | undefined,
  collection?: FsCollection,
  nameOverride?: string,
): GedNode | undefined {
  const repoDef = SITE_REPO[site];
  if (!repoDef) return undefined;
  const mat = site === "matricula" ? parseMatriculaUrl(url) : undefined;
  const country = site === "familysearch" ? fsRepoCountry(collection) : undefined;
  const name = nameOverride?.trim() || siteRepoName(site, repoDef.name, agency, country?.name);
  // A country's repository spans many collections, so it carries the site's
  // own address rather than any one collection's page.
  const www = mat
    ? `https://data.matricula-online.eu/${mat.lang}/${mat.country}/${mat.archiveSlug}/`
    : repoDef.www;
  const repo: GedNode = { level: 0, xref: nextXref(records, "R"), tag: "REPO", children: [] };
  repo.children.push({ level: 1, tag: "NAME", value: name, children: [] });
  repo.children.push({ level: 1, tag: "WWW", value: www, children: [] });
  insertRecord(records, repo);
  return repo;
}

function ensureSiteRepo(
  records: GedNode[],
  site: ReshapeSite,
  url: string,
  agency: string | undefined,
  repositoryLayout: boolean,
  collection?: FsCollection,
): { xref: string; created?: GedNode } | undefined {
  const proposal = proposedSiteRepo(records, site, url, agency, collection);
  if (!proposal) return undefined;
  if (proposal.xref) return { xref: proposal.xref };
  if (!repositoryLayout) return undefined;
  const repo = createSiteRepo(records, site, url, agency, collection);
  return repo ? { xref: repo.xref!, created: repo } : undefined;
}

/**
 * Give a SOUR record newly created from a recognized site URL the same extras
 * the Organize sources tool writes on its own new sources: `PLAC` matched
 * against the file's established place format, the register's `DATE` range,
 * and a `REPO` link — reusing the site's existing repository, or creating one
 * only when the file's convention hangs sources off repositories. Returns the
 * newly created REPO record, if any, so the caller can patch/undo it.
 * Without a `site` (a hand-entered place on an unrecognized URL) only the
 * PLAC/DATE fills apply.
 */
export function applySiteSourceExtras(
  records: GedNode[],
  sourceNode: GedNode,
  site: ReshapeSite | undefined,
  url: string,
  meta: { place?: string; dateRange?: string; collection?: string; collectionId?: string },
  opts: {
    sourceLayout?: SourceLayout | "auto";
    repo?: "auto" | "none";
    sourceCoverage?: "vendor" | "standard" | "auto";
    baptism?: "BIRT" | "BAPM" | "auto";
  } = {},
): GedNode | undefined {
  const place = buildPlaceResolver(records).resolve(meta.place);
  const dateRange = houseDateFormatter(records)(meta.dateRange);
  const coverage =
    opts.sourceCoverage && opts.sourceCoverage !== "auto" ? opts.sourceCoverage : detectSourceCoverage(records);
  // The register type the coverage would claim: the site's inherent kind, or
  // whatever the title says ("… - Deaths (Umrli) 1896-1911 - …").
  const bookType = (site ? SITE_BOOK_TYPE[site] : undefined) ?? classifyBookType([childText(sourceNode, "TITL")]);
  const baptismTag = opts.baptism && opts.baptism !== "auto" ? opts.baptism : baptismTargetTag(records);
  const standard =
    coverage === "standard" &&
    applyStandardCoverage(
      sourceNode,
      coverageEvents(bookType, baptismTag, place, dateRange, undefined),
      undefined,
    );
  if (!standard) {
    fillField(sourceNode, "PLAC", place);
    fillField(sourceNode, "DATE", dateRange);
  }
  // "none": the caller handles the repository choice itself (the Add Source
  // dialog's explicit dropdown) — only the PLAC/DATE fills apply here.
  if (opts.repo === "none" || !site || firstChild(sourceNode, "REPO")) return undefined;
  // The source being enriched is already in `records` — it must not vote
  // against the habit it is about to follow.
  const createRepos = repoLinkWanted(records, opts.sourceLayout, sourceNode);
  const repo = ensureSiteRepo(records, site, url, childText(sourceNode, "AGNC"), createRepos, {
    title: meta.collection,
    id: meta.collectionId,
    place: meta.place,
  });
  if (!repo) return undefined;
  const link: GedNode = { level: sourceNode.level + 1, tag: "REPO", value: repo.xref, children: [] };
  // The same id, in the one place this file states it: the repository link's
  // call number where the file writes those, else the source's own FILN,
  // which is already there. Writing both would say it twice.
  const filn = childText(sourceNode, "FILN");
  if (filn && writesCallNumbers(records, coverage)) {
    link.children.push({ level: link.level + 1, tag: "CALN", value: filn, children: [] });
  }
  sourceNode.children.push(link);
  return repo.created;
}

/**
 * What a source from a recognized site is called: the lookup names the thing
 * itself — a cemetery, a register — while the id that tells one of them from
 * the next comes from the link. A Geneanet
 * cemetery is the case that needs both: every grave in one cemetery answers
 * with the same name, so a title without the view id leaves a file full of
 * sources called "Pokopališče Kranj - Geneanet Cemeteries" that nothing can
 * tell apart — the duplicate finder included, which reads two of them as one
 * record under different ids.
 */
export function siteSourceTitle(
  site: ReshapeSite | undefined,
  title: string | undefined,
  id: string | undefined,
): string | undefined {
  if (!title || site !== "geneanet" || !id || title.includes(id)) return title;
  const label = "Geneanet Cemeteries";
  const name = title.endsWith(` - ${label}`) ? title.slice(0, -label.length - 3) : title;
  return siteTitle(name, id, label);
}

/** The same, for a scanned group: the lookup's name over the offline one, and
 *  the id the link carried either way. */
function enrichedTitle(g: ReshapeGroup, extra: ReshapeMeta | undefined): string {
  return siteSourceTitle(g.site, extra?.title ?? g.proposed.title, g.proposed.filingNumber) ?? g.proposed.title;
}

/**
 * Apply the reshape for the selected groups on a fresh clone of `records` —
 * the input is never mutated. `enrichment` (from {@link fetchReshapeMeta})
 * overrides the offline-proposed source fields per group id.
 */
export function reshapeSources(
  records: GedNode[],
  selected: ReshapeGroup[],
  enrichment?: ReshapeEnrichment,
  opts: ReshapeOptions = {},
): { records: GedNode[]; counts: ReshapeCounts } {
  const counts: ReshapeCounts = {
    sourcesCreated: 0,
    sourcesReused: 0,
    mediaCreated: 0,
    citationsAdded: 0,
    citationsRewritten: 0,
    linksRemoved: 0,
    notesRewritten: 0,
    eventsCreated: 0,
    linksTidied: 0,
    linksSwapped: 0,
    mediaRetitled: 0,
  };
  if (selected.length === 0) return { records, counts };

  const selectedById = new Map(selected.map((g) => [g.id, g]));
  const sites = new Set<ReshapeSite>(selected.map((g) => g.site));
  const relocate = opts.relocate !== false;

  const clone = records.map(cloneNode);
  const byXref = new Map<string, GedNode>();
  for (const r of clone) if (r.xref) byXref.set(r.xref, r);

  const { fold, pageMedia, baptismTag, createRepos, coverage } = resolveFormatOptions(clone, opts);
  // Where this file states an archive's id: the repository link's call number,
  // or the source's own filing number. One or the other, never both.
  const callNumbers = writesCallNumbers(clone, coverage);
  // A link folded into a book is selected under the book's id, not its own.
  const hits = scanOccurrences(clone, sites, fold ? pageMedia : undefined).filter((h) =>
    selectedById.has(opts.mergeGroups?.get(h.recognized.groupKey) ?? h.recognized.groupKey),
  );
  const groups = foldMergedGroups(buildGroups(clone, hits, fold), opts.mergeGroups);
  // Media index built ONCE for the whole apply (a per-group rebuild is a full
  // forest scan each time); OBJEs this run creates are tracked alongside.
  const cloneObjeIndex = buildObjeIndex(clone);
  // Which sources hold each page as their own media — read before this run
  // links any, so a page already cited through another source is left as it is
  // rather than cited twice (see `isSettledPointer`).
  const pageHolders = sourcesHoldingPages(clone, cloneObjeIndex);
  const createdObjeUrls = new Map<string, string>();
  const urlOfObje = (xref: string): string | undefined =>
    cloneObjeIndex.get(xref)?.url ?? createdObjeUrls.get(xref);
  const ctx: RelocationContext = { byXref, urlOfObje };
  const { resolve: resolvePlace, structuredAddr } = buildPlaceResolver(clone);
  const houseDate = houseDateFormatter(clone);
  /** Citations re-pointed this run — one naming two sites' links is two hits
   *  of two groups on the same node (see the citation rewrite below). */
  const convertedCitations = new Set<GedNode>();

  for (const [key, state] of groups) {
    const selection = selectedById.get(key);
    if (!selection) continue;
    const g = state.group;

    // Marked as a dead/obsolete link: strip every occurrence instead of
    // converting — note text and citation prose around the URL survive, the
    // bare link nodes go, and no source is created or reused.
    if (selection.removeLinks) {
      for (const hit of state.hits) {
        if (hit.shape === "sourTitle") continue; // a record's title, not a reference
        if (hit.shape === "pageUrl") {
          const pageChild = firstChild(hit.node, "PAGE");
          if (pageChild?.value) {
            const remaining = removeUrlFromText(pageChild.value, hit.url);
            if (hasContent(remaining)) pageChild.value = remaining;
            else spliceChild(hit.node, pageChild);
            counts.citationsRewritten++;
          }
          continue;
        }
        if ((hit.shape === "note" || hit.shape === "inline") && hit.node.value !== undefined) {
          const remaining = removeUrlFromText(hit.node.value, hit.url);
          if (hasContent(remaining)) {
            hit.node.value = remaining;
            counts.notesRewritten++;
            continue;
          }
          // A citation is more than its link: its page, transcription or
          // quality stay, only the dead link line goes.
          if (hit.shape === "inline" && hit.node.children.length > 0) {
            hit.node.value = undefined;
            counts.linksRemoved++;
            continue;
          }
        }
        if (spliceChild(hit.container, hit.node)) counts.linksRemoved++;
      }
      continue;
    }

    // Links the reader traded for another in the ✎ editor — a FamilySearch
    // record page for the image behind it. Keyed by the link they replace, so
    // a trade still finds its occurrences after the pages of one film have
    // been folded into a single book.
    const swapByUrl = new Map<string, string>();
    for (const m of selection.members) {
      if (m.swapUrl && linkKey(m.swapUrl) !== linkKey(m.url)) {
        swapByUrl.set(linkKey(m.url), familySearchPageUrl(m.swapUrl));
      }
    }
    const swapOf = (hit: ScanHit): string | undefined => swapByUrl.get(linkKey(hit.url));
    /** The URL a hit's page media is written with — its own, or the trade. */
    const urlFor = (hit: ScanHit): string => swapOf(hit) ?? hit.url;

    const extra = enrichment?.get(key);
    const bookType = extra?.bookType ?? g.bookType;
    const fields = {
      title: enrichedTitle(g, extra),
      author: extra?.author ?? g.proposed.author,
      periodical: extra?.periodical,
      publisher: extra?.publisher,
      agency: extra?.agency ?? g.proposed.agency,
      // Matched against the file's own places, so "Žabnica, Slovenia" (or a
      // diacritic-less slug guess) lands in the established place format.
      place: resolvePlace(extra?.place ?? g.proposed.place),
      filingNumber: extra?.filingNumber ?? g.proposed.filingNumber,
      dateRange: houseDate(extra?.dateRange ?? g.proposed.dateRange),
    };

    // --- Resolve the target SOUR record: reuse, adopt a URL-titled one, or create.
    let sourceNode = g.existingSourceXref ? byXref.get(g.existingSourceXref) : undefined;
    if (sourceNode) {
      counts.sourcesReused++;
      // A record made before the id was known keeps its own title, but the
      // empty id is the tool's to fill: it is what the link carries, and
      // without it nothing on the record says which grave (or which book)
      // this is. It goes in the one place this file states ids — the
      // repository link's call number, or the source's own filing number,
      // never both (see `writesCallNumbers`).
      const repoLink = callNumbers ? firstChild(sourceNode, "REPO") : undefined;
      if (repoLink) fillField(repoLink, "CALN", fields.filingNumber);
      else fillField(sourceNode, "FILN", fields.filingNumber);
    } else {
      sourceNode = createSourceRecord(clone, fields);
      byXref.set(sourceNode.xref!, sourceNode);
      counts.sourcesCreated++;
      // What the source covers: the spec's `DATA > EVEN` blocks in a
      // standard-coverage file, else the flat vendor fields
      // (`NewSourceFields` has neither — the paginated house shape does).
      const standard =
        coverage === "standard" &&
        applyStandardCoverage(
          sourceNode,
          coverageEvents(bookType, baptismTag, fields.place, fields.dateRange, extra?.book),
          fields.agency,
        );
      if (!standard) {
        fillField(sourceNode, "PLAC", fields.place);
        fillField(sourceNode, "DATE", fields.dateRange);
      }
      // The reader's own choice in the field editor, where they made one: a
      // repository of the file, the site's proposal outright, or none. Silence
      // leaves it to the file's habit, as before.
      const picked = extra?.repoXref;
      const repo =
        picked === ""
          ? undefined
          : picked && picked !== "@create@"
            ? { xref: picked }
            : ensureSiteRepo(clone, g.site, urlFor(state.hits[0]), fields.agency, createRepos || picked === "@create@", {
                title: extra?.collection ?? fields.title,
                id: extra?.collectionId,
                place: fields.place,
              });
      if (repo) {
        if (repo.created) byXref.set(repo.created.xref!, repo.created);
        const link: GedNode = { level: 1, tag: "REPO", value: repo.xref, children: [] };
        // The filing number doubles as the call number within that repository
        // (the Matricula book id, the FamilySearch film) — the standard spot a
        // strict reader looks for it is the repository link's CALN.
        if (fields.filingNumber && callNumbers) {
          link.children.push({ level: 2, tag: "CALN", value: fields.filingNumber, children: [] });
          // The call number now carries the id, so the source's own field must
          // not repeat it: a file holding the same id twice says it twice, and
          // a reader who edits one leaves the other stale. (A source that ends
          // up with no repository keeps its FILN — the id must live somewhere.)
          const filn = firstChild(sourceNode, "FILN");
          if (filn) spliceChild(sourceNode, filn);
        }
        sourceNode.children.push(link);
      }
    }
    const sourceXref = sourceNode.xref!;


    // Which page of the source each link is. A page number the URL itself
    // carries wins; then the one the report put on that member — for a book
    // folded out of many single-image links, that is where each image's own
    // number lives; then the group's own, for a source cited at one page.
    const pageByUrl = new Map<string, string>();
    for (const m of selection.members) if (m.page) pageByUrl.set(linkKey(m.url), m.page);
    // A traded link is a different page of the source, so the number read off
    // the link it replaced says nothing: the member carries the page the editor
    // settled on (that is what the reader saw), and the new link's own number
    // backs it up.
    const pageOf = (hit: ScanHit): string | undefined => {
      const swap = swapOf(hit);
      if (swap) return pageByUrl.get(linkKey(hit.url)) ?? recognizeSourceUrl(swap)?.page ?? extra?.page;
      return hit.recognized.page ?? pageByUrl.get(linkKey(hit.url)) ?? extra?.page;
    };

    /** The link this run stores for a page: canonical, and completed with what
     *  the run has learned that the copied link left out — the image its page
     *  number names, the collection its lookup resolved. What the link itself
     *  carries always stands. */
    const storedLink = (url: string, hit: ScanHit): string =>
      familySearchPageUrl(url, { image: familySearchImageIndex(pageOf(hit)), cc: extra?.collectionId });

    // Re-point what the media already holds: at the traded link where the
    // reader chose one, else — asked for it — at the same link in the form the
    // file stores, minus the viewer state that made one page look like several
    // and plus the page and collection the link was copied without.
    if (opts.tidyLinks || swapByUrl.size) {
      for (const hit of state.hits) {
        const xref = hit.objeXref;
        const obje = xref ? byXref.get(xref) : undefined;
        const file = obje && firstChild(obje, "FILE");
        const stored = file?.value?.trim();
        const swap = swapOf(hit);
        const next = swap ? storedLink(swap, hit) : opts.tidyLinks && stored ? storedLink(stored, hit) : undefined;
        if (xref && file && next && next !== stored) {
          file.value = next;
          // The index the OBJE-per-page pass reads was taken before this
          // rewrite — leave it saying what the record now holds.
          cloneObjeIndex.delete(xref);
          createdObjeUrls.set(xref, next);
          if (swap) counts.linksSwapped++;
          else counts.linksTidied++;
        }
      }
    }

    // --- Name the media the file already holds for these pages. A page image
    // saved from the site carries whatever the site's own button wrote — every
    // one of them "FamilySearch.org", or the raw address — which says where it
    // came from and nothing about what it is. Once the lookup has named the
    // book, its pages can be named after it, exactly as a media record this run
    // creates is. A title that already says something is left alone.
    for (const hit of state.hits) {
      const obje = hit.objeXref ? byXref.get(hit.objeXref) : undefined;
      if (!obje) continue;
      const titl = firstChild(obje, "TITL");
      if (!placeholderMediaTitle(titl?.value, g.site, hit.url)) continue;
      // In this tool a FamilySearch page number is always the link's or the
      // lookup's — the film's own counting — so it may go into the title.
      const named = pageObjeTitle(g.site, fields.title, pageOf(hit), pageOf(hit), extra?.collection);
      if (!named || named === titl?.value?.trim()) continue;
      if (titl) titl.value = named;
      else insertGrouped(obje, { level: obje.level + 1, tag: "TITL", value: named, children: [] }, MEDIA_TRAILING);
      counts.mediaRetitled++;
    }

    // --- Rewrite URL-titled SOUR records in place (every one in the group, so
    // the duplicates tool can consolidate them afterwards).
    for (const hit of state.hits) {
      if (hit.shape !== "sourTitle") continue;
      hit.node.value = fields.title;
      fillField(hit.rec, "AUTH", fields.author);
      const std =
        coverage === "standard" &&
        applyStandardCoverage(
          hit.rec,
          coverageEvents(bookType, baptismTag, fields.place, fields.dateRange, extra?.book),
          fields.agency,
        );
      if (!std) {
        fillField(hit.rec, "AGNC", fields.agency);
        fillField(hit.rec, "PLAC", fields.place);
        fillField(hit.rec, "DATE", fields.dateRange);
      }
      fillField(hit.rec, "FILN", fields.filingNumber);
      counts.citationsRewritten++;
    }

    // --- Ensure one OBJE per distinct page URL under the target SOUR.
    const linkedKeys = new Set<string>();
    for (const c of childrenByTag(sourceNode, "OBJE")) {
      const v = c.value?.trim();
      const url = v && urlOfObje(v);
      if (url) linkedKeys.add(linkKey(url));
    }
    const seenUrls = new Set<string>();
    // Hits that point at an existing top-level OBJE record go first, so a
    // same-URL bare link elsewhere in the file can't win the race and mint a
    // duplicate media record while orphaning the existing one.
    const ensureOrder = [...state.hits].sort((a, b) => Number(!!b.objeXref) - Number(!!a.objeXref));
    const minted = new Map<string, GedNode>();
    for (const hit of ensureOrder) {
      const hitUrl = urlFor(hit);
      const urlKey = linkKey(hitUrl);
      if (seenUrls.has(urlKey) || linkedKeys.has(urlKey)) continue;
      seenUrls.add(urlKey);
      const page = pageOf(hit);
      const objeTitle = pageObjeTitle(g.site, fields.title, page, page, extra?.collection) ?? fields.title;
      if (hit.objeXref && byXref.has(hit.objeXref)) {
        // Re-link the already-existing top-level OBJE under the source,
        // grouped with its other page media (not after CHAN/CREA).
        insertGrouped(sourceNode, { level: 1, tag: "OBJE", value: hit.objeXref, children: [] }, SOUR_TRAILING);
      } else {
        // Written stripped of viewer state but keeping what selects the page,
        // so a page linked twice by two readers lands as one media record and
        // still reopens where it was copied (see `familySearchPageUrl`).
        const obje = addObjeToSource(clone, sourceXref, storedLink(hitUrl, hit), objeTitle);
        if (obje.xref) {
          createdObjeUrls.set(obje.xref, hitUrl);
          minted.set(obje.xref, obje);
        }
        counts.mediaCreated++;
      }
      linkedKeys.add(urlKey);
    }

    // An inline media block's own lines — its title, notes, the file's form —
    // go to the media record now holding its page, rather than leaving with
    // the inline block when it is removed below.
    for (const hit of state.hits) {
      if (hit.shape !== "obje" || hit.objeXref) continue;
      const key = linkKey(urlFor(hit));
      const xref = childrenByTag(sourceNode, "OBJE")
        .map((c) => c.value?.trim())
        .find((v) => {
          const url = v && urlOfObje(v);
          return !!url && linkKey(url) === key;
        });
      const record = xref ? minted.get(xref) ?? byXref.get(xref) : undefined;
      if (record) carryInlineMediaLines(record, hit.node, !!xref && minted.has(xref), g.site, urlFor(hit));
    }

    // Where each cited page's image lives — in the "event" page-media style
    // the citation's container gets that OBJE linked beside it, so the page
    // shows inline with the fact (webtrees-style).
    const objeByUrlKey = new Map<string, string>();
    if (pageMedia === "event") {
      for (const c of childrenByTag(sourceNode, "OBJE")) {
        const v = c.value?.trim();
        const url = v && urlOfObje(v);
        if (v && url) objeByUrlKey.set(linkKey(url), v);
      }
    }
    const ensurePageMedia = (target: GedNode, targetOrder: string[], url: string) => {
      const xref = objeByUrlKey.get(linkKey(url));
      if (!xref) return;
      if (childrenByTag(target, "OBJE").some((c) => c.value?.trim() === xref)) return;
      insertOrdered(target, { level: target.level + 1, tag: "OBJE", value: xref, children: [] }, targetOrder);
    };

    // --- Rewrite each occurrence into a citation. Per-citation QUAY overrides
    // from the report's members are matched by a stable occurrence key (not by
    // position), so an edit between scan and apply can't shift an override
    // onto the wrong citation.
    const quayByKey = new Map<string, string[]>();
    for (const m of selection.members) {
      if (!m.quay) continue;
      const key = occurrenceQuayKey(m.recordXref, m.shape, m.eventTag, m.eventIndex, m.url);
      const queue = quayByKey.get(key);
      if (queue) queue.push(m.quay);
      else quayByKey.set(key, [m.quay]);
    }
    for (const hit of state.hits) {
      const quayFor =
        quayByKey
          .get(occurrenceQuayKey(hit.rec.xref ?? "?", hit.shape, hit.eventTag, hit.eventIndex, hit.url))
          ?.shift() ?? selection.quay;
      if (hit.shape === "sourTitle") continue;

      // Superseded by an identical event-level attachment: clean up only.
      if (hit.foldedInto) {
        if (hit.shape === "note" && hit.node.value !== undefined) {
          const remaining = removeUrlFromText(hit.node.value, hit.url);
          if (hasContent(remaining)) {
            hit.node.value = remaining;
            counts.notesRewritten++;
            continue;
          }
        }
        if (spliceChild(hit.container, hit.node)) counts.linksRemoved++;
        continue;
      }

      const page = pageOf(hit);
      const move = relocate && !hit.twinEvent ? relocationTarget(hit, bookType, baptismTag, ctx, sourceXref) : undefined;
      if (isSettledPointer(hit, move, [sourceXref, ...(pageHolders.get(linkKey(hit.url)) ?? [])], pageMedia, page, quayFor))
        continue;
      let container = hit.container;
      if (move) {
        const host = move.famXref ? byXref.get(move.famXref) : hit.rec;
        if (host) {
          let event = firstChild(host, move.eventTag);
          if (!event) {
            event = { level: host.level + 1, tag: move.eventTag, children: [] };
            insertOrdered(host, event, host.tag === "FAM" ? FAM_CHILD_ORDER : INDI_CHILD_ORDER);
            counts.eventsCreated++;
          }
          container = event;
        }
      }
      // A relocation target is always an event node; otherwise the original
      // container decides (record-level vs event-level order).
      const order = container === hit.container ? childOrderFor(container, hit.rec) : EVENT_CHILD_ORDER;

      // A grave record tells us where the burial is: fill the BURI event's
      // missing place from the source's location (never overwrite one). In a
      // place+address file, the cemetery name goes into the event's ADDR —
      // also when the event already carries a place of its own.
      if (bookType === "burial" && container.tag === "BURI") {
        if (fields.place && !firstChild(container, "PLAC")) {
          insertOrdered(
            container,
            { level: container.level + 1, tag: "PLAC", value: fields.place, children: [] },
            EVENT_CHILD_ORDER,
          );
        }
        if (structuredAddr && extra?.address && !firstChild(container, "ADDR")) {
          insertOrdered(
            container,
            { level: container.level + 1, tag: "ADDR", value: extra.address, children: [] },
            EVENT_CHILD_ORDER,
          );
        }
      }

      if (hit.shape === "inline" || hit.shape === "pageUrl") {
        // Convert the citation node itself, preserving its other children —
        // unless another site's link in the same citation already converted
        // it this run: re-pointing it again would leave that site's new
        // source cited by nothing, so this site gets a citation of its own
        // beside it, and its link leaves the first one's PAGE.
        const twin = convertedCitations.has(hit.node);
        const citation: GedNode = twin ? { level: hit.node.level, tag: "SOUR", children: [] } : hit.node;
        // Every PAGE line carrying this link: a file can repeat the line (two
        // identical `PAGE <url>`), and a link left on the second one would be
        // offered again by the next run.
        const pagesWithUrl = (node: GedNode) =>
          childrenByTag(node, "PAGE").filter((p) => p.value?.includes(hit.url));
        if (twin && hit.shape === "pageUrl") {
          for (const ownPage of pagesWithUrl(hit.node)) {
            const remaining = removeUrlFromText(ownPage.value!, hit.url);
            if (hasContent(remaining)) ownPage.value = remaining;
            else spliceChild(hit.node, ownPage);
          }
        }
        convertedCitations.add(hit.node);
        citation.value = sourceXref;
        const pageChild = firstChild(citation, "PAGE");
        const found = pagesWithUrl(citation);
        const urlPages = found.length ? found : pageChild?.value ? [pageChild] : [];
        if (hit.shape === "pageUrl" && urlPages.length) {
          // Swap the URL for its page number in place, keeping surrounding
          // prose ("fol. 23, <url>" → "fol. 23, 5"); drop PAGE only when
          // nothing meaningful remains — or when it is a repeat of a line the
          // swap has already written.
          const kept = new Set<string>();
          for (const p of urlPages) {
            const replaced = page
              ? p.value!.replace(hit.url, page).replace(/[ \t]{2,}/g, " ").trim()
              : removeUrlFromText(p.value!, hit.url);
            if (hasContent(replaced) && !kept.has(replaced)) {
              p.value = replaced;
              kept.add(replaced);
            } else spliceChild(citation, p);
          }
        } else if (page) {
          if (pageChild?.value?.trim()) pageChild.value = withPage(pageChild.value, page, hit.url);
          else if (pageChild) pageChild.value = page;
          else citation.children.push({ level: citation.level + 1, tag: "PAGE", value: page, children: [] });
        }
        if (!twin && hit.prefix && !childrenByTag(citation, "NOTE").some((n) => n.value?.trim() === hit.prefix)) {
          citation.children.push({ level: citation.level + 1, tag: "NOTE", value: hit.prefix, children: [] });
        }
        if (quayFor && !firstChild(citation, "QUAY")) {
          citation.children.push({ level: citation.level + 1, tag: "QUAY", value: quayFor, children: [] });
        }
        // Compare by the citation's *final* PAGE text (not just the page id):
        // Ancestry exports duplicate whole record-level citations verbatim,
        // and the identical twin must fold into one citation, not two.
        const pageText = childText(citation, "PAGE") ?? "";
        const duplicate = childrenByTag(container, "SOUR").find(
          (c) => c !== citation && c.value?.trim() === sourceXref && (childText(c, "PAGE") ?? "") === pageText,
        );
        // Folding into the surviving twin: fill its missing QUAY too.
        if (duplicate && quayFor && !firstChild(duplicate, "QUAY")) {
          duplicate.children.push({ level: duplicate.level + 1, tag: "QUAY", value: quayFor, children: [] });
        }
        if (container !== hit.container || twin) {
          if (!twin) spliceChild(hit.container, citation);
          if (!duplicate) {
            relevel(citation, container.level + 1);
            insertOrdered(container, citation, order);
          }
        } else if (duplicate) {
          spliceChild(container, citation);
        }
        ensurePageMedia(container, order, urlFor(hit));
        counts.citationsRewritten++;
        continue;
      }

      // A link that names no page of its own (a FamilySearch ark kept without
      // its `?i=`) is the page its one citation beside it cites. Read as "no
      // page", the move missed both that citation and the event's own one of
      // the same page, and wrote a third, page-less citation beside them.
      const besideCitations =
        page === undefined && container !== hit.container
          ? childrenByTag(hit.container, "SOUR").filter((c) => c.value?.trim() === sourceXref)
          : [];
      const citedPage = page ?? (besideCitations.length === 1 ? childText(besideCitations[0], "PAGE") : undefined);

      // Relocating takes an identical citation at the link's old spot along —
      // the record-level citation an earlier run wrote while the marriage
      // family was still unresolved — instead of leaving a redundant copy.
      if (container !== hit.container) {
        const stale = childrenByTag(hit.container, "SOUR").find(
          (c) => c.value?.trim() === sourceXref && (childText(c, "PAGE") ?? "") === (citedPage ?? ""),
        );
        if (stale) {
          spliceChild(hit.container, stale);
          const existing = childrenByTag(container, "SOUR").find(
            (c) => c.value?.trim() === sourceXref && (childText(c, "PAGE") ?? "") === (citedPage ?? ""),
          );
          if (existing) {
            // Folds into the citation already there; carry its QUAY over.
            const quay = childText(stale, "QUAY");
            if (quay && !firstChild(existing, "QUAY")) {
              existing.children.push({ level: existing.level + 1, tag: "QUAY", value: quay, children: [] });
            }
          } else {
            relevel(stale, container.level + 1);
            insertOrdered(container, stale, order);
          }
          counts.citationsRewritten++;
        }
      }

      if (attachCitation(container, sourceXref, citedPage, quayFor, order)) counts.citationsAdded++;

      if (hit.shape === "note") {
        if (hit.node.value !== undefined) {
          const remaining = removeUrlFromText(hit.node.value, hit.url);
          if (hasContent(remaining)) {
            hit.node.value = remaining;
            counts.notesRewritten++;
          } else if (spliceChild(hit.container, hit.node)) {
            counts.linksRemoved++;
          }
        }
      } else if (spliceChild(hit.container, hit.node)) {
        counts.linksRemoved++;
      }
      // After the original node is gone, so an in-place pointer re-checks
      // cleanly: the citation's container gets the cited page's image.
      ensurePageMedia(container, order, urlFor(hit));
    }
  }

  return { records: clone, counts };
}