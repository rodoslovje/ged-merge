import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import type { Dataset } from "../gedcom/types";
import { BUCKET_CAP, CrossBlockIndex } from "./blocking";

function dataset(people: Array<[string, string, number | undefined]>): Dataset {
  const lines = ["0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8"];
  people.forEach(([id, name, year]) => {
    lines.push(`0 @${id}@ INDI`, `1 NAME ${name}`);
    if (year !== undefined) lines.push("1 BIRT", `2 DATE ${year}`);
  });
  lines.push("0 TRLR");
  return buildDataset(parseGedcom(new TextEncoder().encode(lines.join("\n")).buffer));
}

/** Ids of the main records the incoming record `id` is compared with. */
function candidates(main: Dataset, compare: Dataset, id: string): string[] {
  const index = new CrossBlockIndex([...main.individuals.values()], main, 30);
  const out: string[] = [];
  index.forEachCandidate(compare.individuals.get(`@${id}@`)!, compare, (i) => out.push(index.records[i].id.replace(/@/g, "")));
  return out.sort();
}

describe("cross-file blocking", () => {
  it("reaches a same-initial namesake anywhere inside the era gate, and nothing past it", () => {
    const main = dataset([
      ["M1", "Janez /Novak/", 1850],
      ["M2", "Jakob /Novak/", 1878], // 28 years: two decades past the window, inside the gate
      ["M3", "Jurij /Novak/", 1885], // 35 years: past the gate
    ]);
    const compare = dataset([["C1", "Janez /Novak/", 1850]]);
    expect(candidates(main, compare, "C1")).toEqual(["M1", "M2"]);
  });

  it("reaches a different-initial name only within the decade window", () => {
    const main = dataset([
      ["M1", "Ivan /Novak/", 1872], // two decades on
      ["M2", "Ivan /Novak/", 1880], // three decades on
    ]);
    const compare = dataset([["C1", "Janez /Novak/", 1850]]);
    expect(candidates(main, compare, "C1")).toEqual(["M1"]);
  });

  it("walks a crowded decade only through an agreeing given name", () => {
    const crowd: Array<[string, string, number]> = Array.from({ length: BUCKET_CAP + 1 }, (_, i) => [
      `M${i}`,
      "Marija /Novak/",
      1850,
    ]);
    const main = dataset([
      ...crowd,
      ["A1", "Agnes /Novak/", 1851], // Neža's Latin form
      ["N1", "/Novak/", 1852], // no given name
      ["T1", "Terezija /Novak/", 1853], // a different name
    ]);
    const compare = dataset([["C1", "Neža /Novak/", 1851]]);
    expect(candidates(main, compare, "C1")).toEqual(["A1", "N1"]);
  });
});
