import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { matchDatasets } from "./engine";

const dataset = (text: string) => buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;
const pairs = (mainBody: string, incomingBody: string) =>
  matchDatasets(dataset(wrap(mainBody)), dataset(wrap(incomingBody))).individuals.map((c) => `${c.mainId}|${c.compareId}`);

/**
 * A dated record sits in its decade's buckets, an undated one in the
 * surname's; the two meet through the given-name keys alone. Those went by
 * the first letter, so a name the variant table holds as one — Janez and
 * Ivan, Neža and Agnes — never met across a missing date.
 */
describe("a dated record and an undated one, under two forms of one given name", () => {
  const dated = (id: string, given: string) => `0 ${id} INDI\n1 NAME ${given} /Peruzzi/\n1 BIRT\n2 DATE 1850\n2 PLAC Kranj\n`;
  const undated = (id: string, given: string) => `0 ${id} INDI\n1 NAME ${given} /Peruzzi/\n`;

  it.each([
    ["Janez", "Ivan"],
    ["Neža", "Agnes"],
    ["Jurij", "Georg"],
  ])("%s meets %s", (a, b) => {
    expect(pairs(dated("@I1@", a), undated("@P1@", b))).toEqual(["@I1@|@P1@"]);
    expect(pairs(undated("@I1@", a), dated("@P1@", b))).toEqual(["@I1@|@P1@"]);
  });

  it("still meets under the same initial, as before", () => {
    expect(pairs(dated("@I1@", "Janez"), undated("@P1@", "Janez"))).toEqual(["@I1@|@P1@"]);
  });

  it("does not bring together two different names", () => {
    expect(pairs(dated("@I1@", "Janez"), undated("@P1@", "Martin"))).toEqual([]);
  });
});
