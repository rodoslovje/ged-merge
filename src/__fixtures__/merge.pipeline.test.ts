/**
 * Full-merge pipeline regression suite ("golden" merge tests).
 *
 * The unit tests in `merge/merge.test.ts` exercise the engine on hand-written
 * five-line GEDCOMs; nothing pinned down what a *whole realistic merge*
 * produces end-to-end. This suite runs the exact pipeline the app runs —
 * parse → buildDataset → inferMasterProfile → normalizeDataset →
 * matchDatasets → duplicate consolidation → scripted decisions →
 * mergeDecisions → CHAN stamping → download serialization — over the shipped
 * royal-family samples (which genuinely overlap: shared monarchs), and pins:
 *
 *   GOLDEN  — the serialized blocks of every record the merge touched or
 *             created, plus the plain-text change report. Any unintended
 *             change to merge mechanics (field application, stitching,
 *             grafting, xref remapping, event ordering, audit stamping)
 *             shows up as a reviewable snapshot diff instead of surfacing
 *             months later in a user's master file.
 *   INVARIANTS — the output parses cleanly, reaches a serialize fixed-point,
 *             introduces no dangling xrefs and no broken family links.
 *   NO-OP   — merging a file into itself with default choices must change
 *             nothing, byte-for-byte, across the whole anonymized corpus
 *             (every exporter/charset/eol flavour we support).
 *
 * Snapshots live in `golden/`; after an *intentional* mechanics change,
 * review the diff and refresh with `npx vitest run -u`.
 */

/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseGedcom } from "../gedcom/parser";
import { buildDataset } from "../gedcom/builder";
import { downloadOptions, ensureUtf8Charset, serializeGedcom } from "../gedcom/serialize";
import { stampChanCrea } from "../gedcom/chanCrea";
import type { Dataset, GedNode } from "../gedcom/types";
import { inferMasterProfile } from "../normalize/profile";
import { normalizeDataset } from "../normalize/normalize";
import { matchDatasets } from "../match/engine";
import type { MatchResult } from "../match/types";
import { mergeDuplicate } from "../tools/mergeDuplicate";
import { findDanglingXrefs } from "../tools/structure";
import { validateDataset } from "../tools/validate";
import { decisionKey, mergeDecisions, formatReport, type ChangeReport } from "../merge/merge";
import type { ImportBranchRequest } from "../merge/merge";
import type { CandidateDecision } from "../review/types";

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLES = resolve(HERE, "..", "..", "public", "samples");
const CORPUS = resolve(HERE, "corpus");

function readBuffer(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/** The merge engine takes a translator only for report labels; raw keys keep
 *  the snapshots locale-independent (mirrors the worker's `rawLabel`). */
const tr = (key: string) => key;

/** Mirror the worker pipeline: load a master, normalize a compare against its
 *  profile, match, and consolidate incoming duplicate clusters. */
function loadPair(masterBuf: ArrayBuffer, compareBuf: ArrayBuffer): {
  master: Dataset;
  compare: Dataset;
  result: MatchResult;
} {
  const master = buildDataset(parseGedcom(masterBuf));
  const profile = inferMasterProfile(master);
  const compareRaw = buildDataset(parseGedcom(compareBuf));
  const { dataset: compare } = normalizeDataset(compareRaw, profile);
  let result = matchDatasets(master, compare);
  if (result.incomingDuplicates?.length) {
    for (const { keepId, mergeIds } of result.incomingDuplicates) {
      for (const id of mergeIds) {
        mergeDuplicate(compare, keepId, id, { status: "confirmed", fields: {} }, tr);
      }
    }
    result = { individuals: result.individuals };
  }
  return { master, compare, result };
}

/** Candidates ranked deterministically, deduplicated to unique master/compare pairing. */
function uniquePairs(result: MatchResult, minScore: number) {
  const ranked = [...result.individuals].sort(
    (a, b) => b.score - a.score || a.masterId.localeCompare(b.masterId) || a.compareId.localeCompare(b.compareId),
  );
  const seenMaster = new Set<string>();
  const seenCompare = new Set<string>();
  return ranked.filter((c) => {
    if (c.score < minScore || seenMaster.has(c.masterId) || seenCompare.has(c.compareId)) return false;
    seenMaster.add(c.masterId);
    seenCompare.add(c.compareId);
    return true;
  });
}

/** Serialized blocks of every record the merge touched or created, in output
 *  order — includes imported SOUR/NOTE/OBJE records (absent from the change
 *  report) by also treating any output xref the master didn't have as touched. */
function touchedBlocks(output: GedNode[], masterRecords: GedNode[], report: ChangeReport): string {
  const masterXrefs = new Set(masterRecords.filter((r) => r.xref).map((r) => r.xref!));
  const touched = new Set(Object.keys(report.recordKinds));
  const blocks = output.filter((r) => r.xref && (touched.has(r.xref) || !masterXrefs.has(r.xref)));
  return serializeGedcom(blocks);
}

describe("full merge: EuropeRoyalFamilies into EnglishTudorRoyalFamily", () => {
  const { master, compare, result } = loadPair(
    readBuffer(resolve(SAMPLES, "EnglishTudorRoyalFamily.ged")),
    readBuffer(resolve(SAMPLES, "EuropeRoyalFamilies.ged")),
  );

  // Scripted decisions, chosen to exercise the whole mechanics surface:
  //  - confirm every unique pair scoring ≥90 with default field choices
  //    (≥90 rather than ≥95: royals missing a birth date on one side now
  //    carry the honest missing-key penalty instead of the marriage-derived
  //    0.85, so corroborated true pairs sit in the 91–92 relative-boost band),
  //  - take all children of two anchor confirmed people (family stitching
  //    incl. new-person creation),
  //  - graft whole branches (ancestors of the 1st anchor, descendants of the
  //    2nd),
  //  - reject the best sub-90 candidate, so grafts must import that person as
  //    new instead of reusing the rejected join point.
  const picked = uniquePairs(result, 90);
  const rejected = uniquePairs(result, 0).find((c) => c.score < 90);
  // Graft/stitch anchors: two confirmed people chosen by stable id order, NOT
  // by score rank. Rank order among near-ties shifts whenever the scoring is
  // tuned, and a swapped anchor regrafts an entirely different branch —
  // thousands of golden lines of churn with no mechanics change. Id order
  // keeps the goldens pinned to the same two branches.
  const anchors = [...picked]
    .sort((a, b) => a.masterId.localeCompare(b.masterId) || a.compareId.localeCompare(b.compareId))
    .slice(0, 2);
  const anchorIds = new Set(anchors.map((c) => c.compareId));
  const decisions = new Map<string, CandidateDecision>();
  for (const c of picked) {
    const takenChildren = anchorIds.has(c.compareId)
      ? (compare.individuals.get(c.compareId)?.spouseOf ?? []).flatMap(
          (fid) => compare.families.get(fid)?.children ?? [],
        )
      : undefined;
    decisions.set(decisionKey("individual", c.masterId, c.compareId), {
      status: "confirmed",
      fields: {},
      ...(takenChildren?.length ? { takenChildren } : {}),
    });
  }
  if (rejected) {
    decisions.set(decisionKey("individual", rejected.masterId, rejected.compareId), {
      status: "rejected",
      fields: {},
    });
  }
  const branches: ImportBranchRequest[] = [
    { incomingId: anchors[0].compareId, direction: "ancestors" },
    { incomingId: anchors[1].compareId, direction: "descendants" },
  ];

  const { records, report } = mergeDecisions(master, compare, decisions, result, tr, branches);

  // Mirror handleConfirmSave with a pinned clock so snapshots are stable.
  const changedIds = new Set(Object.keys(report.recordKinds));
  const newIds = new Set(report.changes.filter((c) => c.newRecord).map((c) => c.recordId));
  stampChanCrea(records, changedIds, newIds, master.chanCreaUsage, "15 JAN 2026", "12:00:00");
  ensureUtf8Charset(records, master);
  const output = serializeGedcom(records, downloadOptions(master));

  it("exercises the mechanics it claims to (guard against a silent no-op)", () => {
    expect(picked.length).toBeGreaterThanOrEqual(20);
    expect(rejected).toBeDefined();
    expect(report.newPersons).toBeGreaterThan(50); // the grafts really ran
    expect(report.deferred.length).toBeGreaterThan(0); // spouse-slot conflicts surfaced
  });

  it("matches the golden touched-records snapshot", async () => {
    await expect(touchedBlocks(records, master.records, report)).toMatchFileSnapshot(
      "./golden/europe-into-tudor.touched.ged",
    );
  });

  it("matches the golden change report", async () => {
    await expect(formatReport(report)).toMatchFileSnapshot("./golden/europe-into-tudor.report.txt");
  });

  it("produces output that parses cleanly and reaches a serialize fixed-point", () => {
    const reparsed = parseGedcom(new TextEncoder().encode(output).buffer as ArrayBuffer);
    expect(reparsed.warnings.filter((w) => w.kind === "syntax")).toEqual([]);
    expect(serializeGedcom(reparsed.records, downloadOptions(master))).toBe(output);
  });

  it("introduces no dangling xrefs beyond the master's own baseline", () => {
    const baseline = new Set(findDanglingXrefs(master.records).map((d) => d.xref));
    const fresh = findDanglingXrefs(records).filter((d) => !baseline.has(d.xref));
    expect(fresh).toEqual([]);
  });

  it("introduces no broken or duplicated family links", () => {
    const baseline = validateDataset(master, 2026).counts;
    const merged = buildDataset(parseGedcom(new TextEncoder().encode(output).buffer as ArrayBuffer));
    const counts = validateDataset(merged, 2026).counts;
    expect(counts.brokenLink).toBe(baseline.brokenLink);
    expect(counts.duplicatePointer).toBe(baseline.duplicatePointer);
  });

  it("only reports changes against records that exist in the output", () => {
    const xrefs = new Set(records.filter((r) => r.xref).map((r) => r.xref!));
    for (const c of report.changes) expect(xrefs.has(c.recordId)).toBe(true);
  });
});

describe("self-merge is a byte-for-byte no-op (whole corpus)", () => {
  interface FixtureMeta { file: string }
  const manifest: FixtureMeta[] = JSON.parse(readFileSync(resolve(CORPUS, "manifest.json"), "utf-8"));

  it.each(manifest.map((m) => [m.file] as const))("%s", (file) => {
    const buf = readFileSync(resolve(CORPUS, file));
    const slice = () =>
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    // The compare side is deliberately *not* normalized: a file with an
    // internally inconsistent house style (a minority of packed places, a few
    // odd date formats) has those records legitimately reshaped against its
    // own profile, which then shows up as genuine field differences. The
    // property pinned here is that the *merge engine* is a no-op on identical
    // input — normalization has its own suites.
    const master = buildDataset(parseGedcom(slice()));
    const compare = buildDataset(parseGedcom(slice()));
    let result = matchDatasets(master, compare);
    if (result.incomingDuplicates?.length) {
      for (const { keepId, mergeIds } of result.incomingDuplicates) {
        for (const id of mergeIds) {
          mergeDuplicate(compare, keepId, id, { status: "confirmed", fields: {} }, tr);
        }
      }
      result = { individuals: result.individuals };
    }

    // Confirm every identity pair (same xref on both sides — it's the same
    // file) with default choices; defaults keep the master on conflicts and
    // identical sides produce no missing fields, so nothing may change.
    const decisions = new Map<string, CandidateDecision>();
    for (const c of result.individuals) {
      if (c.masterId === c.compareId) {
        decisions.set(decisionKey("individual", c.masterId, c.compareId), { status: "confirmed", fields: {} });
      }
    }
    expect(decisions.size).toBeGreaterThan(0);

    const { records, report } = mergeDecisions(master, compare, decisions, result, tr);
    expect(report.changes.filter((c) => c.field)).toEqual([]);
    expect(report.newPersons).toBe(0);
    expect(report.newFamilies).toBe(0);
    expect(serializeGedcom(records, { eol: master.eol, finalNewline: master.finalNewline })).toBe(
      serializeGedcom(master.records, { eol: master.eol, finalNewline: master.finalNewline }),
    );
  });
});
