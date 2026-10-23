/// <reference types="node" />
/**
 * Undo/redo invariant for every whole-file pass.
 *
 * Each pass is run the way its panel's handler runs it (the function App.tsx
 * or the panel calls, with the inputs the panel builds), over a corpus file —
 * defects and duplicates interleaved into it where the corpus has none — and
 * then:
 *
 *  - undo of its patches (via `applyRecordPatches`, as the history does) must
 *    give back the file byte for byte — content *and* record order;
 *  - redo must give back the post-pass file byte for byte;
 *  - a second undo must land on the original again.
 *
 * The download-only passes (bulk normalize, note reshape) carry no patches:
 * for them the invariant is that the open file is not touched at all.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import { rebuildFamily, rebuildIndividual, copyEventToIndividual, copyEventToFamily } from "../gedcom/edit";
import type { Dataset, GedNode } from "../gedcom/types";
import {
  applyRecordPatches,
  coalescePatches,
  dropNoopPatches,
  patchesFromSnapshots,
  snapshotRecords,
  type RecordPatch,
} from "../ui/historyTypes";
import { individualFieldRows } from "../review/fields";
import { applyPassSafely } from "./passSafety";
import { applyBatchAction, type BatchActionSpec } from "./batch";
import { applySourceCleanup } from "./sourceCleanupApply";
import {
  ALL_SITES,
  baptismTargetTag,
  findReshapableLinks,
  mergeFsBooks,
  reshapeOptionsFromOverrides,
} from "./sourceReshape";
import { findSourceDuplicates } from "./sourceDuplicates";
import { scanRepoRegroup } from "./repoRegroup";
import { findMissingPageMedia } from "./pageMediaCheck";
import { applyPlaceRename, collectPlaceSegments } from "./placeEdit";
import {
  applyGeocode,
  clearPlaceCoords,
  collectPlaceValues,
  movePlaceForAddresses,
  placeAddrKey,
  renamePlaceValue,
  renamePlaceValues,
  walkPlaceAddr,
  type GeoAssignment,
  type OfficialRename,
} from "./geocode";
import { applyAddressCoords, removeAddress, renameAddress, scanAddresses } from "./addresses";
import { fillPlaceCoordsFromFile } from "./placeCoords";
import { fixBrokenLinks } from "./fixLinks";
import { fixDanglingRefs } from "./fixDanglingRefs";
import { fixDuplicatePointers } from "./fixDuplicatePointers";
import { fixDuplicateFamilies } from "./fixDuplicateFamilies";
import { fixSexFromRole } from "./fixSex";
import { fixSwappedRoles } from "./fixRoleSwap";
import { fixDates } from "./fixDates";
import { clusterDuplicates, findDuplicates } from "./duplicates";
import { duplicateDefaults, mergeDuplicateChain } from "./mergeDuplicate";
import { clusterRelativeGroups, mergeCluster, pickClusterSurvivor } from "./mergeCluster";
import { bulkNormalize } from "./bulkNormalize";

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../__fixtures__/corpus");
const tr = (key: string) => key;

/** A corpus file as LF text, the way the app serializes it. */
function corpusText(file: string): string {
  const buf = readFileSync(resolve(DIR, file));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return serializeGedcom(buildDataset(parseGedcom(ab)).records);
}

function load(text: string): Dataset {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer as ArrayBuffer));
}

/** Split serialized text into its top-level record blocks. */
function blocks(text: string): string[] {
  return text.split(/\n(?=0 )/).map((b) => (b.endsWith("\n") ? b : b + "\n"));
}

/**
 * Spread extra record blocks through the file — one after every `step`-th
 * record — so the records a pass adds or removes sit between the file's own
 * and every deletion shifts the positions of the ones after it.
 */
function interleave(text: string, extra: string[]): string {
  const bs = blocks(text);
  const trlr = bs.pop()!;
  const step = Math.max(1, Math.floor(bs.length / (extra.length + 1)));
  const out: string[] = [];
  let next = 0;
  bs.forEach((b, i) => {
    out.push(b);
    if (i > 0 && i % step === 0 && next < extra.length) out.push(extra[next++]);
  });
  while (next < extra.length) out.push(extra[next++]);
  out.push(trlr);
  return out.join("");
}

/** Append lines right after record `xref`'s header line. */
function addLines(text: string, xref: string, lines: string): string {
  const re = new RegExp(`(^0 ${xref.replace(/[@]/g, "\\@")} \\w+\\n)`, "m");
  expect(re.test(text)).toBe(true);
  return text.replace(re, `$1${lines}`);
}

/** The first differing line of two serializations, with a little context —
 *  a whole-file `toBe` failure says nothing about where the files part. */
function firstDifference(actual: string, expected: string): string {
  const a = actual.split("\n");
  const e = expected.split("\n");
  const i = a.findIndex((line, k) => line !== e[k]);
  const at = i === -1 ? Math.min(a.length, e.length) : i;
  const around = (ls: string[]) => ls.slice(Math.max(0, at - 3), at + 4).join("\n");
  return `line ${at + 1}\n--- actual\n${around(a)}\n--- expected\n${around(e)}`;
}

function expectSameFile(ds: Dataset, expected: string, step: string): void {
  const actual = serializeGedcom(ds.records);
  if (actual !== expected) expect.fail(`${step}: ${firstDifference(actual, expected)}`);
}

/** Run a pass and check undo → original, redo → post-pass, undo → original. */
function expectUndoInvariant(ds: Dataset, run: (ds: Dataset) => RecordPatch[]): RecordPatch[] {
  const original = serializeGedcom(ds.records);
  // As `applyToolPatches` does before the batch reaches the history.
  const patches = dropNoopPatches(run(ds));
  const after = serializeGedcom(ds.records);
  expect(patches.length).toBeGreaterThan(0);
  expect(after).not.toBe(original);

  applyRecordPatches(ds, patches, "undo");
  expectSameFile(ds, original, "undo");
  applyRecordPatches(ds, patches, "redo");
  expectSameFile(ds, after, "redo");
  applyRecordPatches(ds, patches, "undo");
  expectSameFile(ds, original, "second undo");
  return patches;
}

const individualsOf = (ds: Dataset) => [...ds.individuals.keys()];

/** Copies of corpus people under new xrefs, with no family links — a person
 *  entered twice, as a merged-in branch leaves them. */
function duplicateBlocks(text: string, ids: string[], copies = 1): string[] {
  const ds = load(text);
  const out: string[] = [];
  for (const id of ids) {
    for (let c = 1; c <= copies; c++) {
      const raw = ds.individuals.get(id)!.raw;
      const copy: GedNode = {
        ...raw,
        xref: `@ZD${id.replace(/@/g, "")}x${c}@`,
        children: raw.children.filter((ch) => !["FAMS", "FAMC", "_UID", "RIN", "_FID", "REFN"].includes(ch.tag)),
      };
      out.push(serializeGedcom([copy]));
    }
  }
  return out;
}

/** People with a name, a birth year and family links — good duplicate bait. */
function wellKnown(ds: Dataset, n: number): string[] {
  return [...ds.individuals.values()]
    .filter((i) => i.names.length && i.events.some((e) => e.tag === "BIRT" && e.date?.year) && i.spouseOf.length)
    .slice(0, n)
    .map((i) => i.id);
}

// ── Batch actions ────────────────────────────────────────────────────────────

describe("undo invariant: batch actions", () => {
  const run = (action: BatchActionSpec, ids?: (ds: Dataset) => string[]) => (ds: Dataset) => {
    // As BatchSection.apply runs it.
    const targets = (ids ?? individualsOf)(ds);
    const res = applyPassSafely(ds, (journal) => {
      for (const id of targets) journal.touch(id);
      return applyBatchAction(ds, targets, action);
    });
    return res.patches;
  };

  const cases: [string, string, BatchActionSpec][] = [
    ["mark deceased", "myheritage-5.5.1-utf8.ged", { kind: "markDeceased" }],
    ["estimate birth", "reunion-5.5.1-utf8.ged", { kind: "estimateBirth" }],
    ["estimate birth", "geneanet-5.5.1-utf8.ged", { kind: "estimateBirth" }],
    ["add married name", "gramps-5.5.1-utf8.ged", { kind: "addMarriedName" }],
    ["convert event", "ancestry-5.5.1-utf8.ged", { kind: "convertEvent", fromTag: "RESI", toTag: "EVEN", type: "Bivališče" }],
    ["convert event", "myheritage-5.5.1-utf8.ged", { kind: "convertEvent", fromTag: "CHR", toTag: "BAPM" }],
    ["add a new source", "webtrees-5.5.1-utf8.ged", { kind: "addSource", title: "Popis prebivalstva 1900", page: "list 3" }],
    ["add a new image", "synium-7.0-utf8.ged", { kind: "addMedia", file: "https://example.org/druzina.jpg", title: "Družina" }],
  ];
  it.each(cases)("%s (%s)", (_name, file, action) => {
    expectUndoInvariant(load(corpusText(file)), run(action));
  });

  it("remove an image (ancestry)", () => {
    const ds = load(corpusText("ancestry-5.5.1-utf8.ged"));
    const obje = ds.records.find((r) => r.tag === "OBJE" && r.xref)!;
    expectUndoInvariant(ds, run({ kind: "removeMedia", xref: obje.xref }));
  });
});

// ── Organize sources ─────────────────────────────────────────────────────────

/** A repository per FamilySearch collection — the regroup's case — plus a page
 *  image a citation does not link, as separate records to interleave. */
const SOURCE_EXTRAS = [
  "0 @ZR1@ REPO\n1 NAME FamilySearch.org - Illinois, Cook County Deaths, 1871-1998\n",
  "0 @ZR2@ REPO\n1 NAME FamilySearch.org - Indiana, Marriages, 1811-2019\n",
  "0 @ZS1@ SOUR\n1 TITL Illinois, Cook County Deaths, 1871-1998\n1 REPO @ZR1@\n2 CALN 108918058\n",
  "0 @ZS2@ SOUR\n1 TITL Indiana, Marriages, 1811-2019\n1 REPO @ZR2@\n",
  "0 @ZI1@ INDI\n1 NAME Ana /Kern/\n1 BIRT\n2 DATE 3 MAR 1880\n2 SOUR @ZS3@\n3 PAGE 11\n1 DEAT\n2 SOUR @ZS1@\n",
  "0 @ZS3@ SOUR\n1 TITL Krstna knjiga - 03869\n1 OBJE @ZM1@\n",
  "0 @ZM1@ OBJE\n1 FILE https://data.matricula-online.eu/sl/slovenia/maribor/sentjur-pri-celju/03869/?pg=11\n",
  // Two copies of one source — the dedupe's case — cited from two people.
  "0 @ZS4@ SOUR\n1 TITL Poročna knjiga Kranj 1850-1890\n1 AUTH Župnija Kranj\n",
  "0 @ZI2@ INDI\n1 NAME Jože /Kern/\n1 MARR\n2 SOUR @ZS4@\n3 PAGE 5\n",
  "0 @ZS5@ SOUR\n1 TITL Poročna knjiga Kranj 1850-1890\n1 AUTH Župnija Kranj\n",
  "0 @ZI3@ INDI\n1 NAME Marija /Kern/\n1 BURI\n2 SOUR @ZS5@\n3 PAGE 9\n",
];

/** The Organize-sources apply, built as SourceCleanupView.apply builds it. */
function organizeSources(
  ds: Dataset,
  parts: { reshape?: boolean; dups?: boolean; regroup?: boolean; pages?: boolean },
): RecordPatch[] {
  const options = reshapeOptionsFromOverrides(undefined);
  const report = findReshapableLinks(ds, new Set(ALL_SITES), options);
  const folded = mergeFsBooks(report, new Map(), baptismTargetTag(ds.records));
  return applySourceCleanup(
    ds,
    {
      groups: parts.reshape ? folded.report.groups : [],
      enrichment: new Map(),
      options: { ...options, relocate: true, tidyLinks: false, mergeGroups: folded.keyOf },
    },
    parts.dups ? findSourceDuplicates(ds).groups : [],
    parts.regroup ? scanRepoRegroup(ds.records).groups : [],
    // The page tool is offered under the "event" page-link setting.
    parts.pages ? findMissingPageMedia(ds, "event").groups : [],
  );
}

describe("undo invariant: Organize sources", () => {
  it.each(["geneanet-5.5.1-utf8.ged", "myheritage-5.5.1-utf8.ged", "rootsmagic-5.5.1-utf8.ged"])(
    "reshape links into sources (%s)",
    (file) => {
      expectUndoInvariant(load(corpusText(file)), (ds) => organizeSources(ds, { reshape: true }));
    },
  );

  it("merge duplicate sources (rootsmagic)", () => {
    expectUndoInvariant(load(corpusText("rootsmagic-5.5.1-utf8.ged")), (ds) => organizeSources(ds, { dups: true }));
  });

  it("merge duplicate sources interleaved through the file", () => {
    const ds = load(interleave(corpusText("gramps-5.5.1-utf8.ged"), SOURCE_EXTRAS));
    expect(findSourceDuplicates(ds).groups.length).toBeGreaterThan(0);
    expectUndoInvariant(ds, (d) => organizeSources(d, { dups: true }));
  });

  it("regroup repositories", () => {
    const ds = load(interleave(corpusText("gramps-5.5.1-utf8.ged"), SOURCE_EXTRAS));
    expect(scanRepoRegroup(ds.records).groups.length).toBeGreaterThan(0);
    expectUndoInvariant(ds, (d) => organizeSources(d, { regroup: true }));
  });

  it("link missing page images", () => {
    const ds = load(interleave(corpusText("gramps-5.5.1-utf8.ged"), SOURCE_EXTRAS));
    expect(findMissingPageMedia(ds, "event").groups.length).toBeGreaterThan(0);
    expectUndoInvariant(ds, (d) => organizeSources(d, { pages: true }));
  });

  it("every part at once", () => {
    const ds = load(interleave(corpusText("geneanet-5.5.1-utf8.ged"), SOURCE_EXTRAS));
    expectUndoInvariant(ds, (d) => organizeSources(d, { reshape: true, dups: true, regroup: true, pages: true }));
  });
});

// ── Places, geocoding, addresses, naming ─────────────────────────────────────

/** A distinct, made-up coordinate per key, so every write is a change. */
function coordFor(i: number): GeoAssignment {
  return { coord: { lat: 45.5 + i / 1000, lon: 14.2 + i / 1000 } };
}

describe("undo invariant: places and coordinates", () => {
  it("places tree rename of a segment (geneanet)", () => {
    const ds = load(corpusText("geneanet-5.5.1-utf8.ged"));
    const seg = collectPlaceSegments(ds)[0];
    expectUndoInvariant(ds, (d) => applyPlaceRename(d, seg, `${seg} (preimenovano)`));
  });

  it("places tree rename, scoped to some records (familyhistorian)", () => {
    const text = corpusText("familyhistorian-5.5.1-utf8.ged");
    const ds = load(text);
    // The segment's own records, every other one — so the rename lands on some.
    const seg = collectPlaceSegments(ds).find((s) => applyPlaceRename(load(text), s, "Novo mesto").length > 3)!;
    const users = applyPlaceRename(load(text), seg, "Novo mesto").map((p) => p.id);
    const scope = new Set(users.filter((_, i) => i % 2 === 0));
    expectUndoInvariant(ds, (d) => applyPlaceRename(d, seg, "Novo mesto", scope));
  });

  it("geocode write-back (geneanet)", () => {
    const ds = load(corpusText("geneanet-5.5.1-utf8.ged"));
    const assignments = new Map(collectPlaceValues(ds).slice(0, 40).map((p, i) => [p, coordFor(i)] as const));
    expectUndoInvariant(ds, (d) => applyGeocode(d, assignments));
  });

  it("geocode overwrite of written coordinates (synium)", () => {
    const ds = load(corpusText("synium-7.0-utf8.ged"));
    const assignments = new Map(
      collectPlaceValues(ds).map((p, i) => [p, { ...coordFor(i), overwrite: true, govId: `GOV_${i}` }] as const),
    );
    expectUndoInvariant(ds, (d) => applyGeocode(d, assignments));
  });

  it("clear coordinates (synium)", () => {
    const ds = load(corpusText("synium-7.0-utf8.ged"));
    const pairs = new Set<string>();
    for (const indi of ds.individuals.values()) {
      walkPlaceAddr(indi.raw, (plac, addr) => pairs.add(placeAddrKey(plac.value!.trim(), addr)));
    }
    expectUndoInvariant(ds, (d) => clearPlaceCoords(d, pairs));
  });

  it("fill coordinates from the file's own (synium)", () => {
    const stripped = load(corpusText("synium-7.0-utf8.ged"));
    // Strip the coordinate off every other place occurrence, so the file's own
    // other occurrences of the same pair have one to fill it from.
    let i = 0;
    for (const indi of stripped.individuals.values()) {
      walkPlaceAddr(indi.raw, (plac) => {
        if (i++ % 2) plac.children = plac.children.filter((c) => c.tag !== "MAP");
      });
    }
    const ds = load(serializeGedcom(stripped.records));
    expectUndoInvariant(ds, (d) => fillPlaceCoordsFromFile(d));
  });

  it("address coordinates (geneanet)", () => {
    const ds = load(corpusText("geneanet-5.5.1-utf8.ged"));
    const rows = scanAddresses(ds);
    const assignments = new Map(rows.flatMap((r, i) => r.rawKeys.map((k) => [k, coordFor(i).coord] as const)));
    expectUndoInvariant(ds, (d) => applyAddressCoords(d, assignments));
  });

  it("rename and remove addresses in one step (gramps)", () => {
    const ds = load(corpusText("gramps-5.5.1-utf8.ged"));
    const rows = scanAddresses(ds).slice(0, 8);
    // As App's onRenameAddresses: renames and removals, coalesced.
    expectUndoInvariant(ds, (d) =>
      coalescePatches(
        rows.flatMap((r, i) =>
          i % 2 ? renameAddress(d, r.rawKeys, r.address, `${r.address} a`) : removeAddress(d, r.rawKeys, r.address),
        ),
      ),
    );
  });

  it("move a place for addresses (gramps)", () => {
    const ds = load(corpusText("gramps-5.5.1-utf8.ged"));
    const rows = scanAddresses(ds).slice(0, 4);
    expect(rows.length).toBeGreaterThan(0);
    expectUndoInvariant(ds, (d) =>
      movePlaceForAddresses(d, new Set(rows.flatMap((r) => r.rawKeys)), "Gradac, Slovenija", coordFor(1)),
    );
  });

  it("rename one place value, splitting off an address (geneanet)", () => {
    const ds = load(corpusText("geneanet-5.5.1-utf8.ged"));
    const from = collectPlaceValues(ds)[2];
    expectUndoInvariant(ds, (d) => renamePlaceValue(d, from, "Kranj, Slovenija", "Glavni trg 1"));
  });

  it("use official names: renames and their coordinates coalesced (geneanet)", () => {
    const ds = load(corpusText("geneanet-5.5.1-utf8.ged"));
    const renames: OfficialRename[] = collectPlaceValues(ds)
      .slice(0, 30)
      .map((from, i) => ({ from, to: `${from.split(",")[0].trim()}, Uradno ${i}`, assignment: coordFor(i) }));
    // As App's onApplyOfficialNames.
    expectUndoInvariant(ds, (d) => {
      const coords = new Map(renames.map((r) => [r.to, r.assignment!] as const));
      return coalescePatches([...renamePlaceValues(d, renames), ...applyGeocode(d, coords)]);
    });
  });
});

// ── Health-check fixers ──────────────────────────────────────────────────────

/** A corpus file with health-check defects planted in records all over it. */
function defectiveFile(): string {
  let text = corpusText("gramps-5.5.1-utf8.ged");
  const ds = load(text);
  const fams = [...ds.families.values()].filter((f) => f.husband && f.wife);
  const people = [...ds.individuals.values()];
  const withFams = people.filter((i) => i.spouseOf.length);
  // Broken links: a dangling FAMS, and a one-way FAMC its family never lists.
  text = addLines(text, people[3].id, "1 FAMS @ZF404@\n");
  text = addLines(text, people[people.length - 4].id, `1 FAMC ${fams[0].id}\n`);
  // Dangling references: a citation and a note pointing at nothing.
  text = addLines(text, people[10].id, "1 SOUR @ZS404@\n2 PAGE 12\n1 NOTE @ZN404@\n");
  // Duplicate pointers: a FAMS listed twice; a CHIL listed twice.
  text = addLines(text, withFams[5].id, `1 FAMS ${withFams[5].spouseOf[0]}\n`);
  const famWithKids = fams.find((f) => f.children.length)!;
  text = addLines(text, famWithKids.id, `1 CHIL ${famWithKids.children[0]}\n`);
  // Same couple twice: a second family record for one couple, far from the first.
  const twice = fams[fams.length - 2];
  text = addLines(text, twice.husband!, "1 FAMS @ZF2@\n");
  text = addLines(text, twice.wife!, "1 FAMS @ZF2@\n");
  // Bad dates and a sex the role contradicts.
  text = addLines(text, people[20].id, "1 EVEN\n2 TYPE Popis\n2 DATE 1951, 1960\n");
  return interleave(text, [
    `0 @ZF2@ FAM\n1 HUSB ${twice.husband}\n1 WIFE ${twice.wife}\n1 MARR\n2 DATE 1901\n`,
    "0 @ZX1@ INDI\n1 NAME Ana /Kos/\n1 SEX U\n1 FAMS @ZXF@\n1 BIRT\n2 DATE 26. 6. 1912\n1 DEAT\n2 DATE Apr 12, 1979\n",
    "0 @ZX2@ INDI\n1 NAME Peter /Kos/\n1 SEX M\n1 FAMS @ZXF@\n",
    "0 @ZXF@ FAM\n1 HUSB @ZX2@\n1 WIFE @ZX1@\n",
  ]);
}

describe("undo invariant: health-check fixers", () => {
  const cases: [string, (ds: Dataset) => RecordPatch[]][] = [
    ["fix broken links", (ds) => fixBrokenLinks(ds)],
    ["fix dangling references", (ds) => fixDanglingRefs(ds)],
    ["fix duplicate pointers", (ds) => fixDuplicatePointers(ds)],
    ["fold the same couple twice", (ds) => fixDuplicateFamilies(ds)],
    ["fix sex from role", (ds) => fixSexFromRole(ds)],
    ["fix dates", (ds) => fixDates(ds)],
  ];
  it.each(cases)("%s", (_name, fix) => {
    expectUndoInvariant(load(defectiveFile()), fix);
  });

  it("swap spouse roles", () => {
    // A family whose husband is a woman and wife a man, both by sex.
    const text = interleave(corpusText("geneanet-5.5.1-utf8.ged"), [
      "0 @ZY1@ INDI\n1 NAME Ana /Kos/\n1 SEX F\n1 FAMS @ZYF@\n",
      "0 @ZY2@ INDI\n1 NAME Peter /Kos/\n1 SEX M\n1 FAMS @ZYF@\n",
      "0 @ZYF@ FAM\n1 HUSB @ZY1@\n1 WIFE @ZY2@\n",
    ]);
    const probe = load(text);
    expect(fixSwappedRoles(probe).length).toBeGreaterThan(0);
    expectUndoInvariant(load(text), (ds) => fixSwappedRoles(ds));
  });
});

// ── Duplicate merge ──────────────────────────────────────────────────────────

describe("undo invariant: duplicate merge", () => {
  it("a single pair, with the panel's default choices (geneanet)", () => {
    const base = corpusText("geneanet-5.5.1-utf8.ged");
    const [id] = wellKnown(load(base), 1);
    const ds = load(interleave(base, duplicateBlocks(base, [id])));
    const copy = `@ZD${id.replace(/@/g, "")}x1@`;
    const rows = individualFieldRows(tr, ds.individuals.get(id)!, ds.individuals.get(copy)!, ds, ds);
    const decision = { status: "confirmed" as const, fields: duplicateDefaults(rows) };
    expectUndoInvariant(ds, (d) => mergeDuplicateChain(d, [{ survivorId: id, removedId: copy, decision }], tr));
  });

  it("the merge of a pair the scan finds, in either direction (familyhistorian)", () => {
    const base = corpusText("familyhistorian-5.5.1-utf8.ged");
    const ids = wellKnown(load(base), 3);
    const ds = load(interleave(base, duplicateBlocks(base, ids)));
    const pairs = findDuplicates(ds).filter((p) => p.aId.startsWith("@ZD") || p.bId.startsWith("@ZD"));
    expect(pairs.length).toBeGreaterThan(0);
    const steps = pairs.slice(0, 3).map((p) => ({
      survivorId: p.bId,
      removedId: p.aId,
      decision: { status: "confirmed" as const, fields: {} },
    }));
    expectUndoInvariant(ds, (d) => mergeDuplicateChain(d, steps, tr));
  });

  it("a whole cluster with its relative groups (gramps)", () => {
    const base = corpusText("gramps-5.5.1-utf8.ged");
    const ids = wellKnown(load(base), 1);
    const ds = load(interleave(base, duplicateBlocks(base, ids, 3)));
    const cluster = clusterDuplicates(findDuplicates(ds)).find((c) => c.memberIds.includes(ids[0]));
    expect(cluster?.memberIds.length).toBeGreaterThan(2);
    const survivor = pickClusterSurvivor(ds, cluster!.memberIds)!;
    const groups = clusterRelativeGroups(ds, survivor, cluster!.memberIds, tr);
    expectUndoInvariant(ds, (d) => mergeCluster(d, survivor, cluster!.memberIds, groups, tr).patches);
  });

  it("a cluster of couples entered three times, spread through the file (webtrees)", () => {
    // Each copy of the wife is married to her own copy of the husband; the
    // husbands are the relative group that merges first, then the wives, and
    // their families fold into one.
    const extra = [1, 2, 3].flatMap((c) => [
      `0 @ZW${c}@ INDI\n1 NAME Neža /Gutovnik/\n1 SEX F\n1 BIRT\n2 DATE 3 MAR 1890\n1 FAMS @ZF${c}@\n`,
      `0 @ZH${c}@ INDI\n1 NAME Franc /Stopar/\n1 SEX M\n1 BIRT\n2 DATE 8 AUG 1886\n1 FAMS @ZF${c}@\n`,
      `0 @ZF${c}@ FAM\n1 HUSB @ZH${c}@\n1 WIFE @ZW${c}@\n` + (c === 1 ? "1 MARR\n2 DATE 1910\n" : ""),
    ]);
    const ds = load(interleave(corpusText("webtrees-5.5.1-utf8.ged"), extra));
    const members = ["@ZW1@", "@ZW2@", "@ZW3@"];
    const survivor = pickClusterSurvivor(ds, members)!;
    const groups = clusterRelativeGroups(ds, survivor, members, tr);
    expect(groups.length).toBeGreaterThan(0);
    const patches = expectUndoInvariant(ds, (d) => mergeCluster(d, survivor, members, groups, tr).patches);
    expect(patches.filter((p) => p.after === null).length).toBeGreaterThanOrEqual(6);
  });
});

// ── Copy event to… ───────────────────────────────────────────────────────────

describe("undo invariant: Copy event to…", () => {
  /** As EditView.applyCopyEvent runs it. */
  function copyEvent(ds: Dataset, kind: "individual" | "family", node: GedNode, targetIds: string[]): RecordPatch[] {
    const isIndividual = kind === "individual";
    const before = snapshotRecords(ds, isIndividual ? targetIds : [], isIndividual ? [] : targetIds);
    for (const id of targetIds) {
      if (isIndividual) {
        const indi = ds.individuals.get(id);
        if (indi && copyEventToIndividual(indi, node)) rebuildIndividual(ds, indi);
      } else {
        const fam = ds.families.get(id);
        if (fam && copyEventToFamily(fam, node)) rebuildFamily(ds, fam);
      }
    }
    return patchesFromSnapshots(ds, before);
  }

  it("a residence onto several people (ancestry)", () => {
    const ds = load(corpusText("ancestry-5.5.1-utf8.ged"));
    const source = [...ds.individuals.values()].find((i) => i.raw.children.some((c) => c.tag === "RESI"))!;
    const node = source.raw.children.find((c) => c.tag === "RESI")!;
    const targets = individualsOf(ds).filter((id) => id !== source.id).slice(0, 6);
    expectUndoInvariant(ds, (d) => copyEvent(d, "individual", node, targets));
  });

  it("a family event onto other families (geneanet)", () => {
    const ds = load(corpusText("geneanet-5.5.1-utf8.ged"));
    const source = [...ds.families.values()].find((f) => f.raw.children.some((c) => c.tag === "MARR"))!;
    const node = source.raw.children.find((c) => c.tag === "MARR")!;
    // Families with no MARR of their own take it (one per tag).
    const targets = [...ds.families.values()]
      .filter((f) => f.id !== source.id && !f.raw.children.some((c) => c.tag === "MARR"))
      .slice(0, 4)
      .map((f) => f.id);
    expect(targets.length).toBeGreaterThan(0);
    expectUndoInvariant(ds, (d) => copyEvent(d, "family", node, targets));
  });
});

// ── Download-only passes ─────────────────────────────────────────────────────

describe("download-only passes leave the open file alone", () => {
  it.each(["geneanet-5.5.1-utf8.ged", "gramps-5.5.1-utf8.ged", "myheritage-5.5.1-utf8.ged", "synium-7.0-utf8.ged"])(
    "bulk normalize with note reshape (%s)",
    (file) => {
      const ds = load(corpusText(file));
      const original = serializeGedcom(ds.records);
      bulkNormalize(ds, undefined, { notes: "inline", eventNotes: "shared" });
      bulkNormalize(ds, { dates: true, places: true, links: true, names: true, vendorTags: true, stripInternal: true });
      expect(serializeGedcom(ds.records)).toBe(original);
    },
  );
});
