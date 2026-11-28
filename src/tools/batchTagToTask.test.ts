import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import { researchNotesUnder } from "../gedcom/edit/research";
import type { Dataset } from "../gedcom/types";
import { fullTextLookup } from "../ui/globalSearch";
import { applyRecordPatches } from "../ui/historyTypes";
import { validateConformance } from "./conformance/conformance";
import {
  applyBatchAction,
  buildBatchRows,
  customTagValues,
  isCustomPersonTag,
  matchesBatch,
  type BatchCriterion,
} from "./batch";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

const nameOf = (indi: { names: { full: string }[] }) => indi.names[0]?.full ?? "?";

/** Two people labelled the MacFamilyTree way, a third with another custom line. */
const file = (vers: "5.5.1" | "7.0") => {
  const head = vers === "7.0"
    ? "0 HEAD\n1 GEDC\n2 VERS 7.0\n"
    : "0 HEAD\n1 SOUR TEST\n1 SUBM @U1@\n1 GEDC\n2 VERS 5.5.1\n2 FORM LINEAGE-LINKED\n1 CHAR UTF-8\n0 @U1@ SUBM\n1 NAME Test\n";
  return `${head}0 @I1@ INDI
1 NAME Janez /Novak/
1 _LABL @L2@
1 _LABL @L3@
0 @I2@ INDI
1 NAME Ana /Kos/
1 _LABL @L2@
0 @I3@ INDI
1 NAME Miha /Rakar/
1 _FSFTID KW12-345
0 @L1@ _LABL
1 TITL Important
0 @L2@ _LABL
1 TITL Incomplete
0 @L3@ _LABL
1 TITL Y-DNA
0 TRLR`;
};
const text = (ds: Dataset) => serializeGedcom(ds.records);
const tasksOf = (ds: Dataset, id: string) =>
  researchNotesUnder(ds.records, ds.individuals.get(id)!.raw).map((f) => f.note);

describe("custom tag criterion", () => {
  it("finds people by a custom line, a pointer read as the title of its record", () => {
    const ds = dataset(file("5.5.1"));
    const rows = buildBatchRows(ds, nameOf);
    const ctx = { lineSides: null, kinship: null, fullText: fullTextLookup(ds) };
    const pick = (c: BatchCriterion) => rows.filter((r) => matchesBatch(r, [c], ctx)).map((r) => r.id).sort();
    expect(pick({ kind: "tag", tag: "_LABL", mode: "has" })).toEqual(["@I1@", "@I2@"]);
    expect(pick({ kind: "tag", tag: "_LABL", mode: "lacks" })).toEqual(["@I3@"]);
    expect(pick({ kind: "tag", tag: "_LABL", mode: "has", text: "y-dna" })).toEqual(["@I1@"]);
    expect(pick({ kind: "tag", tag: "_FSFTID", mode: "has", text: "kw12" })).toEqual(["@I3@"]);
    // A standard line is not a custom tag.
    expect(rows.flatMap((r) => r.customTags.map((l) => l.tag))).toEqual(["_LABL", "_LABL", "_LABL", "_FSFTID"]);
    expect(isCustomPersonTag("NAME")).toBe(false);
    expect(isCustomPersonTag("_RESEARCH")).toBe(false);
    expect(customTagValues(rows, "_LABL")).toEqual(["Incomplete", "Y-DNA"]);
    expect(customTagValues(rows, "_LABL", "incompl")).toEqual(["Incomplete"]);
  });
});

describe("tagToTask action", () => {
  it("turns the matching lines into a task per person and removes the label with its last pointer", () => {
    for (const vers of ["5.5.1", "7.0"] as const) {
      const ds = dataset(file(vers));
      const before = text(ds);
      const action = { kind: "tagToTask", tag: "_LABL", match: "Incomplete", noteKind: "TASK", remove: true } as const;
      const res = applyBatchAction(ds, ["@I1@", "@I2@", "@I3@"], action, vers);
      expect([res.changed, res.skipped]).toEqual([2, 1]);
      for (const id of ["@I1@", "@I2@"]) {
        expect(tasksOf(ds, id).map((n) => [n.kind, n.done, n.text])).toEqual([["TASK", false, "Incomplete"]]);
      }
      // Each person has a task of their own.
      expect(tasksOf(ds, "@I1@")[0].id).not.toBe(tasksOf(ds, "@I2@")[0].id);
      // The other label stays, with its record; the converted one is gone.
      expect(ds.individuals.get("@I1@")!.raw.children.filter((c) => c.tag === "_LABL").map((c) => c.value)).toEqual(["@L3@"]);
      expect(ds.records.filter((r) => r.tag === "_LABL").map((r) => r.xref)).toEqual(["@L1@", "@L3@"]);
      // Nothing the conversion wrote is against the version.
      const mine = new Set(["@I2@", ...tasksOf(ds, "@I1@").map((n) => n.id), ...tasksOf(ds, "@I2@").map((n) => n.id)]);
      expect(validateConformance(ds).filter((i) => mine.has(i.recordId ?? ""))).toEqual([]);
      // Undo gives the file back as it was, record order included; redo the result.
      const after = text(ds);
      applyRecordPatches(ds, res.patches, "undo");
      expect(text(ds)).toBe(before);
      applyRecordPatches(ds, res.patches, "redo");
      expect(text(ds)).toBe(after);
      // Nothing left to convert.
      expect(applyBatchAction(ds, ["@I1@", "@I2@"], action, vers).changed).toBe(0);
    }
  });

  it("keeps the line when asked to, writes the reader's own text, and does not repeat itself", () => {
    const ds = dataset(file("5.5.1"));
    const action = { kind: "tagToTask", tag: "_LABL", noteKind: "QUESTION", text: " Preveri krst ", remove: false } as const;
    const res = applyBatchAction(ds, ["@I1@", "@I2@"], action, "5.5.1");
    expect([res.changed, res.skipped]).toEqual([2, 0]);
    // Two labels, one text: one task.
    expect(tasksOf(ds, "@I1@").map((n) => [n.kind, n.text])).toEqual([["QUESTION", "Preveri krst"]]);
    expect(ds.individuals.get("@I1@")!.raw.children.filter((c) => c.tag === "_LABL")).toHaveLength(2);
    expect(ds.records.filter((r) => r.tag === "_LABL")).toHaveLength(3);
    const again = applyBatchAction(ds, ["@I1@", "@I2@"], action, "5.5.1");
    expect([again.changed, again.skipped, again.patches.length]).toEqual([0, 2, 0]);
  });

  it("writes one task per distinct value, and names the tag where a flag has none", () => {
    const ds = dataset(file("5.5.1").replace("1 _FSFTID KW12-345", "1 _FLAG"));
    applyBatchAction(ds, ["@I1@"], { kind: "tagToTask", tag: "_LABL", noteKind: "TASK", remove: false }, "5.5.1");
    expect(tasksOf(ds, "@I1@").map((n) => n.text)).toEqual(["Incomplete", "Y-DNA"]);
    applyBatchAction(ds, ["@I3@"], { kind: "tagToTask", tag: "_FLAG", noteKind: "IDEA", remove: true }, "5.5.1");
    expect(tasksOf(ds, "@I3@").map((n) => n.text)).toEqual(["_FLAG"]);
    expect(ds.individuals.get("@I3@")!.raw.children.some((c) => c.tag === "_FLAG")).toBe(false);
    // A standard line is never converted away.
    expect(applyBatchAction(ds, ["@I3@"], { kind: "tagToTask", tag: "NAME", noteKind: "IDEA", remove: true }, "5.5.1").changed).toBe(0);
    expect(ds.individuals.get("@I3@")!.names[0].full).toContain("Rakar");
  });
});
