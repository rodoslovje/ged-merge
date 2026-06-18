import { describe, expect, it } from "vitest";
import { parseGedcom } from "./parser";
import { buildDataset } from "./builder";
import { serializeGedcom } from "./serialize";
import type { Dataset, GedNode } from "./types";
import {
  addAdditionalName,
  addChild,
  addEventNode,
  addFamilyEventNode,
  addParent,
  addPartner,
  detachChildFromFamily,
  detachSpouseRole,
  insertRecord,
  rebuildFamily,
  rebuildIndividual,
  removeAdditionalName,
  removeEventAtIndex,
  removeFamilyEvent,
  removeFamily,
  removeIndividual,
  setAdditionalName,
  setEventField,
  setFamilyEventField,
  setFamilyNotes,
  setIndividualLinks,
  setName,
  setNickname,
  setNotes,
  setSex,
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
});

// ─── setNotes / setFamilyNotes ────────────────────────────────────────────────

describe("setNotes", () => {
  it("adds notes to an individual", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    setNotes(indi, ["First note", "Second note"]);
    const updated = rebuildIndividual(ds, indi);
    expect(updated.notes).toEqual(["First note", "Second note"]);
  });

  it("replaces existing notes", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    setNotes(indi, ["Old note"]);
    setNotes(indi, ["New note"]);
    const updated = rebuildIndividual(ds, indi);
    expect(updated.notes).toEqual(["New note"]);
  });

  it("removes all notes when given an empty array", () => {
    const ds = buildFromText(BASE);
    const indi = ds.individuals.get("@I1@")!;
    setNotes(indi, ["A note"]);
    setNotes(indi, []);
    const updated = rebuildIndividual(ds, indi);
    expect(updated.notes ?? []).toHaveLength(0);
    expect(serializeGedcom(ds.records)).not.toContain("NOTE");
  });
});

describe("setFamilyNotes", () => {
  it("adds notes to a family", () => {
    const ds = buildFromText(FAM_BASE);
    const fam = ds.families.get("@F1@")!;
    setFamilyNotes(fam, ["Family note"]);
    const updated = rebuildFamily(ds, fam);
    expect(updated.notes).toEqual(["Family note"]);
  });

  it("clears family notes", () => {
    const ds = buildFromText(FAM_BASE);
    const fam = ds.families.get("@F1@")!;
    setFamilyNotes(fam, ["Note"]);
    setFamilyNotes(fam, []);
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
