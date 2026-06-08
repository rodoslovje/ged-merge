import { buildDataset } from "../gedcom/builder";
import type { Dataset, GedNode, ParseResult } from "../gedcom/types";
import { normalizeDateString } from "./date";
import { normalizePlaceString } from "./place";
import { inferDateProfile } from "./profile";
import type { MasterProfile, NormalizationReport, NormChange } from "./types";
import { walkNodes } from "./walk";

const MAX_EXAMPLES = 12;

/**
 * Normalize a compare dataset to the master's conventions.
 *
 * Operates on the lossless raw tree (so the eventual export carries the
 * normalized values) and then rebuilds the typed model so structured fields
 * stay in sync. Returns a fresh dataset plus a report of what changed; the
 * input is not mutated.
 */
export function normalizeDataset(
  compare: Dataset,
  profile: MasterProfile,
): { dataset: Dataset; report: NormalizationReport } {
  const records = cloneRecords(compare.records);
  const report: NormalizationReport = {
    datesChanged: 0,
    dateExamples: [],
  };
  // Track the kind of each recorded change so the examples illustrate distinct
  // transformations (padding, reordering, casing…) rather than repeating the
  // same one many times.
  const seenDate = new Set<string>();

  // The compare file may itself use an ambiguous numeric layout (is "05/06/1989"
  // D/M or M/D?). Infer its own order so we parse its dates correctly before
  // re-rendering them in the master's style.
  const sourceOrder = inferSourceOrder(compare);

  walkNodes(records, (node) => {
    if (node.value === undefined) return;
    if (node.tag === "DATE") {
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
    }
  });

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

/** Infer the compare file's own numeric date order, used to parse its dates. */
function inferSourceOrder(compare: Dataset) {
  const dateValues: string[] = [];
  walkNodes(compare.records, (node) => {
    if (node.tag === "DATE" && node.value !== undefined) dateValues.push(node.value);
  });
  return inferDateProfile(dateValues).numeric?.order;
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
function cloneNode(node: GedNode): GedNode {
  const copy: GedNode = { level: node.level, tag: node.tag, children: node.children.map(cloneNode) };
  if (node.xref !== undefined) copy.xref = node.xref;
  if (node.value !== undefined) copy.value = node.value;
  return copy;
}
