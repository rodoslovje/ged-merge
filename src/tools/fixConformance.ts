import type { Dataset, GedNode } from "../gedcom/types";
import { cloneNode, nodesEqual } from "../gedcom/node";
import { dropTitleBesideFileTitle, hangMediaLinesUnderFile, mimeFormOf } from "../gedcom/mediaForm";
import { hangAgencyUnderData, rebuildFamily, rebuildIndividual } from "../gedcom/edit";
import { type RecordPatch } from "../ui/historyTypes";
import { fixableConformance, nodeAtPath, tableFor, type ConformanceIssue } from "./conformance/conformance";
import { applyPassSafely, type PassJournal } from "./passSafety";

/**
 * The repairs the conformance check can make:
 *
 *  - **values** — an enumerated value written in another case than the
 *    standard's (`PEDI Adopted` → `adopted`, 7.0's `TYPE married` →
 *    `MARRIED`), a 7.0 name type outside the enumeration (`variation` →
 *    `AKA`, `formal` → `OTHER` with the word as its `PHRASE`), and a 7.0 date still carrying a 5.5.1 calendar escape
 *    (`@#DJULIAN@ 1700` → `JULIAN 1700`);
 *  - **repeats** — a line the standard allows once, repeated as an exact copy
 *    (same value, same lines beneath): the copies go, the first stays;
 *  - **forms** — a media file with no `FORM`, where the file's name says what
 *    it is (`.jpg`, a web address): the line is added;
 *  - **notes** — a 7.0 event line carrying text where only `Y` may stand
 *    (`BIRT ali Ravna Gora?`): the text moves word for word into a `NOTE` on
 *    the event, and the line is left bare;
 *  - **relocate** — a media record's `TITL`/`FORM` kept beside its `FILE`
 *    (the 5.5 shape): moved under the `FILE` in every media record at once,
 *    as the finding is one row for the whole habit;
 *  - **fileTitles** — the one repair that removes something, run only on the
 *    user's word: where a media record has a title beside its `FILE` and a
 *    different one under it, the one under the `FILE` (which the app shows)
 *    is kept;
 *  - **agency** — a source's own `AGNC`, which no version allows on the
 *    record: moved to `DATA.AGNC` in every source at once.
 *
 * A value outside the list, or a repeat that differs from the first, is the
 * user's question and is only reported. Lines on a record without an xref
 * (HEAD) are left alone, as an undo patch is keyed by xref.
 *
 * Mutates the dataset in place and returns `RecordPatch[]` for the undo stack.
 */
export type ConformanceFixKind = "values" | "repeats" | "forms" | "notes" | "relocate" | "fileTitles" | "agency";

/** One finding's own fix: its record, and the path of the line inside it. */
export interface ConformanceRef {
  id: string;
  path?: string;
}

function kindOf(issue: ConformanceIssue): ConformanceFixKind {
  return issue.agency ? "agency" : issue.relocate ? "relocate" : issue.repeat ? "repeats" : issue.toNote ? "notes" : issue.category === "missingLine" ? "forms" : "values";
}

/** What a file-wide pass does to one media (or source) record; returns the
 *  lines it moved or dropped. Each answers a habit row, which names no one
 *  record. */
type MediaPass = (obje: GedNode) => GedNode[];

/** The media pass a kind runs, when the file's own standard calls the lines
 *  beside FILE out of place (5.5 allows them). */
function mediaPassFor(records: GedNode[], kind: ConformanceFixKind | undefined, issues: ConformanceIssue[]): MediaPass | undefined {
  if (kind === "fileTitles") {
    return issues.some((i) => i.relocate && i.sample === "TITL") ? dropTitleBesideFileTitle : undefined;
  }
  if (!issues.some((i) => i.relocate)) return undefined;
  // 7.0 writes a FORM as a media type, so a moved `jpg` arrives as one.
  const form = tableFor(records)?.version.startsWith("7") ? mimeFormOf : undefined;
  return (obje) => hangMediaLinesUnderFile(obje, form);
}

/** How many findings of `kind` the fix would settle — the count on its button;
 *  for the media passes, the media records they would change. */
export function countFixableConformance(dataset: Dataset, kind: ConformanceFixKind): number {
  const fixable = fixableConformance(dataset.records);
  if (kind === "agency") {
    if (!fixable.some((i) => i.agency)) return 0;
    return dataset.records.filter((r) => r.tag === "SOUR" && r.xref && hangAgencyUnderData(cloneNode(r)).length > 0).length;
  }
  const pass = kind === "relocate" || kind === "fileTitles" ? mediaPassFor(dataset.records, kind, fixable) : undefined;
  if (pass) return dataset.records.filter((r) => r.tag === "OBJE" && r.xref && pass(cloneNode(r)).length > 0).length;
  return fixable.filter((i) => kindOf(i) === kind).length;
}

/** @param only — settle just the one finding a row names. */
export function fixConformance(dataset: Dataset, kind?: ConformanceFixKind, only?: ConformanceRef): RecordPatch[] {
  const scanned = fixableConformance(dataset.records, only?.id);
  if (kind === "fileTitles") return runMediaPass(dataset, mediaPassFor(dataset.records, kind, scanned));
  const issues = scanned.filter(
    (i) => (!kind || kindOf(i) === kind) && (!only || only.path === undefined || i.path === only.path),
  );
  const mediaPass = mediaPassFor(dataset.records, kind, issues);
  const byRecord = new Map<string, ConformanceIssue[]>();
  for (const issue of issues) {
    if (issue.relocate || issue.agency) continue;
    const list = byRecord.get(issue.recordId!);
    if (list) list.push(issue);
    else byRecord.set(issue.recordId!, [issue]);
  }
  const agencyPass = issues.some((i) => i.agency);
  if (!byRecord.size && !mediaPass && !agencyPass) return [];

  const records = new Map<string, GedNode>();
  for (const r of dataset.records) if (r.xref && byRecord.has(r.xref)) records.set(r.xref, r);

  const patches: RecordPatch[] = [];
  applyPassSafely(dataset, (journal) => {
    for (const [xref, list] of byRecord) {
      const rec = records.get(xref);
      if (!rec) continue;
      const before = cloneNode(rec);
      journal.keep(xref, before);
      // Every line is found before any is removed, so the paths stay valid;
      // values first, so copies whose shared value was recased still match.
      const targets = list
        .map((issue) => ({ issue, node: nodeAtPath(rec, issue.path ?? "") }))
        .sort((a, b) => Number(!!a.issue.repeat) - Number(!!b.issue.repeat));
      for (const { issue, node } of targets) {
        if (!node) continue;
        if (issue.repeat) {
          const tag = issue.sample!;
          const first = node.children.find((c) => c.tag === tag);
          node.children = node.children.filter((c) => c === first || c.tag !== tag || !nodesEqual(c, first!));
        } else if (issue.category === "missingLine" && issue.fix !== undefined) {
          node.children.unshift({ level: node.level + 1, tag: issue.sample!, value: issue.fix, children: [] });
        } else if (issue.toNote && node.value) {
          const text = node.value.trim();
          if (!node.children.some((c) => c.tag === "NOTE" && c.value?.trim() === text)) {
            node.children.push({ level: node.level + 1, tag: "NOTE", value: text, children: [] });
          }
          node.value = undefined;
        } else if (issue.fix !== undefined) {
          node.value = issue.fix;
          if (issue.fixPhrase && !node.children.some((c) => c.tag === "PHRASE")) {
            node.children.unshift({ level: node.level + 1, tag: "PHRASE", value: issue.fixPhrase, children: [] });
          }
        }
      }
      patches.push(recordPatch(dataset, xref, rec, before));
    }
    if (mediaPass) patches.push(...mediaPassOver(dataset.records, mediaPass, journal));
    if (agencyPass) patches.push(...mediaPassOver(dataset.records, hangAgencyUnderData, journal, "SOUR"));
  });
  return patches;
}

/** Run a pass over every media (or source) record, one undo patch per record
 *  it changed. */
function mediaPassOver(records: GedNode[], pass: MediaPass, journal: PassJournal, tag = "OBJE"): RecordPatch[] {
  const patches: RecordPatch[] = [];
  for (const rec of records) {
    if (rec.tag !== tag || !rec.xref) continue;
    // Tried on a copy first, so the journal holds a record only when it changes.
    if (!pass(cloneNode(rec)).length) continue;
    const before = cloneNode(rec);
    journal.keep(rec.xref, before);
    pass(rec);
    patches.push({ type: "record", id: rec.xref, before, after: cloneNode(rec) });
  }
  return patches;
}

function runMediaPass(dataset: Dataset, pass: MediaPass | undefined): RecordPatch[] {
  if (!pass) return [];
  return applyPassSafely(dataset, (journal) => mediaPassOver(dataset.records, pass, journal));
}

/** A record rewritten in place: the typed model brought back in step, and the
 *  undo patch from its `before` clone. */
export function recordPatch(dataset: Dataset, xref: string, rec: GedNode, before: GedNode): RecordPatch {
  const indi = dataset.individuals.get(xref);
  const fam = dataset.families.get(xref);
  if (indi && indi.raw === rec) {
    rebuildIndividual(dataset, indi);
    return { type: "individual", id: xref, before, after: cloneNode(rec) };
  }
  if (fam && fam.raw === rec) {
    rebuildFamily(dataset, fam);
    return { type: "family", id: xref, before, after: cloneNode(rec) };
  }
  return { type: "record", id: xref, before, after: cloneNode(rec) };
}
