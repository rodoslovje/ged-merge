import { describe, expect, it } from "vitest";
import { parseGedcom } from "./parser";
import { buildDataset } from "./builder";
import { serializeGedcom } from "./serialize";
import {
  addAdditionalName,
  rebuildFamily,
  rebuildIndividual,
  removeAdditionalName,
  setAdditionalName,
  setEventField,
  setFamilyEventField,
  setName,
  setNickname,
  setSex,
} from "./edit";

function buildFromText(text: string) {
  const buf = new TextEncoder().encode(text);
  const parsed = parseGedcom(buf.buffer);
  return buildDataset(parsed);
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

describe("setFamilyEventField", () => {
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
    "0 @F1@ FAM",
    "1 HUSB @I1@",
    "1 WIFE @I2@",
    "0 TRLR",
    "",
  ].join("\n");

  it("creates a new MARR event with date and place, ordered after HUSB/WIFE", () => {
    const ds = buildFromText(FAM_BASE);
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
    const ds = buildFromText(FAM_BASE);
    const fam = ds.families.get("@F1@")!;
    setFamilyEventField(fam, "MARR", { date: "1880" });
    setFamilyEventField(fam, "MARR", { date: "" });

    expect(serializeGedcom(ds.records)).toBe(FAM_BASE);
  });
});

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
