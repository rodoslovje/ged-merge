import { buildDataset, LINK_TAGS, looksLikeUrl } from "../gedcom/builder";
import type { Dataset, GedNode, ParseResult } from "../gedcom/types";
import { cloneNode, firstChild } from "../gedcom/node";
import { dropPlaceholderDates, normalizeDateString } from "./date";
import { normalizePlaceString } from "./place";
import { rewriteLinkLang } from "./links";
import { reformatPlace, reshapesLayout, respellSeparator } from "./placeReformat";
import { inferDateProfile } from "./profile";
import type { MainProfile, NormalizationReport, NormalizeOptions, NormChange, PlaceTargetFormat } from "./types";
import { migrateVersion, versionFamily } from "./migrate";
import { reshapeNameVariants } from "./nameVariants";
import { reshapeUnknownNames } from "./unknownName";
import { walkNodes } from "./walk";
import { VENDOR_TAG_ALIASES } from "../gedcom/vendorTags";
import { normalizeFamilyStatus, normalizePedigree } from "./familyStatus";
import { normalizePrivacyStyle } from "./privacy";
import { convertUpdToChan, stripInternalTags } from "./vendorInternal";

const MAX_EXAMPLES = 12;

/** Default: every normalization pass runs (load-time behavior). */
const ALL_PASSES: NormalizeOptions = { dates: true, places: true, links: true, names: true, vendorTags: true };

/**
 * Normalize a compare dataset to the main's conventions.
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
  profile: MainProfile,
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
    nameVariantsReshaped: 0,
    nameVariantExamples: [],
    unknownNamesReshaped: 0,
    unknownNameExamples: [],
    vendorTagsRenamed: 0,
    vendorTagExamples: [],
    internalStripped: 0,
    internalExamples: [],
  };
  // Track the kind of each recorded change so the examples illustrate distinct
  // transformations (padding, reordering, casing…) rather than repeating the
  // same one many times.
  const seenDate = new Set<string>();
  const seenPlace = new Set<string>();
  const seenLink = new Set<string>();
  const seenName = new Set<string>();
  const seenUnknown = new Set<string>();
  const seenVendor = new Set<string>();

  // Version migration runs first: it rewrites version-specific *syntax*
  // (5.5.1 `INT`/phrase dates, `NOTE` records vs 7.0 `SNOTE`, …) into the
  // main's spec so the house-style passes below see parseable values. An
  // "unknown" declared version is treated as legacy 5.5.x, matching the
  // serializer's download convention.
  if (options.version !== false && versionFamily(compare.version) !== versionFamily(profile.version)) {
    const seenMigration = new Set<string>();
    const examples: NormChange[] = [];
    const changed = migrateVersion(
      records,
      versionFamily(compare.version),
      versionFamily(profile.version),
      (before, after) => record(examples, seenMigration, before, after),
    );
    // Reported even when nothing needed rewriting — the versions still differ,
    // and "migrated: 0" tells the user that was checked rather than skipped.
    report.versionMigration = { from: compare.version, to: profile.version, changed, examples };
  }

  // The compare file may itself use an ambiguous numeric layout (is "05/06/1989"
  // D/M or M/D?). Infer its own order so we parse its dates correctly before
  // re-rendering them in the main's style.
  const sourceOrder = inferSourceOrder(compare, sourceDateValues);

  // Only individuals and families carry the genealogical dates/places/links we
  // reshape. Repositories, sources, the header, etc. are left untouched so their
  // institutional addresses (e.g. an archive's "p.p. 114" P.O. box) and other
  // metadata are not rewritten. The skipped records still pass through to output.
  const editable = records.filter((r) => r.tag === "INDI" || r.tag === "FAM");

  // Rewrite vendor-tag synonyms to their canonical form (`_MILI` → `_MILT`,
  // Brother's Keeper's two spellings of the military-service event) so the
  // rest of the app — event lift, review rows, merge — only ever sees the
  // supported spelling. Runs before the value walk: a pure tag rename, values
  // and children travel unchanged. `preserveVendorTags` exempts the file's own
  // native dialect when the bulk-normalize tool re-renders a file to itself.
  if (options.vendorTags) {
    walkNodes(editable, (node) => {
      const canonical = VENDOR_TAG_ALIASES[node.tag];
      if (canonical && !options.preserveVendorTags?.has(node.tag)) {
        record(report.vendorTagExamples, seenVendor, node.tag, canonical);
        report.vendorTagsRenamed++;
        node.tag = canonical;
      }
    });
    // Consolidate the vendor partnership-status encodings (MyHeritage REL_*
    // events, FTM _STAT, the BK _NMR/_MSTAT/_MARRIED trio) into `_MSTAT`,
    // agreeing _FREL/_MREL child relationships into standard FAMC PEDI, and
    // `_UPD` last-updated stamps into the standard CHAN structure.
    for (const change of [...normalizeFamilyStatus(editable), ...normalizePedigree(records), ...convertUpdToChan(editable)]) {
      report.vendorTagsRenamed++;
      record(report.vendorTagExamples, seenVendor, change.before, change.after);
    }
    // Rewrite privacy markers into the main's dialect (PRIV / _PRIV / RESN) —
    // over all records, since shared NOTE/OBJE records carry them too. Skipped
    // when the main has no dialect of its own.
    if (profile.privacyStyle) {
      for (const change of normalizePrivacyStyle(records, profile.privacyStyle)) {
        report.vendorTagsRenamed++;
        record(report.vendorTagExamples, seenVendor, change.before, change.after);
      }
    }
  }

  // Opt-in, deliberately lossy: drop software-internal bookkeeping tags
  // (`_UPD`, `_RINS`, `_COLOR*`, `_FLGS`, …) from people and families. Never
  // runs at load time — only when the bulk-normalize tool's checkbox asks.
  if (options.stripInternal) {
    const seenStrip = new Set<string>();
    for (const change of stripInternalTags(editable)) {
      report.internalStripped++;
      record(report.internalExamples, seenStrip, change.before, change.after);
    }
  }

  walkNodes(editable, (node) => {
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
      // URL itself; rewrite to the main's language so the compare/edit
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

  // An all-placeholder date (".__.____") carries no information. When the main
  // has no placeholder-date convention of its own, strip it entirely rather than
  // keep a foreign "__.__.____" marker — the date analog of reshapeUnknownNames'
  // blank default for names. (When the main *does* use placeholder dates, the
  // walk above has already reshaped these to its layout, so we leave them.)
  if (options.dates && !profile.date.numeric?.placeholder) {
    for (const rec of editable) {
      for (const before of dropPlaceholderDates(rec)) {
        report.datesChanged++;
        record(report.dateExamples, seenDate, before, "(blank)");
      }
    }
  }

  // Reshape PLAC/ADDR/NOTE into the main's layout, e.g. splitting a packed
  // "Town (Country), Street No" into structured PLAC + ADDR, or folding a
  // structured PLAC + ADDR into one packed PLAC — so the compare/edit screens
  // already show places in the main's shape and no reshaping is needed when
  // the record is later merged or saved.
  // A pass-through layout still runs the pass when the reader has chosen a
  // comma form: respelling it is then the one edit that pass makes.
  if (options.places && (reshapesLayout(profile.placeFmt.layout) || profile.placeFmt.separatorEnforced)) {
    walkNodes(editable, (node) => {
      reshapePlaceNode(node, profile.placeFmt, report, seenPlace);
    });
  }

  // The comma form is a whole-file convention, so it also reaches the places
  // `editable` holds back from reshaping — a source's own PLAC. Only the
  // spacing changes, so the reason those records are excluded (their layout,
  // e.g. an archive's institutional ADDR, must not be rewritten) still holds.
  if (options.places && profile.placeFmt.separatorEnforced) {
    const rest = records.filter((r) => r.tag !== "INDI" && r.tag !== "FAM");
    walkNodes(rest, (node) => {
      if (node.tag === "PLAC") respellPlaceNode(node, profile.placeFmt, report, seenPlace);
    });
  }

  // Rewrite alternate names (married/birth/aka/nick) into the main's
  // convention — an inline sub-tag on the primary NAME vs. a separate `TYPE`
  // record — and recase `TYPE` tokens to the main's spelling, so the styles
  // match for comparison/merge and stay consistent in the export. Variants the
  // main doesn't use are left untouched (never dropped).
  if (options.names) {
    for (const rec of editable) {
      if (rec.tag !== "INDI") continue;
      for (const change of reshapeNameVariants(rec, profile.nameVariants)) {
        report.nameVariantsReshaped++;
        record(report.nameVariantExamples, seenName, change.before, change.after);
      }
      // Rewrite unknown-name placeholders (NN, ____, ????) to the main's
      // convention, so the user's file never inherits a foreign placeholder.
      for (const change of reshapeUnknownNames(rec, profile.unknownName)) {
        report.unknownNamesReshaped++;
        record(report.unknownNameExamples, seenUnknown, change.before, change.after);
      }
    }
  }

  const parsed: ParseResult = {
    version: compare.version,
    charset: compare.charset,
    records,
    warnings: compare.warnings,
    eol: compare.eol,
    finalNewline: compare.finalNewline,
  };
  const dataset = buildDataset(parsed);
  // Provenance isn't derivable from the records — carry it onto the rebuild so
  // matching still knows a CSV-imported compare is a sparse-birth source.
  if (compare.sparseBirthDates) dataset.sparseBirthDates = true;
  return { dataset, report };
}

/**
 * Reshape a node's PLAC/ADDR (if any) into the main's layout, recording an
 * example when the text actually changes. A pre-existing AGNC absorbs a
 * leftover parish detail rather than duplicating it in a second AGNC node.
 */
function reshapePlaceNode(
  node: GedNode,
  fmt: PlaceTargetFormat,
  report: NormalizationReport,
  seen: Set<string>,
): void {
  const placNode = firstChild(node, "PLAC");
  const addrNode = firstChild(node, "ADDR");
  if (!placNode && !addrNode) return;
  // A PLAC carrying an explicit FORM declares a fixed jurisdiction schema —
  // each comma part maps to a FORM label (e.g. "Place,Municipality,County,…").
  // Reshaping could drop empty or middle parts and break that alignment, so
  // the layout is left alone. The comma form still applies: respelling moves
  // whitespace only, leaving the parts and their order — and so the FORM
  // alignment — exactly as they were.
  if (placNode?.children.some((c) => c.tag === "FORM")) {
    respellPlaceNode(placNode, fmt, report, seen);
    return;
  }
  const placRaw = placNode?.value;
  const addrRaw = addrNode?.value;
  const r = reformatPlace(placRaw, addrRaw, fmt);

  const before = [placRaw, addrRaw].filter(Boolean).join(" · ");
  const after = [r.plac, r.addr, r.agency].filter(Boolean).join(" · ");
  if (before === after) return;

  const existingAgency = firstChild(node, "AGNC");
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
      // Skip when the AGNC already names this parish — re-normalizing (e.g. a
      // previously saved file) must not append the same parish again.
      if (!existingAgency.value?.toLowerCase().includes(r.agency.toLowerCase())) {
        existingAgency.value = existingAgency.value ? `${existingAgency.value}; ${r.agency}` : r.agency;
      }
    } else node.children.push(plainNode("AGNC", r.agency));
  }

  report.placesReshaped++;
  record(report.placeExamples, seen, before, after);
}

/**
 * Rewrite one PLAC's comma form in place, and its FORM's along with it. Used
 * where the layout must not be touched — a FORM-pinned place, or a place on a
 * record the reshape pass skips — but the reader's chosen comma form still
 * applies, since only whitespace moves. A no-op until a form has actually been
 * chosen (see respellSeparator).
 *
 * FORM is a comma list of the labels the place's own parts map to, so it is
 * respelled together with them: leaving it behind would put both spellings of
 * the same convention on two consecutive lines. This also reaches the file-wide
 * `HEAD`.`PLAC`.`FORM` default, a PLAC that has only a FORM to respell.
 */
function respellPlaceNode(
  placNode: GedNode,
  fmt: PlaceTargetFormat,
  report: NormalizationReport,
  seen: Set<string>,
): void {
  const formNode = firstChild(placNode, "FORM");
  const changes: [GedNode, string, string][] = [];
  for (const node of [placNode, formNode]) {
    const before = node?.value;
    const after = respellSeparator(before, fmt);
    if (node && after !== undefined && after !== before) changes.push([node, before!, after]);
  }
  if (!changes.length) return;
  for (const [node, before, after] of changes) {
    node.value = after;
    if (node === placNode) node.reshapedFrom = before;
  }
  // One place changed, however many of its lines carried the comma form.
  report.placesReshaped++;
  record(report.placeExamples, seen, changes[0][1], changes[0][2]);
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
