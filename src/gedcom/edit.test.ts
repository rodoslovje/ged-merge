import { describe, expect, it } from "vitest";
import { parseGedcom } from "./parser";
import { buildDataset } from "./builder";
import { serializeGedcom } from "./serialize";
import { rebuildIndividual, setEventField, setName, setSex } from "./edit";

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
