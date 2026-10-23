import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { downloadOptions, serializeGedcom } from "../gedcom/serialize";
import type { Dataset, GedNode } from "../gedcom/types";
import { applyRecordsPatch, ChangeJournal, datasetFromSnapshot, mainSnapshot, recordsPatch } from "./mainSync";

const enc = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;
const dsOf = (text: string): Dataset => buildDataset(parseGedcom(enc(text)));
const text = (ds: Dataset) => serializeGedcom(ds.records, downloadOptions(ds));

const FILE =
  "0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n" +
  "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 FAMS @F1@\n" +
  "0 @I2@ INDI\n1 NAME Ana /Kos/\n1 FAMS @F1@\n" +
  "0 @I3@ INDI\n1 NAME Jože /Novak/\n1 FAMC @F1@\n" +
  "0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n1 CHIL @I3@\n" +
  "0 @S1@ SOUR\n1 TITL Krstna knjiga\n" +
  "0 TRLR\n";

/** A worker's copy and the live main it follows, loaded from the same file. */
function pair() {
  return { live: dsOf(FILE), copy: dsOf(FILE) };
}
const rec = (ds: Dataset, xref: string) => ds.records.find((r) => r.xref === xref)!;
const node = (line: string): GedNode => parseGedcom(enc(`0 HEAD\n${line}0 TRLR\n`)).records[1];

describe("ChangeJournal", () => {
  it("collects the records changed after a version, and says when it cannot", () => {
    const j = new ChangeJournal();
    const at0 = j.mark(0);
    j.record(1, ["@I1@"]);
    j.record(2, ["@I2@", "@F1@"]);
    expect([...j.since(at0)!]).toEqual(["@I1@", "@I2@", "@F1@"]);
    expect([...j.since(j.mark(1))!]).toEqual(["@I2@", "@F1@"]);
    expect(j.since(j.mark(2))!.size).toBe(0);
    j.record(3, null); // a save's rebuild
    expect(j.since(j.mark(2))).toBeNull();
    expect(j.since(j.mark(3))!.size).toBe(0);
    expect(j.since(undefined)).toBeNull();
  });

  it("answers no mark taken before a reset, though the versions restart", () => {
    const j = new ChangeJournal();
    const old = j.mark(5);
    j.reset();
    j.record(1, ["@I1@"]);
    expect(j.since(old)).toBeNull();
    expect([...j.since(j.mark(0))!]).toEqual(["@I1@"]);
  });
});

describe("records patch", () => {
  it("carries edits, additions, deletions and moves into the copy", () => {
    const { live, copy } = pair();
    rec(live, "@I1@").children.push({ level: 1, tag: "OCCU", value: "kmet", children: [] });
    live.records.splice(live.records.indexOf(rec(live, "@I3@")), 1); // deleted
    live.records.splice(1, 0, node("0 @I9@ INDI\n1 NAME Nova /Oseba/\n")); // added, up front
    const sour = rec(live, "@S1@"); // moved without being edited, before the family
    live.records.splice(live.records.indexOf(sour), 1);
    live.records.splice(live.records.indexOf(rec(live, "@F1@")), 0, sour);
    const patch = recordsPatch(live, new Set(["@I1@", "@I3@", "@I9@"]))!;
    const next = applyRecordsPatch(copy, structuredClone(patch))!;
    expect(text(next)).toBe(text(live));
    expect(next.individuals.has("@I9@")).toBe(true);
    expect(next.individuals.has("@I3@")).toBe(false);
    expect(next.individuals.get("@I1@")!.raw.children.some((c) => c.tag === "OCCU")).toBe(true);
  });

  it("refuses a copy missing a record it should keep", () => {
    const { live, copy } = pair();
    copy.records.splice(copy.records.indexOf(rec(copy, "@I2@")), 1);
    expect(applyRecordsPatch(copy, recordsPatch(live, new Set(["@I1@"]))!)).toBeUndefined();
  });

  it("keeps the file's own warnings and change-stamp usage", () => {
    const { live, copy } = pair();
    live.warnings.push({ kind: "syntax", message: "kept" });
    live.chanCreaUsage = { ...live.chanCreaUsage, recordChan: true };
    const next = applyRecordsPatch(copy, recordsPatch(live, new Set(["@I1@"]))!)!;
    expect(next.warnings.map((w) => w.message)).toContain("kept");
    expect(next.chanCreaUsage.recordChan).toBe(true);
  });

  it("is no buy when most of a large file changed", () => {
    const people = Array.from({ length: 12000 }, (_, i) => `0 @I${i}@ INDI\n1 NAME A${i} /B/\n`).join("");
    const live = dsOf(`0 HEAD\n${people}0 TRLR\n`);
    const ids = (n: number) => new Set(Array.from({ length: n }, (_, i) => `@I${i}@`));
    expect(recordsPatch(live, ids(3000))).toBeUndefined();
    expect(recordsPatch(live, ids(2000))).toBeDefined();
  });
});

describe("main snapshot", () => {
  const corpus = resolve(dirname(fileURLToPath(import.meta.url)), "../__fixtures__/corpus");
  it("rebuilds every corpus file as the main thread holds it", () => {
    for (const file of readdirSync(corpus).filter((f) => f.endsWith(".ged"))) {
      const buf = readFileSync(resolve(corpus, file));
      const ds = buildDataset(parseGedcom(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer));
      const copy = datasetFromSnapshot(structuredClone(mainSnapshot(ds)));
      expect(text(copy), file).toBe(text(ds));
      expect(copy.charset, file).toBe(ds.charset);
      expect([...copy.individuals.keys()], file).toEqual([...ds.individuals.keys()]);
      expect(copy.warnings, file).toEqual(ds.warnings);
    }
  });
});
