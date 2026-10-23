import { describe, expect, it } from "vitest";
import { canRemoveFromSave, removeFromSave, type RevertTracking } from "./removeFromSave";
import { applyRecordPatches, cloneRaw } from "../historyTypes";
import { parseGedcom } from "../../gedcom/parser";
import { buildDataset } from "../../gedcom/builder";
import { serializeGedcom } from "../../gedcom/serialize";
import { addChild, addIndividual, noteCtx, setNotes } from "../../gedcom/edit";
import type { Dataset } from "../../gedcom/types";

const parse = (lines: string[]): Dataset =>
  buildDataset(parseGedcom(new TextEncoder().encode(lines.join("\n")).buffer));

const FILE = [
  "0 HEAD",
  "0 @I1@ INDI", "1 NAME Ana /Novak/", "1 SEX F",
  "0 @I2@ INDI", "1 NAME Jože /Kos/", "1 SEX M",
  "0 TRLR",
];

function tracking(loaded: Dataset, id: string, over: Partial<RevertTracking> = {}): RevertTracking {
  const snap = loaded.individuals.get(id)?.raw;
  return {
    loaded: !!snap,
    snapshot: snap ? cloneRaw(snap) : undefined,
    ownedRecords: [],
    wasLoadedRecord: (xref) => loaded.records.some((r) => r.xref === xref),
    ...over,
  };
}

// Regression: "Remove from Save" reverted one record in isolation. Reverting a
// person whose edit added a relative left the new family naming them; a new
// shared note the edit created stayed behind; and taking out a person created
// this session left another record's association pointing at nobody.
describe("removeFromSave", () => {
  it("refuses to revert a person whose edit linked them into a new family", () => {
    const loaded = parse(FILE);
    const ds = parse(FILE);
    addChild(ds, ds.individuals.get("@I1@")!, undefined);
    expect(canRemoveFromSave(ds, "individual", "@I1@", tracking(loaded, "@I1@"))).toBe(false);
    expect(removeFromSave(ds, "individual", "@I1@", tracking(loaded, "@I1@"))).toEqual([]);
  });

  it("drops the shared note the edit created along with the edit", () => {
    const loaded = parse(FILE);
    const ds = parse(FILE);
    const before = serializeGedcom(ds.records);
    const ctx = noteCtx(ds.records);
    ctx.noteStyle = "shared";
    setNotes(ctx, ds.individuals.get("@I1@")!, [{ text: "A new note" }]);
    expect(serializeGedcom(ds.records)).toContain("A new note");
    const patches = removeFromSave(ds, "individual", "@I1@", tracking(loaded, "@I1@"));
    expect(serializeGedcom(ds.records)).toBe(before);
    applyRecordPatches(ds, patches, "undo");
    expect(serializeGedcom(ds.records)).toContain("A new note");
  });

  it("puts back a shared note edited through the person's card", () => {
    const lines = [...FILE.slice(0, 4), "1 NOTE @N1@", ...FILE.slice(4, -1), "0 @N1@ NOTE Old text", "0 TRLR"];
    const loaded = parse(lines);
    const ds = parse(lines);
    const before = serializeGedcom(ds.records);
    ds.records.find((r) => r.xref === "@N1@")!.value = "New text";
    const owned = tracking(loaded, "@I1@", {
      ownedRecords: [["@N1@", cloneRaw(loaded.records.find((r) => r.xref === "@N1@")!)]],
    });
    expect(canRemoveFromSave(ds, "individual", "@I1@", owned)).toBe(true);
    removeFromSave(ds, "individual", "@I1@", owned);
    expect(serializeGedcom(ds.records)).toBe(before);
  });

  it("deletes a person created this session like a delete does, associations included", () => {
    const loaded = parse(FILE);
    const ds = parse(FILE);
    const created = addIndividual(ds, "F");
    const i2 = ds.individuals.get("@I2@")!;
    i2.raw.children.push({ level: 1, tag: "ASSO", value: created.id, children: [{ level: 2, tag: "RELA", value: "Godparent", children: [] }] });
    const withAsso = serializeGedcom(ds.records);
    const patches = removeFromSave(ds, "individual", created.id, tracking(loaded, created.id));
    expect(serializeGedcom(ds.records)).toBe(serializeGedcom(loaded.records));
    expect(patches.some((p) => p.id === "@I2@")).toBe(true);
    applyRecordPatches(ds, patches, "undo");
    expect(serializeGedcom(ds.records)).toBe(withAsso);
  });
});
