import { buildDataset, LINK_TAGS, looksLikeUrl } from "../gedcom/builder";
import type { Dataset, GedNode, ParseResult } from "../gedcom/types";
import { cloneNode } from "../gedcom/node";
import { normalizeDateString } from "./date";
import { normalizePlaceString } from "./place";
import { rewriteLinkLang } from "./links";
import { reformatPlace, reshapesLayout } from "./placeReformat";
import { inferDateProfile } from "./profile";
import type { MasterProfile, NormalizationReport, NormalizeOptions, NormChange, PlaceTargetFormat } from "./types";
import { walkNodes } from "./walk";

const MAX_EXAMPLES = 12;

/** Default: every normalization pass runs (load-time behavior). */
const ALL_PASSES: NormalizeOptions = { dates: true, places: true, links: true };

/**
 * Normalize a compare dataset to the master's conventions.
 *
 * Operates on the lossless raw tree (so the eventual export carries the
 * normalized values) and then rebuilds the typed model so structured fields
 * stay in sync. Returns a fresh dataset plus a report of what changed; the
 * input is not mutated.
 *
 * `sourceDateValues`, when the caller already collected the compare file's
 * DATE values (e.g. for displaying its detected date format), lets the
 * source-order inference below reuse them instead of walking the tree again.
 *
 * `options` selects which passes run; by default all do. The bulk-normalize
 * tool uses it to let the user apply only some of the transformations.
 */
export function normalizeDataset(
  compare: Dataset,
  profile: MasterProfile,
  sourceDateValues?: string[],
  options: NormalizeOptions = ALL_PASSES,
): { dataset: Dataset; report: NormalizationReport } {
  const records = cloneRecords(compare.records);
  const report: NormalizationReport = {
    datesChanged: 0,
    dateExamples: [],
    placesReshaped: 0,
    placeExamples: [],
    linksConverted: 0,
    linkExamples: [],
  };
  // Track the kind of each recorded change so the examples illustrate distinct
  // transformations (padding, reordering, casing…) rather than repeating the
  // same one many times.
  const seenDate = new Set<string>();
  const seenPlace = new Set<string>();
  const seenLink = new Set<string>();

  // The compare file may itself use an ambiguous numeric layout (is "05/06/1989"
  // D/M or M/D?). Infer its own order so we parse its dates correctly before
  // re-rendering them in the master's style.
  const sourceOrder = inferSourceOrder(compare, sourceDateValues);

  walkNodes(records, (node) => {
    if (node.value === undefined) return;
    if (node.tag === "DATE") {
      if (!options.dates) return;
      const next = normalizeDateString(node.value, profile.date, sourceOrder);
      if (next !== node.value) {
        record(report.dateExamples, seenDate, node.value, next);
        report.datesChanged++;
        node.value = next;
      }
    } else if (node.tag === "PLAC" || node.tag === "ADDR") {
      // Place text is left as-is; only tidy whitespace, and do so silently
      // (whitespace fixes are not interesting enough to count or list).
      node.value = normalizePlaceString(node.value);
    } else if (LINK_TAGS.has(node.tag) && looksLikeUrl(node.value)) {
      if (!options.links) return;
      // Matricula Online / Geneanet cemetery links carry a UI language in the
      // URL itself; rewrite to the master's language so the compare/edit
      // screens already show matching links and no further conversion is
      // needed at merge or export time.
      const next = rewriteLinkLang(node.value, profile.linkLangs);
      if (next !== node.value) {
        record(report.linkExamples, seenLink, node.value, next);
        report.linksConverted++;
        node.value = next;
      }
    }
  });

  // Reshape PLAC/ADDR/NOTE into the master's layout, e.g. splitting a packed
  // "Town (Country), Street No" into structured PLAC + ADDR, or folding a
  // structured PLAC + ADDR into one packed PLAC — so the compare/edit screens
  // already show places in the master's shape and no reshaping is needed when
  // the record is later merged or saved.
  if (options.places && reshapesLayout(profile.placeFmt.layout)) {
    walkNodes(records, (node) => {
      reshapePlaceNode(node, profile.placeFmt, report, seenPlace);
    });
  }

  const parsed: ParseResult = {
    version: compare.version,
    charset: compare.charset,
    records,
    warnings: compare.warnings,
    eol: compare.eol,
    finalNewline: compare.finalNewline,
  };
  return { dataset: buildDataset(parsed), report };
}

/**
 * Reshape a node's PLAC/ADDR (if any) into the master's layout, recording an
 * example when the text actually changes. A pre-existing AGNC absorbs a
 * leftover parish detail rather than duplicating it in a second AGNC node.
 */
function reshapePlaceNode(
  node: GedNode,
  fmt: PlaceTargetFormat,
  report: NormalizationReport,
  seen: Set<string>,
): void {
  const placNode = node.children.find((c) => c.tag === "PLAC");
  const addrNode = node.children.find((c) => c.tag === "ADDR");
  if (!placNode && !addrNode) return;
  // A PLAC carrying an explicit FORM declares a fixed jurisdiction schema —
  // each comma part maps to a FORM label (e.g. "Place,Municipality,County,…").
  // Reshaping could drop empty or middle parts and break that alignment, so
  // leave such places untouched.
  if (placNode?.children.some((c) => c.tag === "FORM")) return;
  const placRaw = placNode?.value;
  const addrRaw = addrNode?.value;
  const agncRaw = node.children.find((c) => c.tag === "AGNC")?.value;
  const r = reformatPlace(placRaw, addrRaw, fmt, agncRaw);

  const before = [placRaw, addrRaw].filter(Boolean).join(" · ");
  const after = [r.plac, r.addr, r.agency].filter(Boolean).join(" · ");
  if (before === after) return;

  const existingAgency = node.children.find((c) => c.tag === "AGNC");
  if (r.plac !== undefined) {
    // Reuse the original PLAC node when there is one, keeping its children
    // (FORM, MAP/LONG/LATI coordinates) and its position among the event's
    // siblings; only synthesize a fresh node when the PLAC is newly created
    // out of an ADDR. Dropping it and pushing a replacement would discard
    // those sub-nodes and move the place to the end of the event.
    const placeNode = placNode ?? plainNode("PLAC", r.plac);
    placeNode.value = r.plac;
    // Surface the pre-reshape text as a tooltip: the original PLAC when it
    // changed, plus the original ADDR when it was absorbed into the PLAC
    // rather than kept as its own row.
    const reshapedFromParts = [
      placRaw && placRaw !== r.plac ? placRaw : undefined,
      addrRaw && r.addr === undefined ? addrRaw : undefined,
    ].filter(Boolean) as string[];
    if (reshapedFromParts.length > 0) placeNode.reshapedFrom = reshapedFromParts.join(" · ");
    if (!placNode) node.children.push(placeNode);
  } else if (placNode) {
    node.children = node.children.filter((c) => c !== placNode);
  }
  if (r.addr !== undefined) {
    const addrNodeOut = addrNode ?? plainNode("ADDR", r.addr);
    addrNodeOut.value = r.addr;
    if (addrRaw && addrRaw !== r.addr) addrNodeOut.reshapedFrom = addrRaw;
    if (!addrNode) node.children.push(addrNodeOut);
  } else if (addrNode) {
    node.children = node.children.filter((c) => c !== addrNode);
  }
  if (r.agency) {
    if (existingAgency) {
      existingAgency.value = existingAgency.value ? `${existingAgency.value}; ${r.agency}` : r.agency;
    } else node.children.push(plainNode("AGNC", r.agency));
  }

  report.placesReshaped++;
  record(report.placeExamples, seen, before, after);
}

function plainNode(tag: string, value: string): GedNode {
  return { level: 0, tag, children: [], value };
}

/** Infer the compare file's own numeric date order, used to parse its dates.
 *  Reuses `dateValues` when the caller already collected them, rather than
 *  walking the tree again. */
function inferSourceOrder(compare: Dataset, dateValues?: string[]) {
  const values = dateValues ?? collectDateValues(compare);
  return inferDateProfile(values).numeric?.order;
}

function collectDateValues(compare: Dataset): string[] {
  const dateValues: string[] = [];
  walkNodes(compare.records, (node) => {
    if (node.tag === "DATE" && node.value !== undefined) dateValues.push(node.value);
  });
  return dateValues;
}

function record(examples: NormChange[], seen: Set<string>, before: string, after: string): void {
  if (examples.length >= MAX_EXAMPLES) return;
  const signature = `${shape(before)}→${shape(after)}`;
  if (seen.has(signature)) return;
  seen.add(signature);
  examples.push({ before, after });
}

/**
 * Reduce a value to the "shape" of its transformation so two changes of the
 * same kind share a signature: digit runs collapse to `#`, letter runs to `A`,
 * and separators/spacing are kept verbatim.
 */
function shape(value: string): string {
  return value.replace(/\d+/g, "#").replace(/\p{L}+/gu, "A");
}

/** Deep clone the record forest so normalization doesn't mutate the input. */
function cloneRecords(records: GedNode[]): GedNode[] {
  return records.map(cloneNode);
}
