import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { buildStatsFacts } from "./facts";
import { applyCountry, DEFAULT_SCOPE, scopeFacts, type StatsScope } from "./scope";
import { surnameMarriages, surnameNetwork } from "./surnames";

function scoped(text: string, scope: StatsScope = DEFAULT_SCOPE) {
  const facts = buildStatsFacts(buildDataset(parseGedcom(new TextEncoder().encode(text).buffer)), "si");
  return applyCountry(facts, scopeFacts(facts, scope, null, undefined), scope);
}

const person = (id: string, sex: string, name: string, fams: string[]) =>
  [`0 @${id}@ INDI`, `1 NAME ${name}`, `1 SEX ${sex}`, ...fams.map((f) => `1 FAMS @${f}@`)].join("\n");
const family = (id: string, husb: string, wife: string) => `0 @${id}@ FAM\n1 HUSB @${husb}@\n1 WIFE @${wife}@`;

/** Three Novak × Kralj marriages (one spelled with an accent), one Novak ×
 *  Plut, one Novak × Novak, and one with a wife without a surname. */
const FILE = [
  "0 HEAD\n1 CHAR UTF-8",
  person("H1", "M", "Janez /Novak/", ["F1"]),
  person("W1", "F", "Marija /Kralj/", ["F1"]),
  person("H2", "M", "Jože /Novák/", ["F2"]),
  person("W2", "F", "Ana /Kralj/", ["F2"]),
  person("H3", "M", "Peter /Kralj/", ["F3"]),
  person("W3", "F", "Neža /Novak/", ["F3"]),
  person("H4", "M", "Anton /Plut/", ["F4"]),
  person("W4", "F", "Marjeta /Novak/", ["F4"]),
  person("H5", "M", "Luka /Novak/", ["F5"]),
  person("W5", "F", "Rozalija /Novak/", ["F5"]),
  person("H6", "M", "Martin /Plut/", ["F6"]),
  person("W6", "F", "Uršula", ["F6"]),
  family("F1", "H1", "W1"),
  family("F2", "H2", "W2"),
  family("F3", "H3", "W3"),
  family("F4", "H4", "W4"),
  family("F5", "H5", "W5"),
  family("F6", "H6", "W6"),
  "0 TRLR",
].join("\n");

describe("surnameMarriages", () => {
  it("counts each couple under its pair of surnames, accent-blind, either way round", () => {
    const m = surnameMarriages(scoped(FILE));
    expect(m.couples).toBe(5);
    expect(m.pairs.map((p) => [m.nodes.get(p.a)!.label, m.nodes.get(p.b)!.label, p.ids.length])).toEqual([
      ["Kralj", "Novak", 3],
      ["Novak", "Plut", 1],
    ]);
    expect(m.pairs[0].ids.sort()).toEqual(["@F1@", "@F2@", "@F3@"]);
  });

  it("keeps a surname's marriages within itself apart", () => {
    const novak = [...surnameMarriages(scoped(FILE)).nodes.values()].find((n) => n.label === "Novak")!;
    expect(novak.ids).toHaveLength(5);
    expect(novak.within).toEqual(["@F5@"]);
    expect(novak.people).toBe(6);
  });

  it("reads a spouse outside the scope for the family's other side", () => {
    const m = surnameMarriages(scoped(FILE, { ...DEFAULT_SCOPE, sex: "M" }));
    expect(m.pairs[0].ids).toHaveLength(3);
  });
});

describe("surnameNetwork", () => {
  it("draws only pairs with enough marriages, and only surnames with a line", () => {
    const net = surnameNetwork(surnameMarriages(scoped(FILE)));
    expect(net.pairs).toHaveLength(1);
    expect(net.nodes.map((n) => n.label)).toEqual(["Novak", "Kralj"]);
  });

  it("keeps the surnames with the most marriages to others", () => {
    const net = surnameNetwork(surnameMarriages(scoped(FILE)), 1, 1);
    expect(net.nodes).toHaveLength(0);
    const two = surnameNetwork(surnameMarriages(scoped(FILE)), 2, 1);
    expect(two.nodes.map((n) => n.label)).toEqual(["Novak", "Kralj"]);
  });
});
