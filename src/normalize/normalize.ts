import { buildDataset } from "../gedcom/builder";
import type { Dataset, GedNode, ParseResult } from "../gedcom/types";
import { normalizeDateString } from "./date";
import { normalizePlaceString } from "./place";
import { inferDateProfile } from "./profile";
import type { MasterProfile, NormalizationReport, NormChange } from "./types";
import { walkNodes } from "./walk";

const MAX_EXAMPLES = 8;

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
    placesChanged: 0,
    dateExamples: [],
    placeExamples: [],
  };

  // The compare file may itself use an ambiguous numeric layout (is "05/06/1989"
  // D/M or M/D?). Infer its own order so we parse its dates correctly before
  // re-rendering them in the master's style.
  const sourceOrder = inferSourceOrder(compare);

  walkNodes(records, (node) => {
    if (node.value === undefined) return;
    if (node.tag === "DATE") {
      const next = normalizeDateString(node.value, profile.date, sourceOrder);
      if (next !== node.value) {
        record(report.dateExamples, node.value, next);
        report.datesChanged++;
        node.value = next;
      }
    } else if (node.tag === "PLAC") {
      const next = normalizePlaceString(node.value, profile.place);
      if (next !== node.value) {
        record(report.placeExamples, node.value, next);
        report.placesChanged++;
        node.value = next;
      }
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

function record(examples: NormChange[], before: string, after: string): void {
  if (examples.length < MAX_EXAMPLES) examples.push({ before, after });
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
