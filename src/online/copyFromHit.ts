/**
 * Take what an index hit adds into a person of the main file: the rows the
 * reader ticked in the comparison, applied the way Merge applies a confirmed
 * match's choices (`applyRows`), and — when asked — the hit cited as the
 * source of every event the copy changed.
 *
 * Mutates the person's record in place; the caller snapshots it around the
 * call for undo (Edit's `commitTo`).
 */
import type { Dataset, GedNode, Individual } from "../gedcom/types";
import { attachSourceCitation, EVENT_CHILD_ORDER, INDI_CHILD_ORDER } from "../gedcom/edit";
import { indiEventNodes } from "../gedcom/eventTags";
import { relevel } from "../gedcom/mediaForm";
import { applyRows } from "../merge/applyFields";
import { linkPlacementFor } from "../merge/linkPlacement";
import { emptyChangeReport, INDI_HANDLED } from "../merge/merge";
import { individualFieldRows } from "../review/fields";
import type { FieldChoice } from "../review/types";
import { recognizeSourceUrl, siteQuay } from "../tools/sourceReshape";
import type { AddSourceResult } from "../ui/AddSourceDialog";
import type { Translate } from "../locales/i18n";

/** A citation to write on what a copy changed. */
export interface CopyCitation {
  sourceXref: string;
  page?: string;
  quay?: string;
}

/** The source a hit's page becomes — what Add source would propose for the
 *  link (title, author, agency, quality), so a copy cites it without the
 *  dialog: the index's own entry, a Matricula register page, a grave. */
export function hitSourceFields(url: string): AddSourceResult {
  const rec = recognizeSourceUrl(url);
  return {
    url: rec?.bookUrl ?? url,
    title: rec?.proposed.title,
    author: rec?.proposed.author,
    agency: rec?.proposed.agency,
    site: rec?.site,
    page: rec?.page,
    quay: rec ? siteQuay(rec.site, url) : undefined,
  };
}

/**
 * Apply the ticked rows (`fields`, row key → "incoming") of `hit` onto
 * `person`. The rows are built here from the same two records the comparison
 * showed, so each key addresses the same field. With `cite`, every event the
 * copy created or changed cites the hit; a copy that touched no event (a name,
 * a sex) cites it on the person.
 */
export function copyHitRows(
  dataset: Dataset,
  person: Individual,
  hit: Individual,
  hitDs: Dataset,
  fields: Record<string, FieldChoice>,
  t: Translate,
  cite?: CopyCitation,
): void {
  const record = person.raw;
  const before = new Map<GedNode, string>(record.children.map((c) => [c, JSON.stringify(c)]));
  const rows = individualFieldRows(t, person, hit, dataset, hitDs);
  // Every row the reader did not tick keeps the person's value: left out,
  // `applyRows` would take its default, which for what the index adds is the
  // index's.
  const choices: Record<string, FieldChoice> = {};
  for (const row of rows) choices[row.key] = fields[row.key] ?? "main";
  applyRows(
    record,
    hit.raw,
    person.id,
    rows,
    choices,
    emptyChangeReport(),
    new Set<string>(),
    INDI_HANDLED,
    t,
    linkPlacementFor(dataset),
    dataset.records,
    new Map(),
  );
  // Lines the merge builds are made at level 0 wherever they land; Edit and
  // the citations below read `level`, so set it from depth.
  relevel(record, 0);
  if (!cite) return;
  const changed = record.children.some((c) => before.get(c) !== JSON.stringify(c));
  if (!changed) return;
  const events = indiEventNodes(record).filter((e) => before.get(e) !== JSON.stringify(e));
  if (events.length) {
    for (const event of events) attachSourceCitation(event, cite.sourceXref, cite.page, EVENT_CHILD_ORDER, cite.quay);
  } else {
    attachSourceCitation(record, cite.sourceXref, cite.page, INDI_CHILD_ORDER, cite.quay);
  }
}
