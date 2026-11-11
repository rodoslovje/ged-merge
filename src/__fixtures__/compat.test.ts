/**
 * Byte-level compatibility fixtures (see `scripts/compat-fixtures.ts`): the
 * damage real exporters leave in a file — a wrong CHAR label, a stray
 * Windows-1250 byte in UTF-8, a character split across CONC, a raw line break
 * inside a value — reproduced with pseudonyms. Each must read with every
 * letter intact and no line left unparsed, round-trip losslessly, and save as
 * 5.5.1 and 7.0 into a file that reads back the same and saves again unchanged.
 */

/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseGedcom } from "../gedcom/parser";
import { buildDataset } from "../gedcom/builder";
import { cloneNode } from "../gedcom/node";
import { serializeGedcom } from "../gedcom/serialize";
import type { GedNode, ParseResult } from "../gedcom/types";
import { outputOptions, prepareDownload, type OutputVersion } from "../save/outputFile";
import { validateConformance } from "../tools/conformance/conformance";

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "compat");
const read = (file: string): ParseResult => {
  const buf = readFileSync(resolve(DIR, file));
  return parseGedcom(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
};
const fromText = (text: string) => parseGedcom(new TextEncoder().encode(text).buffer as ArrayBuffer);

/** Every line value in the file, depth-first. */
function values(records: GedNode[]): string[] {
  const out: string[] = [];
  const walk = (n: GedNode) => {
    if (n.value !== undefined) out.push(n.value);
    n.children.forEach(walk);
  };
  records.forEach(walk);
  return out;
}
const at = (parsed: ParseResult, xref: string, ...path: string[]): GedNode | undefined => {
  let node = parsed.records.find((r) => r.xref === xref);
  for (const tag of path) node = node?.children.find((c) => c.tag === tag);
  return node;
};
/** Records as plain tag/value/children trees, for comparing two reads. */
const shape = (n: GedNode): unknown => ({ tag: n.tag, xref: n.xref, value: n.value, children: n.children.map(shape) });

/** Save `parsed` as `version` the way the app does, as text. */
function save(parsed: ParseResult, version: OutputVersion): string {
  const ds = buildDataset(parsed);
  const records = parsed.records.map(cloneNode);
  prepareDownload(records, ds, version, new Date("2026-11-06T12:00:00Z"), { name: "Tester" });
  return serializeGedcom(records, outputOptions(ds, version));
}

const FILES = [
  "myheritage-raw-breaks-utf8.ged",
  "brotherskeeper-broken-name-w1250.ged",
  "brotherskeeper-ansel-label-w1250.ged",
  "myheritage-stray-cp1250-utf8.ged",
];

describe.each(FILES)("%s", (file) => {
  const parsed = read(file);

  it("reads every letter and every line", () => {
    expect(parsed.warnings.filter((w) => w.kind === "syntax")).toEqual([]);
    expect(values(parsed.records).filter((v) => v.includes("�") || /[̀-ͯ]/.test(v))).toEqual([]);
  });

  it("round-trips losslessly", () => {
    const again = fromText(serializeGedcom(parsed.records, { eol: parsed.eol, finalNewline: parsed.finalNewline }));
    expect(again.records.map(shape)).toEqual(parsed.records.map(shape));
  });

  it.each(["5.5.1", "7.0"] as const)("saves as %s into a file that reads back and saves again unchanged", (version) => {
    const text = save(parsed, version);
    const back = fromText(text);
    expect(back.warnings.filter((w) => w.kind === "syntax" || w.kind === "encoding")).toEqual([]);
    expect(back.records.filter((r) => r.tag === "INDI").length).toBe(parsed.records.filter((r) => r.tag === "INDI").length);
    expect(save(back, version)).toBe(text);
    // Nothing the save could have settled is left for the health check.
    expect(validateConformance(buildDataset(back)).filter((i) => i.severity === "error")).toEqual([]);
  });
});

describe("what each fixture is about", () => {
  it("MyHeritage: a value's raw line breaks stay in the value", () => {
    const p = read("myheritage-raw-breaks-utf8.ged");
    expect(at(p, "@I1@", "DSCR")?.value).toBe(
      "Izvor priimka Golobič: domače ime po kmetiji.&#13;\n&#13;\nDruga vrstica brez oznake.",
    );
    expect(at(p, "@I1@", "BIRT", "DATE")?.value).toBe("12 MAR 1850");
  });

  it("MyHeritage: a character split across CONC is put back together, a U+2028 kept in the text", () => {
    expect(at(read("myheritage-raw-breaks-utf8.ged"), "@I2@", "NOTE")?.value).toBe(
      "Hči kmeta, rojena na Golobovi kmetiji, poročena v Mašovi hiši. Prepis iz spletne strani:\u2028stran 4.",
    );
  });

  it("MyHeritage: a 7.0 save keeps every spelling of a married name", () => {
    const back = fromText(save(read("myheritage-raw-breaks-utf8.ged"), "7.0"));
    const married = back.records.find((r) => r.xref === "@I2@")!.children
      .find((c) => c.tag === "NAME" && c.children.some((t) => t.tag === "TYPE" && t.value === "MARRIED"));
    expect(married?.value).toMatch(/Golobič.*Golobek.*Golobar/);
  });

  it("Brother's Keeper: a NAME broken over three lines stays one name", () => {
    const p = read("brotherskeeper-broken-name-w1250.ged");
    expect(p.charset).toBe("WINDOWS-1250");
    expect(at(p, "@I1@", "NAME")?.value).toBe("Matija Žnidarič  , \n6th Bt, \n8th of /Žnidarič/");
    expect(at(p, "@I1@", "SEX")?.value).toBe("M");
    expect(at(p, "@I2@", "NAME")?.value).toBe("Neža /Šrajek/");
  });

  it("Brother's Keeper: CHAR ANSEL over Windows-1250 bytes reads as Windows-1250", () => {
    const p = read("brotherskeeper-ansel-label-w1250.ged");
    expect(p.charset).toBe("WINDOWS-1250");
    expect(at(p, "@I1@", "NAME")?.value).toBe("Jožef /Ambrožič/");
    expect(at(p, "@I1@", "BIRT", "PLAC")?.value).toBe("Šentvid, Ljubljana");
    expect(at(p, "@I1@", "OCCU")?.value).toBe("učitelj");
    expect(at(p, "@I2@", "NAME")?.value).toBe("Uršula /Čebuljnik/");
  });

  it("MyHeritage: stray Windows-1250 bytes in UTF-8 read as the letters they are", () => {
    const p = read("myheritage-stray-cp1250-utf8.ged");
    expect(p.charset).toBe("UTF-8");
    expect(at(p, "@I1@", "NAME", "_MARNM")?.value).toBe("Žnidarnik");
    expect(at(p, "@I1@", "NOTE")?.value).toBe("Izvor: Popis 1900 – župnija Šentjošt, stran 12.");
    expect(at(p, "@I1@", "OCCU")?.value).toBe("šivilja in kuharica pri družini Krečar");
    expect(at(p, "@I2@", "OCCU")?.value).toBe("čevljar");
  });
});
