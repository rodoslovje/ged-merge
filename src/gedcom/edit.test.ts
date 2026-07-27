import { describe, expect, it } from "vitest";
import { parseGedcom } from "./parser";
import { buildDataset } from "./builder";
import { serializeGedcom } from "./serialize";
import type { Dataset, GedNode } from "./types";
import {
  addAdditionalName,
  addChild,
  addEventField,
  addEventNode,
  addFamilyEventNode,
  addObjeToSource,
  addParent,
  addPartner,
  attachInlineMedia,
  attachMediaPointer,
  attachSourceCitation,
  createMediaRecord,
  findSharedMediaByFile,
  nextXref,
  pruneUnreferencedMedia,
  pruneUnreferencedSource,
  removeMediaAt,
  reorderMedia,
  setCropRegion,
  setMediaInfo,
  changeEventTagAtIndex,
  changeFamilyEventTag,
  connectExistingChild,
  connectExistingParent,
  connectExistingPartner,
  createSourceRecord,
  detachChildFromFamily,
  detachSpouseRole,
  foldAdditionalNameToMarnm,
  INDI_CHILD_ORDER,
  insertRecord,
  copyEventToFamily,
  copyEventToIndividual,
  rebuildFamily,
  rebuildIndividual,
  removeAdditionalName,
  removeEventAtIndex,
  removeFamilyEvent,
  removeFamily,
  removeIndividual,
  removeSourceCitationAtIndex,
  setAdditionalName,
  setEventField,
  setFamilyEventField,
  noteCtx,
  setFamilyNotes,
  setIndividualLinks,
  setMarriedName,
  setName,
  setNickname,
  setNotes,
  setSex,
  updateSourceCitation,
} from "./edit";

function buildFromText(text: string) {
  const buf = new TextEncoder().encode(text);
  const parsed = parseGedcom(buf.buffer);
  return buildDataset(parsed);
}

/** Deep-clone a GedNode (mirrors cloneRaw from historyTypes). */
function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }

/**
 * Simulate the applyEditPatches logic from EditView for a single patch.
 * direction "undo" restores patch.before; "redo" restores patch.after.
 */
function applyPatch(
  ds: Dataset,
  patch: { type: "individual" | "family"; id: string; before: GedNode | null; after: GedNode | null },
  dir: "undo" | "redo",
): void {
  const raw = dir === "undo" ? patch.before : patch.after;
  if (raw === null) {
    const ri = ds.records.findIndex((r) => r.xref === patch.id);
    if (ri !== -1) ds.records.splice(ri, 1);
    if (patch.type === "individual") ds.individuals.delete(patch.id);
    else ds.families.delete(patch.id);
    return;
  }
  const snap = clone(raw);
  if (patch.type === "individual") {
    const ex = ds.individuals.get(patch.id);
    if (ex) { ex.raw.value = snap.value; ex.raw.children = snap.children; rebuildIndividual(ds, ex); }
    else { insertRecord(ds.records, snap); rebuildIndividual(ds, { raw: snap } as never); }
  } else {
    const ex = ds.families.get(patch.id);
    if (ex) { ex.raw.value = snap.value; ex.raw.children = snap.children; rebuildFamily(ds, ex); }
    else { insertRecord(ds.records, snap); rebuildFamily(ds, { raw: snap } as never); }
  }
}

const BASE = [
  "0 HEAD",
  "1 GEDC",
  "2 VERS 5.5.1",
  "0 @I1@ INDI",
  "1 NAME Janez /Novak/",
  "1 SEX M",
  "1 FAMC @F1@",
  "0 TRLR",
  "",
].join("\n");

const FAM_BASE = [
  "0 HEAD",
  "1 GEDC",
  "2 VERS 5.5.1",
  "0 @I1@ INDI",
  "1 NAME Janez /Novak/",
  "1 FAMS @F1@",
  "0 @I2@ INDI",
  "1 NAME Ana /Kos/",
  "1 FAMS @F1@",
  "0 @I3@ INDI",
  "1 NAME Bine /Novak/",
  "1 FAMC @F1@",
  "0 @F1@ FAM",
  "1 HUSB @I1@",
  "1 WIFE @I2@",
  "1 CHIL @I3@",
  "0 TRLR",
  "",
].join("\n");

// ─── setEventField ────────────────────────────────────────────────────────────

describe("setEventField", () => {
  it("returns the new event node, so callers can attach further sub-nodes (e.g. SOUR) right after", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    const node = setEventField(indi, "BIRT", { date: "12 JAN 1850" });
    expect(node?.tag).toBe("BIRT");
    expect(indi.raw.children).toContain(node);
  });

  it("returns undefined when there's nothing to set and no event already exists", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    expect(setEventField(indi, "BIRT", {})).toBeUndefined();
  });

  it("clears the note even when a leftover duplicate NOTE remains (e.g. from a 'both' merge choice), instead of letting it resurface", () => {
    const ds = buildFromText([
      "0 HEAD",
      "1 GEDC",
      "2 VERS 5.5.1",
      "0 @I1@ INDI",
      "1 NAME Janez /Novak/",
      "1 BIRT",
      "2 DATE 12 JAN 1850",
      "2 NOTE First note",
      "2 NOTE Second note",
      "0 TRLR",
      "",
    ].join("\n"));
    const indi = ds.individuals.get("@I1@")!;
    expect(indi.events[0].note).toBe("First note");

    setEventField(indi, "BIRT", { note: "" });

    const updated = rebuildIndividual(ds, indi);
    expect(updated.events[0].note).toBeUndefined();
    expect(serializeGedcom(ds.records)).not.toContain("NOTE");
  });

  it("creates a new event with date and place, ordered before FAMC", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    setEventField(indi, "BIRT", { date: "12 JAN 1850", place: "Kranj, Slovenija" });

    expect(serializeGedcom(ds.records)).toBe([
      "0 HEAD",
      "1 GEDC",
      "2 VERS 5.5.1",
      "0 @I1@ INDI",
      "1 NAME Janez /Novak/",
      "1 SEX M",
      "1 BIRT",
      "2 DATE 12 JAN 1850",
      "2 PLAC Kranj, Slovenija",
      "1 FAMC @F1@",
      "0 TRLR",
      "",
    ].join("\n"));

    const updated = rebuildIndividual(ds, indi);
    expect(updated.events[0].date?.raw).toBe("12 JAN 1850");
    expect(updated.events[0].place?.raw).toBe("Kranj, Slovenija");
    expect(ds.individuals.get("@I1@")).toBe(updated);
  });

  it("updates an existing DATE in place", () => {
    const ds = buildFromText([
      "0 HEAD",
      "1 GEDC",
      "2 VERS 5.5.1",
      "0 @I1@ INDI",
      "1 NAME Janez /Novak/",
      "1 BIRT",
      "2 DATE 12 JAN 1850",
      "2 PLAC Kranj",
      "0 TRLR",
      "",
    ].join("\n"));
    const indi = ds.individuals.get("@I1@")!;
    setEventField(indi, "BIRT", { date: "15 FEB 1851" });

    const updated = rebuildIndividual(ds, indi);
    expect(updated.events[0].date?.raw).toBe("15 FEB 1851");
    expect(updated.events[0].place?.raw).toBe("Kranj");
  });

  it("removes the DATE line and the whole event once it's empty", () => {
    const ds = buildFromText([
      "0 HEAD",
      "1 GEDC",
      "2 VERS 5.5.1",
      "0 @I1@ INDI",
      "1 NAME Janez /Novak/",
      "1 BIRT",
      "2 DATE 12 JAN 1850",
      "0 TRLR",
      "",
    ].join("\n"));
    const indi = ds.individuals.get("@I1@")!;
    setEventField(indi, "BIRT", { date: "" });

    expect(serializeGedcom(ds.records)).toBe([
      "0 HEAD",
      "1 GEDC",
      "2 VERS 5.5.1",
      "0 @I1@ INDI",
      "1 NAME Janez /Novak/",
      "0 TRLR",
      "",
    ].join("\n"));
  });

  it("sets and clears event links", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;

    setEventField(indi, "DEAT", { date: "1920", links: ["https://example.com/a", "https://example.com/b"] });
    let updated = rebuildIndividual(ds, indi);
    expect(updated.events[0].links).toEqual(["https://example.com/a", "https://example.com/b"]);

    setEventField(indi, "DEAT", { links: [] });
    updated = rebuildIndividual(ds, indi);
    expect(updated.events[0].links).toBeUndefined();
  });

  it("does nothing when there's no event and no content to add", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    setEventField(indi, "DEAT", { date: "", place: "" });
    expect(serializeGedcom(ds.records)).toBe(BASE);
  });

  it("sets and clears the event address", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;

    setEventField(indi, "RESI", { address: "Glavni trg 1, Kranj" });
    let updated = rebuildIndividual(ds, indi);
    expect(updated.events[0].address?.raw).toBe("Glavni trg 1, Kranj");
    expect(serializeGedcom(ds.records)).toContain("2 ADDR Glavni trg 1, Kranj");

    setEventField(indi, "RESI", { address: "" });
    updated = rebuildIndividual(ds, indi);
    expect(updated.events).toHaveLength(0);
  });
});

describe("addEventField", () => {
  it("creates its own node rather than reusing one just created for another pending row of the same tag", () => {
    // Mirrors two unresolved incoming-only RESI rows in Edit mode: committing
    // a field on the first materializes a main node; committing a field on
    // the second must not overwrite that node (see EditView's extra-row
    // commitField, which used to call setEventField — tag-only lookup — and
    // silently clobbered the first row's just-created event).
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;

    addEventField(indi, "RESI", { date: "Oct 1997", place: "Ljubljana, Slovenia" });
    addEventField(indi, "RESI", { date: "BEF 1997", place: "Zagreb, Croatia" });

    const updated = rebuildIndividual(ds, indi);
    const resiEvents = updated.events.filter((e) => e.tag === "RESI");
    expect(resiEvents).toHaveLength(2);
    expect(resiEvents[0].place?.raw).toBe("Ljubljana, Slovenia");
    expect(resiEvents[1].place?.raw).toBe("Zagreb, Croatia");
  });

  it("returns undefined and adds nothing when there's no content", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    expect(addEventField(indi, "RESI", {})).toBeUndefined();
    expect(serializeGedcom(ds.records)).toBe(BASE);
  });
});

// ─── copyEventToIndividual / copyEventToFamily ───────────────────────────────

describe("copyEventToIndividual", () => {
  const HOUSEHOLD = [
    "0 HEAD",
    "1 GEDC",
    "2 VERS 5.5.1",
    "0 @I1@ INDI",
    "1 NAME Janez /Novak/",
    "1 RESI",
    "2 DATE 1920",
    "2 PLAC Kranj, Slovenija",
    "3 MAP",
    "4 LATI N46.239",
    "4 LONG E14.355",
    "2 ADDR Koroška cesta 14",
    "2 NOTE Preselil se je po poroki",
    "2 SOUR @S1@",
    "3 PAGE 12",
    "0 @I2@ INDI",
    "1 NAME Ana /Kos/",
    "0 @S1@ SOUR",
    "1 TITL Popis 1920",
    "0 TRLR",
    "",
  ].join("\n");

  it("brings the whole event subtree — place coordinate, address, note and citation — to the target", () => {
    const ds = buildFromText(HOUSEHOLD);
    const source = ds.individuals.get("@I1@")!;
    const target = ds.individuals.get("@I2@")!;
    const resiNode = source.raw.children.find((c) => c.tag === "RESI")!;

    expect(copyEventToIndividual(target, resiNode)).toBeDefined();

    const updated = rebuildIndividual(ds, target);
    const resi = updated.events.find((e) => e.tag === "RESI")!;
    expect(resi.date?.raw).toBe("1920");
    expect(resi.place?.raw).toBe("Kranj, Slovenija");
    expect(resi.place?.coord).toEqual({ lat: 46.239, lon: 14.355 });
    expect(resi.address?.raw).toBe("Koroška cesta 14");
    expect(resi.note).toContain("Preselil se je po poroki");
    expect(resi.sources?.[0]?.page).toBe("12");
  });

  it("leaves the source record untouched", () => {
    const ds = buildFromText(HOUSEHOLD);
    const source = ds.individuals.get("@I1@")!;
    const before = clone(source.raw);
    copyEventToIndividual(ds.individuals.get("@I2@")!, source.raw.children.find((c) => c.tag === "RESI")!);
    expect(source.raw).toEqual(before);
  });

  it("refuses a second identical copy, so re-running the same copy adds nothing", () => {
    const ds = buildFromText(HOUSEHOLD);
    const resiNode = ds.individuals.get("@I1@")!.raw.children.find((c) => c.tag === "RESI")!;
    const target = ds.individuals.get("@I2@")!;

    copyEventToIndividual(target, resiNode);
    expect(copyEventToIndividual(target, resiNode)).toBeUndefined();
    expect(rebuildIndividual(ds, target).events.filter((e) => e.tag === "RESI")).toHaveLength(1);
  });

  it("still copies a different event of a tag the target already uses", () => {
    const ds = buildFromText(HOUSEHOLD);
    const resiNode = ds.individuals.get("@I1@")!.raw.children.find((c) => c.tag === "RESI")!;
    const target = ds.individuals.get("@I2@")!;
    setEventField(target, "RESI", { date: "1899", place: "Ljubljana" });

    expect(copyEventToIndividual(target, resiNode)).toBeDefined();
    expect(rebuildIndividual(ds, target).events.filter((e) => e.tag === "RESI")).toHaveLength(2);
  });

  it("marks the copy as new, so save-time audit stamping treats it as added", () => {
    const ds = buildFromText(HOUSEHOLD);
    const resiNode = ds.individuals.get("@I1@")!.raw.children.find((c) => c.tag === "RESI")!;
    const copy = copyEventToIndividual(ds.individuals.get("@I2@")!, resiNode)!;
    expect(copy.auditStamp).toBe("new");
    expect(resiNode.auditStamp).toBeUndefined();
  });
});

describe("copyEventToFamily", () => {
  const TWO_FAMILIES = [
    "0 HEAD",
    "1 GEDC",
    "2 VERS 5.5.1",
    "0 @F1@ FAM",
    "1 MARR",
    "2 DATE 4 MAY 1901",
    "2 PLAC Kranj, Slovenija",
    "0 @F2@ FAM",
    "0 TRLR",
    "",
  ].join("\n");

  it("copies the event onto another family", () => {
    const ds = buildFromText(TWO_FAMILIES);
    const marr = ds.families.get("@F1@")!.raw.children.find((c) => c.tag === "MARR")!;
    const target = ds.families.get("@F2@")!;

    expect(copyEventToFamily(target, marr)).toBeDefined();
    const updated = rebuildFamily(ds, target);
    expect(updated.events.find((e) => e.tag === "MARR")?.date?.raw).toBe("4 MAY 1901");
  });

  it("leaves a family that already has an event of this tag alone — the editor holds one per tag", () => {
    const ds = buildFromText(TWO_FAMILIES);
    const marr = ds.families.get("@F1@")!.raw.children.find((c) => c.tag === "MARR")!;
    const target = ds.families.get("@F2@")!;
    setFamilyEventField(target, "MARR", { date: "1899" });

    expect(copyEventToFamily(target, marr)).toBeUndefined();
    const updated = rebuildFamily(ds, target);
    expect(updated.events.filter((e) => e.tag === "MARR")).toHaveLength(1);
    expect(updated.events[0].date?.raw).toBe("1899");
  });
});

// ─── addEventNode / removeEventAtIndex ───────────────────────────────────────

describe("addEventNode", () => {
  it("appends a new empty event in canonical order", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    addEventNode(indi, "DEAT");
    const updated = rebuildIndividual(ds, indi);
    expect(updated.events.some((e) => e.tag === "DEAT")).toBe(true);
  });

  it("appends a second RESI event after the first", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    setEventField(indi, "RESI", { date: "1900" });
    rebuildIndividual(ds, indi);
    addEventNode(indi, "RESI");
    const updated = rebuildIndividual(ds, indi);
    expect(updated.events.filter((e) => e.tag === "RESI")).toHaveLength(2);
    // Second RESI should immediately follow the first in raw children
    const resiNodes = indi.raw.children.filter((c) => c.tag === "RESI");
    const firstIdx = indi.raw.children.indexOf(resiNodes[0]);
    const secondIdx = indi.raw.children.indexOf(resiNodes[1]);
    expect(secondIdx).toBe(firstIdx + 1);
  });
});

describe("removeEventAtIndex", () => {
  it("removes BIRT at index 0", () => {
    const ds = buildFromText([
      "0 HEAD",
      "1 GEDC",
      "2 VERS 5.5.1",
      "0 @I1@ INDI",
      "1 NAME Janez /Novak/",
      "1 BIRT",
      "2 DATE 12 JAN 1850",
      "1 DEAT",
      "2 DATE 1920",
      "0 TRLR",
      "",
    ].join("\n"));
    const indi = ds.individuals.get("@I1@")!;
    expect(indi.events[0].tag).toBe("BIRT");
    removeEventAtIndex(indi, 0);
    const updated = rebuildIndividual(ds, indi);
    expect(updated.events).toHaveLength(1);
    expect(updated.events[0].tag).toBe("DEAT");
  });

  it("removes a middle event leaving others intact", () => {
    const ds = buildFromText([
      "0 HEAD",
      "1 GEDC",
      "2 VERS 5.5.1",
      "0 @I1@ INDI",
      "1 BIRT",
      "2 DATE 1850",
      "1 RESI",
      "2 DATE 1880",
      "1 DEAT",
      "2 DATE 1920",
      "0 TRLR",
      "",
    ].join("\n"));
    const indi = ds.individuals.get("@I1@")!;
    removeEventAtIndex(indi, 1); // remove RESI
    const updated = rebuildIndividual(ds, indi);
    expect(updated.events.map((e) => e.tag)).toEqual(["BIRT", "DEAT"]);
  });
});

describe("changeEventTagAtIndex", () => {
  it("changes an OCCU event into an EDUC event, keeping its fields", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    setEventField(indi, "OCCU", { value: "Farmer", date: "1880" });
    rebuildIndividual(ds, indi);
    changeEventTagAtIndex(indi, 0, "EDUC");
    const updated = rebuildIndividual(ds, indi);
    expect(updated.events).toHaveLength(1);
    expect(updated.events[0].tag).toBe("EDUC");
    expect(updated.events[0].value).toBe("Farmer");
    expect(updated.events[0].date?.raw).toBe("1880");
  });

  it("keeps the event's original position among siblings rather than moving it to its new tag's canonical position", () => {
    const ds = buildFromText([
      "0 HEAD",
      "1 GEDC",
      "2 VERS 5.5.1",
      "0 @I1@ INDI",
      "1 BIRT",
      "2 DATE 1850",
      "1 OCCU Farmer",
      "1 DEAT",
      "2 DATE 1920",
      "0 TRLR",
      "",
    ].join("\n"));
    const indi = ds.individuals.get("@I1@")!;
    changeEventTagAtIndex(indi, 1, "BURI"); // OCCU at index 1 → BURI, canonically belongs after DEAT
    const updated = rebuildIndividual(ds, indi);
    expect(updated.events.map((e) => e.tag)).toEqual(["BIRT", "BURI", "DEAT"]);
  });

  it("is a no-op for an out-of-range index or an unchanged tag", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    setEventField(indi, "OCCU", { value: "Farmer" });
    rebuildIndividual(ds, indi);
    changeEventTagAtIndex(indi, 5, "EDUC");
    changeEventTagAtIndex(indi, 0, "OCCU");
    const updated = rebuildIndividual(ds, indi);
    expect(updated.events.map((e) => e.tag)).toEqual(["OCCU"]);
  });
});

// ─── setFamilyEventField ─────────────────────────────────────────────────────

describe("setFamilyEventField", () => {
  const FAM_INDI_BASE = [
    "0 HEAD",
    "1 GEDC",
    "2 VERS 5.5.1",
    "0 @I1@ INDI",
    "1 NAME Janez /Novak/",
    "1 FAMS @F1@",
    "0 @I2@ INDI",
    "1 NAME Ana /Kos/",
    "1 FAMS @F1@",
    "0 @F1@ FAM",
    "1 HUSB @I1@",
    "1 WIFE @I2@",
    "0 TRLR",
    "",
  ].join("\n");

  it("creates a new MARR event with date and place, ordered after HUSB/WIFE", () => {
    const ds = buildFromText(FAM_INDI_BASE);
    const fam = ds.families.get("@F1@")!;
    setFamilyEventField(fam, "MARR", { date: "5 MAY 1880", place: "Ljubljana" });

    expect(serializeGedcom(ds.records)).toContain([
      "0 @F1@ FAM",
      "1 HUSB @I1@",
      "1 WIFE @I2@",
      "1 MARR",
      "2 DATE 5 MAY 1880",
      "2 PLAC Ljubljana",
    ].join("\n"));

    const updated = rebuildFamily(ds, fam);
    expect(updated.events[0].date?.raw).toBe("5 MAY 1880");
    expect(updated.events[0].place?.raw).toBe("Ljubljana");
    expect(ds.families.get("@F1@")).toBe(updated);
  });

  it("removes the MARR event once it's empty", () => {
    const ds = buildFromText(FAM_INDI_BASE);
    const fam = ds.families.get("@F1@")!;
    setFamilyEventField(fam, "MARR", { date: "1880" });
    setFamilyEventField(fam, "MARR", { date: "" });

    expect(serializeGedcom(ds.records)).toBe(FAM_INDI_BASE);
  });
});

// ─── addFamilyEventNode / removeFamilyEvent ───────────────────────────────────

describe("addFamilyEventNode", () => {
  it("appends a new ENGA event in canonical order after MARR", () => {
    const ds = buildFromText(FAM_BASE);
    const fam = ds.families.get("@F1@")!;
    setFamilyEventField(fam, "MARR", { date: "1880" });
    addFamilyEventNode(fam, "ENGA");
    const updated = rebuildFamily(ds, fam);
    const tags = updated.events.map((e) => e.tag);
    expect(tags).toContain("ENGA");
    const marrIdx = fam.raw.children.findIndex((c) => c.tag === "MARR");
    const engaIdx = fam.raw.children.findIndex((c) => c.tag === "ENGA");
    expect(engaIdx).toBeGreaterThan(marrIdx);
  });
});

describe("removeFamilyEvent", () => {
  it("removes an ENGA event from the family raw node", () => {
    const ds = buildFromText(FAM_BASE);
    const fam = ds.families.get("@F1@")!;
    addFamilyEventNode(fam, "ENGA");
    setFamilyEventField(fam, "ENGA", { date: "1878" });
    rebuildFamily(ds, fam);
    expect(fam.raw.children.some((c) => c.tag === "ENGA")).toBe(true);

    removeFamilyEvent(fam, "ENGA");
    const updated = rebuildFamily(ds, fam);
    expect(updated.events.some((e) => e.tag === "ENGA")).toBe(false);
  });

  it("is a no-op when the tag is absent", () => {
    const ds = buildFromText(FAM_BASE);
    const fam = ds.families.get("@F1@")!;
    const before = clone(fam.raw);
    removeFamilyEvent(fam, "DIV");
    expect(JSON.stringify(fam.raw)).toBe(JSON.stringify(before));
  });
});

describe("changeFamilyEventTag", () => {
  it("changes an ENGA event into a MARR event, keeping its fields and position", () => {
    const ds = buildFromText(FAM_BASE);
    const fam = ds.families.get("@F1@")!;
    addFamilyEventNode(fam, "ENGA");
    setFamilyEventField(fam, "ENGA", { date: "1878", place: "Kranj" });
    setFamilyEventField(fam, "DIV", { date: "1900" });
    rebuildFamily(ds, fam);

    changeFamilyEventTag(fam, "ENGA", "MARR");
    const updated = rebuildFamily(ds, fam);
    expect(updated.events.map((e) => e.tag)).toEqual(["MARR", "DIV"]);
    expect(updated.events[0].date?.raw).toBe("1878");
    expect(updated.events[0].place?.raw).toBe("Kranj");
  });

  it("is a no-op when the target tag already exists on the family", () => {
    const ds = buildFromText(FAM_BASE);
    const fam = ds.families.get("@F1@")!;
    setFamilyEventField(fam, "MARR", { date: "1880" });
    setFamilyEventField(fam, "DIV", { date: "1900" });
    const before = clone(fam.raw);

    changeFamilyEventTag(fam, "MARR", "DIV");
    expect(JSON.stringify(fam.raw)).toBe(JSON.stringify(before));
  });

  it("is a no-op when the source tag is absent or unchanged", () => {
    const ds = buildFromText(FAM_BASE);
    const fam = ds.families.get("@F1@")!;
    setFamilyEventField(fam, "MARR", { date: "1880" });
    const before = clone(fam.raw);

    changeFamilyEventTag(fam, "ENGA", "DIV");
    changeFamilyEventTag(fam, "MARR", "MARR");
    expect(JSON.stringify(fam.raw)).toBe(JSON.stringify(before));
  });
});

// ─── setName ─────────────────────────────────────────────────────────────────

describe("setName", () => {
  it("updates the NAME value", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    setName(indi, { given: "Janez Karel", surname: "Novak" });

    const updated = rebuildIndividual(ds, indi);
    expect(updated.names[0].full).toBe("Janez Karel Novak");
    expect(serializeGedcom(ds.records)).toContain("1 NAME Janez Karel /Novak/");
  });

  it("keeps existing GIVN/SURN sub-tags (MacFamilyTree style) in sync with the edit", () => {
    const ds = buildFromText([
      "0 HEAD",
      "1 GEDC",
      "2 VERS 5.5.1",
      "0 @I1@ INDI",
      "1 NAME Janez /Novak/",
      "2 GIVN Janez",
      "2 SURN Novak",
      "0 TRLR",
      "",
    ].join("\n"));
    const indi = ds.individuals.get("@I1@")!;
    setName(indi, { given: "Janez Karel", surname: "Kovač" });

    const text = serializeGedcom(ds.records);
    expect(text).toContain("1 NAME Janez Karel /Kovač/");
    expect(text).toContain("2 GIVN Janez Karel");
    expect(text).toContain("2 SURN Kovač");
    expect(rebuildIndividual(ds, indi).names[0].surname).toBe("Kovač");
  });

  it("does not add GIVN/SURN sub-tags to a slash-form-only name", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    setName(indi, { given: "Janez", surname: "Kovač" });

    const text = serializeGedcom(ds.records);
    expect(text).toContain("1 NAME Janez /Kovač/");
    expect(text).not.toContain("GIVN");
    expect(text).not.toContain("SURN");
  });

  it("removes an emptied GIVN/SURN sub-tag when a name part is cleared", () => {
    const ds = buildFromText([
      "0 HEAD",
      "1 GEDC",
      "2 VERS 5.5.1",
      "0 @I1@ INDI",
      "1 NAME Janez /Novak/",
      "2 GIVN Janez",
      "2 SURN Novak",
      "0 TRLR",
      "",
    ].join("\n"));
    const indi = ds.individuals.get("@I1@")!;
    setName(indi, { given: "Janez" });

    const text = serializeGedcom(ds.records);
    expect(text).toContain("1 NAME Janez");
    expect(text).toContain("2 GIVN Janez");
    expect(text).not.toContain("SURN");
  });

  it("replaces a / typed into a name part with a space (slash-form delimiter)", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    setName(indi, { given: "Janez/Ivan", surname: "Novak" });

    expect(serializeGedcom(ds.records)).toContain("1 NAME Janez Ivan /Novak/");
    const updated = rebuildIndividual(ds, indi);
    expect(updated.names[0].given).toBe("Janez Ivan");
    expect(updated.names[0].surname).toBe("Novak");
  });

  it("creates a NAME line when missing", () => {
    const ds = buildFromText([
      "0 HEAD",
      "1 GEDC",
      "2 VERS 5.5.1",
      "0 @I1@ INDI",
      "1 SEX M",
      "0 TRLR",
      "",
    ].join("\n"));
    const indi = ds.individuals.get("@I1@")!;
    setName(indi, { given: "Ana" });

    expect(serializeGedcom(ds.records)).toBe([
      "0 HEAD",
      "1 GEDC",
      "2 VERS 5.5.1",
      "0 @I1@ INDI",
      "1 NAME Ana",
      "1 SEX M",
      "0 TRLR",
      "",
    ].join("\n"));
  });
});

// ─── setNickname ──────────────────────────────────────────────────────────────

describe("setNickname", () => {
  it("adds and removes the primary name's NICK sub-tag", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    setNickname(indi, "Janezek");

    let updated = rebuildIndividual(ds, indi);
    expect(updated.names[0].nickname).toBe("Janezek");
    expect(serializeGedcom(ds.records)).toContain("2 NICK Janezek");

    setNickname(indi, "");
    updated = rebuildIndividual(ds, indi);
    expect(updated.names[0].nickname).toBeUndefined();
  });
});

// ─── additional names ─────────────────────────────────────────────────────────

describe("additional names", () => {
  it("adds, edits and removes an additional NAME record", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;

    addAdditionalName(indi, "married");
    let updated = rebuildIndividual(ds, indi);
    expect(updated.names).toHaveLength(2);
    expect(updated.names[1].type).toBe("married");

    setAdditionalName(indi, 0, { given: "Janez", surname: "Kovac" });
    updated = rebuildIndividual(ds, indi);
    expect(updated.names[1].full).toBe("Janez Kovac");
    expect(updated.names[1].type).toBe("married");
    expect(serializeGedcom(ds.records)).toContain("1 NAME Janez /Kovac/");

    setAdditionalName(indi, 0, { type: "maiden" });
    updated = rebuildIndividual(ds, indi);
    expect(updated.names[1].type).toBe("maiden");

    removeAdditionalName(indi, 0);
    updated = rebuildIndividual(ds, indi);
    expect(updated.names).toHaveLength(1);
  });

  it("sets and clears the primary name's inline _MARNM married surname", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;

    setMarriedName(indi, "Kovač");
    let updated = rebuildIndividual(ds, indi);
    expect(updated.names[0].married).toBe("Kovač");
    expect(serializeGedcom(ds.records)).toContain("2 _MARNM Kovač");

    setMarriedName(indi, "");
    updated = rebuildIndividual(ds, indi);
    expect(updated.names[0].married).toBeUndefined();
    expect(serializeGedcom(ds.records)).not.toContain("_MARNM");
  });

  it("folds an additional married NAME record into the primary name's _MARNM", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;

    addAdditionalName(indi, "married");
    setAdditionalName(indi, 0, { surname: "Kovač" });
    const withMarried = rebuildIndividual(ds, indi);

    foldAdditionalNameToMarnm(withMarried, 0);
    const updated = rebuildIndividual(ds, withMarried);
    expect(updated.names).toHaveLength(1);
    expect(updated.names[0].married).toBe("Kovač");
  });
});

// ─── setNotes / setFamilyNotes ────────────────────────────────────────────────

describe("setNotes", () => {
  it("adds notes to an individual", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    setNotes(noteCtx(ds.records), indi, [{ text: "First note" }, { text: "Second note" }]);
    const updated = rebuildIndividual(ds, indi);
    expect(updated.notes).toEqual(["First note", "Second note"]);
  });

  it("replaces existing notes", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    setNotes(noteCtx(ds.records), indi, [{ text: "Old note" }]);
    setNotes(noteCtx(ds.records), indi, [{ text: "New note" }]);
    const updated = rebuildIndividual(ds, indi);
    expect(updated.notes).toEqual(["New note"]);
  });

  it("removes all notes when given an empty array", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    setNotes(noteCtx(ds.records), indi, [{ text: "A note" }]);
    setNotes(noteCtx(ds.records), indi, []);
    const updated = rebuildIndividual(ds, indi);
    expect(updated.notes ?? []).toHaveLength(0);
    expect(serializeGedcom(ds.records)).not.toContain("NOTE");
  });
});

describe("setFamilyNotes", () => {
  it("adds notes to a family", () => {
    const ds = buildFromText(FAM_BASE);
    const fam = ds.families.get("@F1@")!;
    setFamilyNotes(noteCtx(ds.records), fam, [{ text: "Family note" }]);
    const updated = rebuildFamily(ds, fam);
    expect(updated.notes).toEqual(["Family note"]);
  });

  it("clears family notes", () => {
    const ds = buildFromText(FAM_BASE);
    const fam = ds.families.get("@F1@")!;
    setFamilyNotes(noteCtx(ds.records), fam, [{ text: "Note" }]);
    setFamilyNotes(noteCtx(ds.records), fam, []);
    const updated = rebuildFamily(ds, fam);
    expect(updated.notes ?? []).toHaveLength(0);
  });
});

// ─── setIndividualLinks ───────────────────────────────────────────────────────

describe("setIndividualLinks", () => {
  it("adds links to an individual", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    setIndividualLinks(indi, ["https://example.com/a", "https://example.com/b"]);
    const updated = rebuildIndividual(ds, indi);
    expect(updated.links).toEqual(["https://example.com/a", "https://example.com/b"]);
  });

  it("replaces existing links", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    setIndividualLinks(indi, ["https://old.example.com"]);
    setIndividualLinks(indi, ["https://new.example.com"]);
    const updated = rebuildIndividual(ds, indi);
    expect(updated.links).toEqual(["https://new.example.com"]);
  });

  it("removes all links when given an empty array", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    setIndividualLinks(indi, ["https://example.com"]);
    setIndividualLinks(indi, []);
    const updated = rebuildIndividual(ds, indi);
    expect(updated.links ?? []).toHaveLength(0);
    expect(serializeGedcom(ds.records)).not.toContain("WWW");
  });
});

// ─── addParent ────────────────────────────────────────────────────────────────

describe("addParent", () => {
  it("creates a new family and FAMC link when the person has none", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;

    const father = addParent(ds, indi, undefined, "father");

    expect(father.sex).toBe("M");
    const fam = [...ds.families.values()].find((f) => f.husband === father.id)!;
    expect(fam.children).toContain(indi.id);
    expect(ds.individuals.get(indi.id)!.childOf).toContain(fam.id);
  });

  it("fills the missing HUSB/WIFE slot of an existing family", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;

    // First add a child, which creates a family with `indi` as HUSB and no WIFE.
    const child = addChild(ds, indi, undefined);
    const fam = [...ds.families.values()].find((f) => f.husband === indi.id)!;
    expect(fam.wife).toBeUndefined();

    const mother = addParent(ds, ds.individuals.get(child.id)!, fam, "mother");

    expect(mother.sex).toBe("F");
    expect(rebuildFamily(ds, fam).wife).toBe(mother.id);
  });
});

// ─── addPartner ───────────────────────────────────────────────────────────────

describe("addPartner", () => {
  it("creates a new family with the person and partner in opposite roles", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!; // sex M

    const partner = addPartner(ds, indi, undefined);

    expect(partner.sex).toBe("F");
    const fam = [...ds.families.values()].find((f) => f.husband === indi.id)!;
    expect(fam.wife).toBe(partner.id);
    expect(ds.individuals.get(indi.id)!.spouseOf).toContain(fam.id);
    expect(partner.spouseOf).toContain(fam.id);
  });

  it("fills the missing HUSB/WIFE slot of an existing family", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!; // sex M
    const child = addChild(ds, indi, undefined);
    const fam = [...ds.families.values()].find((f) => f.husband === indi.id)!;

    const partner = addPartner(ds, ds.individuals.get(indi.id)!, fam);

    expect(partner.sex).toBe("F");
    expect(rebuildFamily(ds, fam).wife).toBe(partner.id);
    expect(rebuildIndividual(ds, ds.individuals.get(child.id)!).childOf).toContain(fam.id);
  });
});

// ─── addChild ─────────────────────────────────────────────────────────────────

describe("addChild", () => {
  it("creates a new spouse family for the person and adds the child to it", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!; // sex M

    const child = addChild(ds, indi, undefined);

    const fam = [...ds.families.values()].find((f) => f.husband === indi.id)!;
    expect(fam.children).toContain(child.id);
    expect(child.childOf).toContain(fam.id);
  });

  it("adds another child to an existing family", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    const first = addChild(ds, indi, undefined);
    const fam = [...ds.families.values()].find((f) => f.husband === indi.id)!;

    const second = addChild(ds, ds.individuals.get(indi.id)!, fam);
    const updatedFam = rebuildFamily(ds, fam);
    expect(updatedFam.children).toEqual([first.id, second.id]);
  });
});

// ─── child birth-order insertion ────────────────────────────────────────────

describe("connectExistingChild (birth order)", () => {
  // A family with two children born 1805 and 1811, plus a loose individual
  // born 1807 to be attached between them.
  const TEXT =
    "0 @I1@ INDI\n1 SEX M\n" +
    "0 @C1@ INDI\n1 BIRT\n2 DATE 1805\n" +
    "0 @C2@ INDI\n1 BIRT\n2 DATE 1811\n" +
    "0 @C3@ INDI\n1 BIRT\n2 DATE 1807\n" +
    "0 @F1@ FAM\n1 HUSB @I1@\n1 CHIL @C1@\n1 CHIL @C2@\n";

  it("inserts an attached child in birth order, not at the end", () => {
    const ds = buildFromText(TEXT);
    const person = ds.individuals.get("@I1@")!;
    const fam = ds.families.get("@F1@")!;

    connectExistingChild(ds, person, "@C3@", fam);

    const updatedFam = rebuildFamily(ds, fam);
    expect(updatedFam.children).toEqual(["@C1@", "@C3@", "@C2@"]);
  });

  it("places a child with no known birth date after the dated children", () => {
    const ds = buildFromText(TEXT);
    const person = ds.individuals.get("@I1@")!;
    const fam = ds.families.get("@F1@")!;
    const newborn = addChild(ds, person, fam); // empty individual, no birth

    const updatedFam = rebuildFamily(ds, fam);
    expect(updatedFam.children).toEqual(["@C1@", "@C2@", newborn.id]);
  });
});

// ─── detachSpouseRole ─────────────────────────────────────────────────────────

describe("detachSpouseRole", () => {
  it("removes the HUSB from the family and the matching FAMS from the individual", () => {
    const ds = buildFromText(FAM_BASE);
    const fam = ds.families.get("@F1@")!;

    detachSpouseRole(ds, fam, "HUSB");

    const updatedFam = rebuildFamily(ds, fam);
    expect(updatedFam.husband).toBeUndefined();
    const updatedIndi = ds.individuals.get("@I1@")!;
    expect(updatedIndi.spouseOf).not.toContain("@F1@");
    expect(serializeGedcom(ds.records)).not.toContain("1 HUSB @I1@");
  });

  it("removes the WIFE from the family and the matching FAMS from the individual", () => {
    const ds = buildFromText(FAM_BASE);
    const fam = ds.families.get("@F1@")!;

    detachSpouseRole(ds, fam, "WIFE");

    const updatedFam = rebuildFamily(ds, fam);
    expect(updatedFam.wife).toBeUndefined();
    const wife = ds.individuals.get("@I2@")!;
    expect(wife.spouseOf).not.toContain("@F1@");
  });

  it("prunes the family when detaching its last remaining member", () => {
    const ds = buildFromText([
      "0 HEAD", "1 GEDC", "2 VERS 5.5.1",
      "0 @I1@ INDI", "1 NAME Janez /Novak/", "1 FAMS @F1@",
      "0 @F1@ FAM", "1 HUSB @I1@",
      "0 TRLR", "",
    ].join("\n"));
    const fam = ds.families.get("@F1@")!;

    detachSpouseRole(ds, fam, "HUSB");

    expect(ds.families.has("@F1@")).toBe(false);
    expect(ds.records.some((r) => r.xref === "@F1@")).toBe(false);
    expect(ds.individuals.get("@I1@")!.spouseOf).not.toContain("@F1@");
  });

  it("prunes a childless couple when one spouse is detached, unlinking the other", () => {
    const ds = buildFromText([
      "0 HEAD", "1 GEDC", "2 VERS 5.5.1",
      "0 @I1@ INDI", "1 NAME Janez /Novak/", "1 FAMS @F1@",
      "0 @I2@ INDI", "1 NAME Ana /Kos/", "1 FAMS @F1@",
      "0 @F1@ FAM", "1 HUSB @I1@", "1 WIFE @I2@",
      "0 TRLR", "",
    ].join("\n"));
    const fam = ds.families.get("@F1@")!;

    detachSpouseRole(ds, fam, "HUSB");

    expect(ds.families.has("@F1@")).toBe(false);
    expect(ds.individuals.get("@I1@")!.spouseOf).not.toContain("@F1@");
    expect(ds.individuals.get("@I2@")!.spouseOf).not.toContain("@F1@");
  });
});

// ─── detachChildFromFamily ────────────────────────────────────────────────────

describe("detachChildFromFamily", () => {
  it("removes the child from the family CHIL list and the FAMC from the child", () => {
    const ds = buildFromText(FAM_BASE);
    const fam = ds.families.get("@F1@")!;

    detachChildFromFamily(ds, fam, "@I3@");

    const updatedFam = rebuildFamily(ds, fam);
    expect(updatedFam.children).not.toContain("@I3@");
    const child = ds.individuals.get("@I3@")!;
    expect(child.childOf).not.toContain("@F1@");
    expect(serializeGedcom(ds.records)).not.toContain("1 CHIL @I3@");
  });

  it("prunes the family when detaching its only child leaves it empty", () => {
    const ds = buildFromText([
      "0 HEAD", "1 GEDC", "2 VERS 5.5.1",
      "0 @I3@ INDI", "1 NAME Bine /Novak/", "1 FAMC @F1@",
      "0 @F1@ FAM", "1 CHIL @I3@",
      "0 TRLR", "",
    ].join("\n"));
    const fam = ds.families.get("@F1@")!;

    detachChildFromFamily(ds, fam, "@I3@");

    expect(ds.families.has("@F1@")).toBe(false);
    expect(ds.records.some((r) => r.xref === "@F1@")).toBe(false);
    expect(ds.individuals.get("@I3@")!.childOf).not.toContain("@F1@");
  });
});

// ─── removeIndividual ─────────────────────────────────────────────────────────

describe("removeIndividual", () => {
  it("removes the individual from the dataset and cleans up all family references", () => {
    const ds = buildFromText(FAM_BASE);
    const husband = ds.individuals.get("@I1@")!;

    removeIndividual(ds, husband);

    expect(ds.individuals.has("@I1@")).toBe(false);
    expect(ds.records.some((r) => r.xref === "@I1@")).toBe(false);
    const fam = rebuildFamily(ds, ds.families.get("@F1@")!);
    expect(fam.husband).toBeUndefined();
  });

  it("removes a child and cleans up the CHIL pointer in the family", () => {
    const ds = buildFromText(FAM_BASE);
    const child = ds.individuals.get("@I3@")!;

    removeIndividual(ds, child);

    expect(ds.individuals.has("@I3@")).toBe(false);
    const fam = rebuildFamily(ds, ds.families.get("@F1@")!);
    expect(fam.children).not.toContain("@I3@");
  });

  it("prunes a childless couple's family on the first spouse delete, unlinking the survivor", () => {
    const ds = buildFromText([
      "0 HEAD", "1 GEDC", "2 VERS 5.5.1",
      "0 @I1@ INDI", "1 NAME Janez /Novak/", "1 FAMS @F1@",
      "0 @I2@ INDI", "1 NAME Ana /Kos/", "1 FAMS @F1@",
      "0 @F1@ FAM", "1 HUSB @I1@", "1 WIFE @I2@",
      "2 DATE 18 JUN 2026",
      "0 TRLR", "",
    ].join("\n"));

    // Couple is two members → deleting one leaves a single-member (degenerate)
    // family, which is pruned, and the surviving spouse's FAMS is cleaned up.
    removeIndividual(ds, ds.individuals.get("@I1@")!);
    expect(ds.families.has("@F1@")).toBe(false);
    expect(ds.records.some((r) => r.xref === "@F1@")).toBe(false);
    expect(ds.individuals.get("@I2@")!.spouseOf).not.toContain("@F1@");
  });

  it("keeps a family while two members remain, prunes it when only one is left", () => {
    const ds = buildFromText(FAM_BASE); // HUSB + WIFE + one CHIL

    removeIndividual(ds, ds.individuals.get("@I1@")!);
    expect(ds.families.has("@F1@")).toBe(true); // wife + child remain

    removeIndividual(ds, ds.individuals.get("@I2@")!);
    expect(ds.families.has("@F1@")).toBe(false); // only the child was left
    expect(ds.individuals.get("@I3@")!.childOf).not.toContain("@F1@");
  });
});

// ─── removeFamily ─────────────────────────────────────────────────────────────

describe("removeFamily", () => {
  it("removes the family and cleans FAMS/FAMC pointers from all members", () => {
    const ds = buildFromText(FAM_BASE);
    const fam = ds.families.get("@F1@")!;

    removeFamily(ds, fam);

    expect(ds.families.has("@F1@")).toBe(false);
    expect(ds.records.some((r) => r.xref === "@F1@")).toBe(false);
    expect(ds.individuals.get("@I1@")!.spouseOf).not.toContain("@F1@");
    expect(ds.individuals.get("@I2@")!.spouseOf).not.toContain("@F1@");
    expect(ds.individuals.get("@I3@")!.childOf).not.toContain("@F1@");
  });
});

// ─── setSex ───────────────────────────────────────────────────────────────────

describe("setSex", () => {
  it("changes the SEX value", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    setSex(indi, "F");
    expect(rebuildIndividual(ds, indi).sex).toBe("F");
    expect(serializeGedcom(ds.records)).toContain("1 SEX F");
  });

  it("removes SEX when set to unknown", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    setSex(indi, "U");
    expect(rebuildIndividual(ds, indi).sex).toBe("U");
    expect(serializeGedcom(ds.records)).not.toContain("SEX");
  });
});

// ─── undo/redo round-trips ────────────────────────────────────────────────────

describe("undo/redo round-trips", () => {
  it("name edit: undo restores original, redo re-applies edit", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    const before = clone(indi.raw);

    setName(indi, { given: "Karel", surname: "Novak" });
    const after = clone(indi.raw);
    rebuildIndividual(ds, indi);
    expect(ds.individuals.get("@I1@")!.names[0].given).toBe("Karel");

    applyPatch(ds, { type: "individual", id: "@I1@", before, after }, "undo");
    expect(ds.individuals.get("@I1@")!.names[0].given).toBe("Janez");

    applyPatch(ds, { type: "individual", id: "@I1@", before, after }, "redo");
    expect(ds.individuals.get("@I1@")!.names[0].given).toBe("Karel");
  });

  it("event add: undo removes the event, redo restores it", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    const before = clone(indi.raw);

    setEventField(indi, "BIRT", { date: "1 JAN 1850", place: "Kranj" });
    const after = clone(indi.raw);
    rebuildIndividual(ds, indi);
    expect(ds.individuals.get("@I1@")!.events[0].tag).toBe("BIRT");

    applyPatch(ds, { type: "individual", id: "@I1@", before, after }, "undo");
    expect(ds.individuals.get("@I1@")!.events).toHaveLength(0);

    applyPatch(ds, { type: "individual", id: "@I1@", before, after }, "redo");
    expect(ds.individuals.get("@I1@")!.events[0].date?.raw).toBe("1 JAN 1850");
  });

  it("addChild: undo removes the new person and reverts family, redo restores both", () => {
    const ds = buildFromText(BASE);
    const parent = ds.individuals.get("@I1@")!;
    const beforeParent = clone(parent.raw);

    const child = addChild(ds, parent, undefined);
    const childId = child.id;
    const fam = [...ds.families.values()].find((f) => f.children.includes(childId))!;
    const famId = fam.id;

    const afterParent = clone(ds.individuals.get("@I1@")!.raw);
    const afterChild = clone(child.raw);
    const afterFam = clone(fam.raw);

    expect(ds.individuals.has(childId)).toBe(true);
    expect(ds.families.has(famId)).toBe(true);

    // Undo: remove child and family; restore parent
    applyPatch(ds, { type: "individual", id: childId, before: null, after: afterChild }, "undo");
    applyPatch(ds, { type: "family", id: famId, before: null, after: afterFam }, "undo");
    applyPatch(ds, { type: "individual", id: "@I1@", before: beforeParent, after: afterParent }, "undo");

    expect(ds.individuals.has(childId)).toBe(false);
    expect(ds.families.has(famId)).toBe(false);
    expect(ds.individuals.get("@I1@")!.spouseOf).toHaveLength(0);

    // Redo: recreate child and family; restore parent post-add state
    applyPatch(ds, { type: "individual", id: "@I1@", before: beforeParent, after: afterParent }, "redo");
    applyPatch(ds, { type: "family", id: famId, before: null, after: afterFam }, "redo");
    applyPatch(ds, { type: "individual", id: childId, before: null, after: afterChild }, "redo");

    expect(ds.individuals.has(childId)).toBe(true);
    expect(ds.families.get(famId)!.children).toContain(childId);
    expect(ds.individuals.get("@I1@")!.spouseOf).toContain(famId);
  });

  it("removeIndividual: undo restores person and family pointers, redo deletes again", () => {
    const ds = buildFromText(FAM_BASE);
    const husband = ds.individuals.get("@I1@")!;
    const beforeHusband = clone(husband.raw);
    const beforeFam = clone(ds.families.get("@F1@")!.raw);

    removeIndividual(ds, husband);
    const afterFam = clone(ds.families.get("@F1@")!.raw);

    expect(ds.individuals.has("@I1@")).toBe(false);
    expect(ds.families.get("@F1@")!.husband).toBeUndefined();

    // Undo: restore husband, restore family
    applyPatch(ds, { type: "family", id: "@F1@", before: beforeFam, after: afterFam }, "undo");
    applyPatch(ds, { type: "individual", id: "@I1@", before: beforeHusband, after: null }, "undo");

    expect(ds.individuals.has("@I1@")).toBe(true);
    expect(ds.families.get("@F1@")!.husband).toBe("@I1@");
    expect(ds.individuals.get("@I1@")!.spouseOf).toContain("@F1@");

    // Redo: delete again
    applyPatch(ds, { type: "individual", id: "@I1@", before: beforeHusband, after: null }, "redo");
    applyPatch(ds, { type: "family", id: "@F1@", before: beforeFam, after: afterFam }, "redo");

    expect(ds.individuals.has("@I1@")).toBe(false);
    expect(ds.families.get("@F1@")!.husband).toBeUndefined();
  });

  it("family event edit: undo reverts MARR date, redo re-applies it", () => {
    const ds = buildFromText(FAM_BASE);
    const fam = ds.families.get("@F1@")!;
    const before = clone(fam.raw);

    setFamilyEventField(fam, "MARR", { date: "5 MAY 1880" });
    const after = clone(fam.raw);
    rebuildFamily(ds, fam);

    applyPatch(ds, { type: "family", id: "@F1@", before, after }, "undo");
    expect(ds.families.get("@F1@")!.events).toHaveLength(0);

    applyPatch(ds, { type: "family", id: "@F1@", before, after }, "redo");
    expect(ds.families.get("@F1@")!.events[0].date?.raw).toBe("5 MAY 1880");
  });
});

// ─── createSourceRecord / attachSourceCitation / removal ──────────────────────

describe("createSourceRecord / attachSourceCitation", () => {
  it("creates a SOUR+OBJE pair that resolves to an exact citation", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    const source = createSourceRecord(ds.records, {
      title: "Jožef Celar",
      author: "Marta Rendla",
      url: "https://www.sistory.si/ww2/5046DECC-E88C-4EA6-8B61-82D7A78C8626",
    });
    attachSourceCitation(indi.raw, source.xref!, undefined, INDI_CHILD_ORDER);
    const updated = rebuildIndividual(ds, indi);
    expect(updated.sources).toHaveLength(1);
    expect(updated.sources![0]).toMatchObject({
      title: "Jožef Celar",
      url: "https://www.sistory.si/ww2/5046DECC-E88C-4EA6-8B61-82D7A78C8626",
      exact: true,
    });
  });

  it("attaches a PAGE on the citation pointer, not on the SOUR record", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    const source = createSourceRecord(ds.records, { title: "Krstna knjiga", url: "https://example.com/book/?pg=11" });
    attachSourceCitation(indi.raw, source.xref!, "11", INDI_CHILD_ORDER);
    const updated = rebuildIndividual(ds, indi);
    expect(updated.sources![0].page).toBe("11");
  });
});

describe("addObjeToSource", () => {
  it("adds a new OBJE to an already-existing SOUR record", () => {
    const ds = buildFromText(BASE);
    const source = createSourceRecord(ds.records, { title: "Krstna knjiga", url: "https://example.com/book/?pg=1" });
    const obje = addObjeToSource(ds.records, source.xref!, "https://example.com/book/?pg=2");
    expect(source.children.filter((c) => c.tag === "OBJE")).toHaveLength(2);
    expect(obje.children[0].value).toBe("https://example.com/book/?pg=2");
  });
});

describe("removeSourceCitationAtIndex", () => {
  it("removes the citation and prunes the now-unreferenced SOUR/OBJE", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    const source = createSourceRecord(ds.records, { title: "X", url: "https://example.com/a" });
    attachSourceCitation(indi.raw, source.xref!, undefined, INDI_CHILD_ORDER);
    expect(ds.records.some((r) => r.xref === source.xref)).toBe(true);

    removeSourceCitationAtIndex(ds, indi.raw, 0);
    expect(ds.records.some((r) => r.xref === source.xref)).toBe(false);
    expect(ds.records.some((r) => r.tag === "OBJE")).toBe(false);
    expect(rebuildIndividual(ds, indi).sources ?? []).toHaveLength(0);
  });

  it("keeps the SOUR/OBJE when another citation still references it", () => {
    const ds = buildFromText(FAM_BASE);
    const indi1 = ds.individuals.get("@I1@")!;
    const indi3 = ds.individuals.get("@I3@")!;
    const source = createSourceRecord(ds.records, { title: "Shared", url: "https://example.com/shared" });
    attachSourceCitation(indi1.raw, source.xref!, undefined, INDI_CHILD_ORDER);
    attachSourceCitation(indi3.raw, source.xref!, undefined, INDI_CHILD_ORDER);

    removeSourceCitationAtIndex(ds, indi1.raw, 0);
    expect(ds.records.some((r) => r.xref === source.xref)).toBe(true);
  });
});

describe("updateSourceCitation", () => {
  it("edits the shared SOUR record's fields, visible from every citation of it", () => {
    const ds = buildFromText(FAM_BASE);
    const indi1 = ds.individuals.get("@I1@")!;
    const indi3 = ds.individuals.get("@I3@")!;
    const source = createSourceRecord(ds.records, { title: "Old Title", author: "Old Author" });
    attachSourceCitation(indi1.raw, source.xref!, undefined, INDI_CHILD_ORDER);
    attachSourceCitation(indi3.raw, source.xref!, undefined, INDI_CHILD_ORDER);

    updateSourceCitation(ds.records, indi1.raw, 0, { title: "New Title", author: "New Author" });

    expect(rebuildIndividual(ds, indi1).sources![0]).toMatchObject({ title: "New Title" });
    expect(rebuildIndividual(ds, indi3).sources![0]).toMatchObject({ title: "New Title" });
  });

  it("updates the citation-local PAGE without touching the shared record", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    const source = createSourceRecord(ds.records, { title: "Krstna knjiga" });
    attachSourceCitation(indi.raw, source.xref!, "5", INDI_CHILD_ORDER);

    updateSourceCitation(ds.records, indi.raw, 0, { title: "Krstna knjiga", page: "7" });

    const updated = rebuildIndividual(ds, indi);
    expect(updated.sources![0].page).toBe("7");
    expect(updated.sources![0].title).toBe("Krstna knjiga");
  });

  it("retargets only this citation's page image, leaving sibling pages of the same source untouched", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    const source = createSourceRecord(ds.records, { title: "Matična knjiga" });
    addObjeToSource(ds.records, source.xref!, "https://example.com/book/?pg=1");
    addObjeToSource(ds.records, source.xref!, "https://example.com/book/?pg=2");
    attachSourceCitation(indi.raw, source.xref!, "1", INDI_CHILD_ORDER);
    attachSourceCitation(indi.raw, source.xref!, "2", INDI_CHILD_ORDER);

    const before = rebuildIndividual(ds, indi);
    expect(before.sources![0].url).toBe("https://example.com/book/?pg=1");
    const objeXref = before.sources![0].objeXref;
    expect(objeXref).toBeTruthy();

    updateSourceCitation(ds.records, indi.raw, 0, {
      title: "Matična knjiga",
      url: "https://example.com/book2/?pg=1",
      objeXref,
      page: "1",
    });

    const after = rebuildIndividual(ds, indi);
    expect(after.sources![0].url).toBe("https://example.com/book2/?pg=1");
    expect(after.sources![1].url).toBe("https://example.com/book/?pg=2");
  });

  it("creates a new OBJE when a url is added to a source that had none", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    const source = createSourceRecord(ds.records, { title: "Listina" });
    attachSourceCitation(indi.raw, source.xref!, undefined, INDI_CHILD_ORDER);
    expect(ds.records.some((r) => r.tag === "OBJE")).toBe(false);

    updateSourceCitation(ds.records, indi.raw, 0, { title: "Listina", url: "https://example.com/new" });

    expect(ds.records.some((r) => r.tag === "OBJE")).toBe(true);
    expect(rebuildIndividual(ds, indi).sources![0].url).toBe("https://example.com/new");
  });

  it("edits an inline (plain-text) citation's own value, with no shared record", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    indi.raw.children.push({ level: indi.raw.level + 1, tag: "SOUR", value: "Family Bible", children: [] });

    updateSourceCitation(ds.records, indi.raw, 0, { title: "Family Bible, 2nd ed.", page: "3" });

    const updated = rebuildIndividual(ds, indi);
    expect(updated.sources![0].title).toBe("Family Bible, 2nd ed.");
    expect(updated.sources![0].page).toBe("3");
  });
});

// ─── Individual photos (OBJE) ─────────────────────────────────────────────────

describe("individual media", () => {
  it("attaches an inline OBJE/FILE block (with title)", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    const node = attachInlineMedia(indi.raw, "photos/janez.jpg", "Janez 1870");
    expect(node.tag).toBe("OBJE");
    expect(node.children.find((c) => c.tag === "FILE")?.value).toBe("photos/janez.jpg");
    expect(node.children.find((c) => c.tag === "TITL")?.value).toBe("Janez 1870");
    expect(indi.raw.children).toContain(node);
    // No top-level OBJE record is created for inline mode.
    expect(ds.records.some((r) => r.tag === "OBJE")).toBe(false);
  });

  it("attaches a pointer to a shared top-level OBJE record", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    const rec = createMediaRecord(ds.records, "photos/janez.jpg", "Janez 1870");
    attachMediaPointer(indi.raw, rec.xref!);
    const ptr = indi.raw.children.find((c) => c.tag === "OBJE");
    expect(ptr?.value).toBe(rec.xref);
    expect(ds.records.filter((r) => r.tag === "OBJE")).toHaveLength(1);
  });

  it("finds an existing shared record by file, case-insensitively", () => {
    const ds = buildFromText(BASE);
    createMediaRecord(ds.records, "Photos/Janez.JPG");
    expect(findSharedMediaByFile(ds.records, "photos/janez.jpg")?.tag).toBe("OBJE");
    expect(findSharedMediaByFile(ds.records, "other.jpg")).toBeUndefined();
  });

  it("removes an inline photo by index", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    attachInlineMedia(indi.raw, "a.jpg");
    attachInlineMedia(indi.raw, "b.jpg");
    removeMediaAt(ds, indi.raw, { objeIndex: 0 });
    const remaining = indi.raw.children.filter((c) => c.tag === "OBJE");
    expect(remaining).toHaveLength(1);
    expect(remaining[0].children.find((c) => c.tag === "FILE")?.value).toBe("b.jpg");
  });

  it("prunes a shared OBJE record when its last reference is removed", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    const rec = createMediaRecord(ds.records, "a.jpg");
    attachMediaPointer(indi.raw, rec.xref!);
    removeMediaAt(ds, indi.raw, { objeIndex: 0 });
    expect(ds.records.some((r) => r.tag === "OBJE")).toBe(false);
  });

  it("keeps a shared OBJE still referenced by another person", () => {
    const ds = buildFromText(FAM_BASE);
    const i1 = ds.individuals.get("@I1@")!;
    const i2 = ds.individuals.get("@I2@")!;
    const rec = createMediaRecord(ds.records, "family.jpg");
    attachMediaPointer(i1.raw, rec.xref!);
    attachMediaPointer(i2.raw, rec.xref!);
    removeMediaAt(ds, i1.raw, { objeIndex: 0 });
    expect(ds.records.some((r) => r.tag === "OBJE" && r.xref === rec.xref)).toBe(true);
  });

  it("does not prune a shared OBJE also cited as a source image", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    const rec = createMediaRecord(ds.records, "scan.jpg");
    attachMediaPointer(indi.raw, rec.xref!);
    // A SOUR record also points at the same media object.
    ds.records.push({
      level: 0,
      xref: "@S1@",
      tag: "SOUR",
      children: [{ level: 1, tag: "OBJE", value: rec.xref, children: [] }],
    });
    removeMediaAt(ds, indi.raw, { objeIndex: 0 });
    expect(ds.records.some((r) => r.tag === "OBJE" && r.xref === rec.xref)).toBe(true);
  });

  it("reorders OBJE children without disturbing other fields", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    attachInlineMedia(indi.raw, "a.jpg");
    attachInlineMedia(indi.raw, "b.jpg");
    attachInlineMedia(indi.raw, "c.jpg");
    reorderMedia(indi.raw, 2, 0);
    const files = indi.raw.children
      .filter((c) => c.tag === "OBJE")
      .map((o) => o.children.find((c) => c.tag === "FILE")?.value);
    expect(files).toEqual(["c.jpg", "a.jpg", "b.jpg"]);
    // NAME/SEX/FAMC are still present and ahead of the photos.
    expect(indi.raw.children[0].tag).toBe("NAME");
  });

  it("pruneUnreferencedMedia is a no-op while a reference remains", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    const rec = createMediaRecord(ds.records, "a.jpg");
    attachMediaPointer(indi.raw, rec.xref!);
    pruneUnreferencedMedia(ds, rec.xref!);
    expect(ds.records.some((r) => r.tag === "OBJE" && r.xref === rec.xref)).toBe(true);
  });

  it("sets and clears photo metadata (title/date/place/description)", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    const obje = attachInlineMedia(indi.raw, "a.jpg");
    setMediaInfo(obje, { title: "Wedding", date: "1900", place: "Ljubljana", description: "On the steps" });
    const child = (tag: string) => obje.children.find((c) => c.tag === tag)?.value;
    expect(child("TITL")).toBe("Wedding");
    expect(child("DATE")).toBe("1900");
    expect(child("PLAC")).toBe("Ljubljana");
    expect(child("_DSCR")).toBe("On the steps");
    expect(obje.children.find((c) => c.tag === "FILE")?.value).toBe("a.jpg");

    setMediaInfo(obje, { title: "", description: "" });
    expect(child("TITL")).toBeUndefined();
    expect(child("_DSCR")).toBeUndefined();
    expect(child("DATE")).toBe("1900"); // omitted fields untouched
  });

  it("normalizes a FILE-level TITL up to the OBJE and drops a NOTE used as description", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    const obje = attachInlineMedia(indi.raw, "a.jpg");
    const fileNode = obje.children.find((c) => c.tag === "FILE")!;
    fileNode.children.push({ level: fileNode.level + 1, tag: "TITL", value: "stale", children: [] });
    obje.children.push({ level: obje.level + 1, tag: "NOTE", value: "old desc", children: [] });

    setMediaInfo(obje, { title: "New title", description: "New desc" });
    expect(fileNode.children.some((c) => c.tag === "TITL")).toBe(false);
    expect(obje.children.find((c) => c.tag === "TITL")?.value).toBe("New title");
    expect(obje.children.some((c) => c.tag === "NOTE")).toBe(false);
    expect(obje.children.find((c) => c.tag === "_DSCR")?.value).toBe("New desc");
  });
});

// ─── Family media (OBJE) ──────────────────────────────────────────────────────

describe("family media", () => {
  it("attaches an inline OBJE to a FAM record", () => {
    const ds = buildFromText(FAM_BASE);
    const fam = ds.families.get("@F1@")!;
    const node = attachInlineMedia(fam.raw, "wedding.jpg", "Wedding");
    expect(fam.raw.children).toContain(node);
    expect(node.children.find((c) => c.tag === "FILE")?.value).toBe("wedding.jpg");
  });

  it("attaches a shared pointer to a FAM record and prunes on removal", () => {
    const ds = buildFromText(FAM_BASE);
    const fam = ds.families.get("@F1@")!;
    const rec = createMediaRecord(ds.records, "wedding.jpg");
    attachMediaPointer(fam.raw, rec.xref!);
    expect(fam.raw.children.find((c) => c.tag === "OBJE")?.value).toBe(rec.xref);
    removeMediaAt(ds, fam.raw, { objeIndex: 0 });
    expect(fam.raw.children.some((c) => c.tag === "OBJE")).toBe(false);
    expect(ds.records.some((r) => r.tag === "OBJE")).toBe(false);
  });

  it("removes an event-level OBJE by address, leaving the event in place", () => {
    const ds = buildFromText(FAM_BASE);
    const fam = ds.families.get("@F1@")!;
    const marr: GedNode = { level: 1, tag: "MARR", children: [] };
    fam.raw.children.push(marr);
    const rec = createMediaRecord(ds.records, "wedding.jpg");
    marr.children.push({ level: 2, tag: "OBJE", value: rec.xref, children: [] });

    removeMediaAt(ds, fam.raw, { eventTag: "MARR", eventIndex: 0, objeIndex: 0 });
    expect(fam.raw.children).toContain(marr); // event survives
    expect(marr.children.some((c) => c.tag === "OBJE")).toBe(false);
    expect(ds.records.some((r) => r.tag === "OBJE")).toBe(false); // shared record pruned
  });
});

// ─── setCropRegion ────────────────────────────────────────────────────────────

describe("setCropRegion", () => {
  it("writes an integer CROP block on the link node and clears it with null", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    const link = attachInlineMedia(indi.raw, "group.jpg");

    setCropRegion(link, { top: 10.6, left: 0, width: 120.2, height: 140 });
    const crop = link.children.find((c) => c.tag === "CROP")!;
    const v = (tag: string) => crop.children.find((c) => c.tag === tag)?.value;
    expect(v("TOP")).toBe("11");
    expect(v("LEFT")).toBe("0");
    expect(v("WIDTH")).toBe("120");
    expect(v("HEIGHT")).toBe("140");

    // Replacing overwrites rather than duplicating.
    setCropRegion(link, { top: 1, left: 2, width: 3, height: 4 });
    expect(link.children.filter((c) => c.tag === "CROP")).toHaveLength(1);

    setCropRegion(link, null);
    expect(link.children.some((c) => c.tag === "CROP")).toBe(false);
  });

  it("rejects a degenerate region", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    const link = attachInlineMedia(indi.raw, "group.jpg");
    setCropRegion(link, { top: 0, left: 0, width: 0, height: 10 });
    expect(link.children.some((c) => c.tag === "CROP")).toBe(false);
  });
});

// ─── nextXref allocation cache ────────────────────────────────────────────────

describe("nextXref", () => {
  it("allocates sequential unused xrefs per prefix", () => {
    const ds = buildFromText(FAM_BASE); // @I1@..@I3@, @F1@
    expect(nextXref(ds.records, "I")).toBe("@I4@");
    expect(nextXref(ds.records, "F")).toBe("@F2@");
    expect(nextXref(ds.records, "S")).toBe("@S1@");
  });

  it("consecutive allocations never repeat, even before the record is inserted", () => {
    const ds = buildFromText(FAM_BASE);
    const a = nextXref(ds.records, "I");
    const b = nextXref(ds.records, "I");
    expect(a).not.toBe(b);
    expect(b).toBe("@I5@");
  });

  it("stays ahead of records inserted with a bypassing allocator (merge, undo)", () => {
    const ds = buildFromText(FAM_BASE);
    expect(nextXref(ds.records, "I")).toBe("@I4@"); // warms the cache
    // Merge's gap-filling allocator / undo restoring a delete insert directly.
    insertRecord(ds.records, { level: 0, xref: "@I40@", tag: "INDI", children: [] });
    expect(nextXref(ds.records, "I")).toBe("@I41@");
  });

  it("removals leave gaps rather than reusing freed numbers", () => {
    const ds = buildFromText(FAM_BASE);
    expect(nextXref(ds.records, "I")).toBe("@I4@");
    const ri = ds.records.findIndex((r) => r.xref === "@I3@");
    ds.records.splice(ri, 1);
    expect(nextXref(ds.records, "I")).toBe("@I5@"); // @I3@ not reused — safe overestimate
  });
});

// ─── pruneUnreferencedSource OBJE cascade ─────────────────────────────────────

describe("pruneUnreferencedSource cascade", () => {
  it("keeps a source page image that a person still references directly", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    // A source with a page image, plus the same OBJE attached to the person.
    const source = createSourceRecord(ds.records, { title: "Book", url: "http://x" });
    const objeXref = source.children.find((c) => c.tag === "OBJE")!.value!;
    attachMediaPointer(indi.raw, objeXref);
    // Nothing cites the source → the SOUR record goes, but the shared photo stays.
    pruneUnreferencedSource(ds, source.xref!);
    expect(ds.records.some((r) => r.tag === "SOUR" && r.xref === source.xref)).toBe(false);
    expect(ds.records.some((r) => r.tag === "OBJE" && r.xref === objeXref)).toBe(true);
  });

  it("prunes a page image nothing else references", () => {
    const ds = buildFromText(BASE);
    const source = createSourceRecord(ds.records, { title: "Book", url: "http://x" });
    const objeXref = source.children.find((c) => c.tag === "OBJE")!.value!;
    pruneUnreferencedSource(ds, source.xref!);
    expect(ds.records.some((r) => r.tag === "SOUR" && r.xref === source.xref)).toBe(false);
    expect(ds.records.some((r) => r.tag === "OBJE" && r.xref === objeXref)).toBe(false);
  });

  it("is a no-op while a citation remains", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    const source = createSourceRecord(ds.records, { title: "Book", url: "http://x" });
    attachSourceCitation(indi.raw, source.xref!, undefined, INDI_CHILD_ORDER);
    pruneUnreferencedSource(ds, source.xref!);
    expect(ds.records.some((r) => r.tag === "SOUR" && r.xref === source.xref)).toBe(true);
  });
});

// ─── connecting an existing person as a relative ────────────────────────────

describe("connectExistingParent", () => {
  const TEXT =
    "0 @I1@ INDI\n1 SEX M\n" +
    "0 @P1@ INDI\n1 SEX M\n" +
    "0 @P2@ INDI\n1 SEX F\n";
  /** A child who already has a parent family holding only a mother. */
  const WITH_FAM = TEXT + "0 @F1@ FAM\n1 WIFE @P2@\n1 CHIL @I1@\n";

  it("fills the empty HUSB slot of an existing parent family", () => {
    const ds = buildFromText(WITH_FAM);
    connectExistingParent(ds, ds.individuals.get("@I1@")!, "@P1@", ds.families.get("@F1@")!, "father");

    const fam = rebuildFamily(ds, ds.families.get("@F1@")!);
    expect(fam.husband).toBe("@P1@");
    expect(fam.wife).toBe("@P2@");
    expect(rebuildIndividual(ds, ds.individuals.get("@P1@")!).spouseOf).toContain("@F1@");
  });

  it("uses WIFE for a mother", () => {
    const ds = buildFromText(TEXT + "0 @F1@ FAM\n1 HUSB @P1@\n1 CHIL @I1@\n");
    connectExistingParent(ds, ds.individuals.get("@I1@")!, "@P2@", ds.families.get("@F1@")!, "mother");

    expect(rebuildFamily(ds, ds.families.get("@F1@")!).wife).toBe("@P2@");
  });

  it("creates a parent family when the child has none, linking both sides", () => {
    const ds = buildFromText(TEXT);
    const person = ds.individuals.get("@I1@")!;
    connectExistingParent(ds, person, "@P1@", undefined, "father");

    const child = rebuildIndividual(ds, person);
    expect(child.childOf).toHaveLength(1);
    const fam = rebuildFamily(ds, ds.families.get(child.childOf[0])!);
    expect(fam.husband).toBe("@P1@");
    expect(fam.children).toEqual(["@I1@"]);
    expect(rebuildIndividual(ds, ds.individuals.get("@P1@")!).spouseOf).toContain(fam.id);
  });

  it("does nothing when the parent id does not resolve", () => {
    const ds = buildFromText(TEXT);
    const before = serializeGedcom(ds.records, { eol: ds.eol, finalNewline: ds.finalNewline });
    connectExistingParent(ds, ds.individuals.get("@I1@")!, "@NOPE@", undefined, "father");

    expect(serializeGedcom(ds.records, { eol: ds.eol, finalNewline: ds.finalNewline })).toBe(before);
  });

  it("does not duplicate a FAMS link the parent already carries", () => {
    const ds = buildFromText(TEXT + "0 @F1@ FAM\n1 CHIL @I1@\n");
    const fam = ds.families.get("@F1@")!;
    connectExistingParent(ds, ds.individuals.get("@I1@")!, "@P1@", fam, "father");
    connectExistingParent(ds, ds.individuals.get("@I1@")!, "@P1@", fam, "father");

    const fams = ds.individuals.get("@P1@")!.raw.children.filter((c) => c.tag === "FAMS");
    expect(fams).toHaveLength(1);
  });
});

describe("connectExistingPartner", () => {
  const TEXT =
    "0 @I1@ INDI\n1 SEX M\n" +
    "0 @W1@ INDI\n1 SEX F\n" +
    "0 @I2@ INDI\n1 SEX F\n";

  it("fills the empty slot of an existing spouse family", () => {
    const ds = buildFromText(TEXT + "0 @F1@ FAM\n1 HUSB @I1@\n");
    connectExistingPartner(ds, ds.individuals.get("@I1@")!, "@W1@", ds.families.get("@F1@")!);

    const fam = rebuildFamily(ds, ds.families.get("@F1@")!);
    expect(fam.husband).toBe("@I1@");
    expect(fam.wife).toBe("@W1@");
  });

  it("puts the partner opposite the person, whichever slot the person holds", () => {
    const ds = buildFromText(TEXT + "0 @F1@ FAM\n1 WIFE @I2@\n");
    connectExistingPartner(ds, ds.individuals.get("@I2@")!, "@I1@", ds.families.get("@F1@")!);

    const fam = rebuildFamily(ds, ds.families.get("@F1@")!);
    expect(fam.wife).toBe("@I2@");
    expect(fam.husband).toBe("@I1@");
  });

  it("creates a family, seating a male person as HUSB", () => {
    const ds = buildFromText(TEXT);
    const person = ds.individuals.get("@I1@")!;
    connectExistingPartner(ds, person, "@W1@", undefined);

    const spouseOf = rebuildIndividual(ds, person).spouseOf;
    expect(spouseOf).toHaveLength(1);
    const fam = rebuildFamily(ds, ds.families.get(spouseOf[0])!);
    expect(fam.husband).toBe("@I1@");
    expect(fam.wife).toBe("@W1@");
  });

  it("creates a family, seating a female person as WIFE", () => {
    const ds = buildFromText(TEXT);
    const person = ds.individuals.get("@I2@")!;
    connectExistingPartner(ds, person, "@I1@", undefined);

    const fam = rebuildFamily(ds, ds.families.get(rebuildIndividual(ds, person).spouseOf[0])!);
    expect(fam.wife).toBe("@I2@");
    expect(fam.husband).toBe("@I1@");
  });

  it("does nothing when the partner id does not resolve", () => {
    const ds = buildFromText(TEXT);
    const before = serializeGedcom(ds.records, { eol: ds.eol, finalNewline: ds.finalNewline });
    connectExistingPartner(ds, ds.individuals.get("@I1@")!, "@NOPE@", undefined);

    expect(serializeGedcom(ds.records, { eol: ds.eol, finalNewline: ds.finalNewline })).toBe(before);
  });
});

describe("connectExistingChild (family creation)", () => {
  const TEXT =
    "0 @I1@ INDI\n1 SEX M\n" +
    "0 @M1@ INDI\n1 SEX F\n" +
    "0 @C1@ INDI\n1 BIRT\n2 DATE 1900\n";

  it("creates a spouse family for the person when none is given", () => {
    const ds = buildFromText(TEXT);
    const person = ds.individuals.get("@I1@")!;
    connectExistingChild(ds, person, "@C1@", undefined);

    const spouseOf = rebuildIndividual(ds, person).spouseOf;
    expect(spouseOf).toHaveLength(1);
    const fam = rebuildFamily(ds, ds.families.get(spouseOf[0])!);
    expect(fam.husband).toBe("@I1@");
    expect(fam.children).toEqual(["@C1@"]);
    expect(rebuildIndividual(ds, ds.individuals.get("@C1@")!).childOf).toContain(fam.id);
  });

  it("seats a female person as WIFE of the family it creates", () => {
    const ds = buildFromText(TEXT);
    const person = ds.individuals.get("@M1@")!;
    connectExistingChild(ds, person, "@C1@", undefined);

    const fam = rebuildFamily(ds, ds.families.get(rebuildIndividual(ds, person).spouseOf[0])!);
    expect(fam.wife).toBe("@M1@");
  });

  it("does not add a child the family already lists", () => {
    const ds = buildFromText(TEXT + "0 @F1@ FAM\n1 HUSB @I1@\n1 CHIL @C1@\n");
    const fam = ds.families.get("@F1@")!;
    connectExistingChild(ds, ds.individuals.get("@I1@")!, "@C1@", fam);

    expect(rebuildFamily(ds, fam).children).toEqual(["@C1@"]);
  });

  it("does nothing when the child id does not resolve", () => {
    const ds = buildFromText(TEXT);
    const before = serializeGedcom(ds.records, { eol: ds.eol, finalNewline: ds.finalNewline });
    connectExistingChild(ds, ds.individuals.get("@I1@")!, "@NOPE@", undefined);

    expect(serializeGedcom(ds.records, { eol: ds.eol, finalNewline: ds.finalNewline })).toBe(before);
  });
});
