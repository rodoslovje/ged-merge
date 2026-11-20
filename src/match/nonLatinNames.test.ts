import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { findDuplicates } from "../tools/duplicates";
import { matchDatasets } from "./engine";
import { blockingCode, soundex } from "./text";

const dataset = (text: string) => buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;
const person = (id: string, name: string, born = "1 JAN 1900") => `0 ${id} INDI\n1 NAME ${name}\n1 SEX M\n1 BIRT\n2 DATE ${born}\n2 PLAC Kranj\n`;

describe("blockingCode", () => {
  it("is the soundex of a name soundex can code", () => {
    expect(blockingCode("Novak")).toBe(soundex("Novak"));
    expect(blockingCode("Kovačič")).toBe(soundex("Kovačič"));
  });

  it("keys a name in another script by its first letters", () => {
    expect(soundex("Петров")).toBe("");
    expect(blockingCode("Петров")).toBe("~петр");
    expect(blockingCode("Петрова")).toBe("~петр");
    expect(blockingCode("Παπαδόπουλος")).toMatch(/^~/);
    expect(blockingCode("כהן")).toMatch(/^~/);
  });

  it("gives nothing for a name with no letters", () => {
    expect(blockingCode("")).toBe("");
    expect(blockingCode("???")).toBe("");
  });
});

describe("names in a script soundex cannot code", () => {
  it.each(["Иван /Петров/", "Γιώργος /Παπαδόπουλος/", "Janez /Novak/"])("%s matches himself across two files", (name) => {
    const main = dataset(wrap(person("@I1@", name)));
    const compare = dataset(wrap(person("@P1@", name)));
    const found = matchDatasets(main, compare).individuals;
    expect(found.map((c) => `${c.mainId}|${c.compareId}`)).toEqual(["@I1@|@P1@"]);
  });

  it("is found as a duplicate within one file", () => {
    const ds = dataset(wrap(person("@I1@", "Иван /Петров/") + person("@I2@", "Иван /Петров/")));
    expect(findDuplicates(ds).map((p) => [p.aId, p.bId].sort().join("|"))).toEqual(["@I1@|@I2@"]);
  });

  it("does not pair people of different names", () => {
    const main = dataset(wrap(person("@I1@", "Иван /Петров/")));
    const compare = dataset(wrap(person("@P1@", "Сергей /Кузнецов/")));
    expect(matchDatasets(main, compare).individuals).toEqual([]);
  });
});
