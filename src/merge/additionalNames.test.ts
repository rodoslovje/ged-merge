import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { decisionKey, type CandidateDecision, type FieldChoice } from "../review/types";
import { mergeDecisions } from "./merge";

const dataset = (text: string) => buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;
const tr = (key: string) => key;
const NO_MATCHES = { individuals: [], families: [] };

/** The merged person's NAME lines, in order. */
function namesAfter(mainNames: string[], incomingNames: string[], fields: Record<string, FieldChoice>): string[] {
  const person = (id: string, names: string[]) => `0 ${id} INDI\n${names.map((n) => `1 NAME ${n}\n`).join("")}1 SEX M\n`;
  const main = dataset(wrap(person("@I1@", mainNames)));
  const compare = dataset(wrap(person("@P1@", incomingNames)));
  const decisions = new Map<string, CandidateDecision>([
    [decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields }],
  ]);
  const { records } = mergeDecisions(main, compare, decisions, NO_MATCHES, tr);
  return records.find((r) => r.xref === "@I1@")!.children.filter((c) => c.tag === "NAME").map((c) => c.value!);
}

describe("merging additional names", () => {
  it("\"both\" adds the names the main does not have, and none it has", () => {
    expect(namesAfter(
      ["Janez /Novak/", "Ivan /Novak/"],
      ["Janez /Novak/", "Ivan /Novak/", "Hans /Novak/"],
      { additionalNames: "both" },
    )).toEqual(["Janez /Novak/", "Ivan /Novak/", "Hans /Novak/"]);
  });

  it("\"both\" does not repeat the main's own primary name", () => {
    expect(namesAfter(
      ["Janez /Novak/"],
      ["Johann /Novak/", "Janez /Novak/"],
      { additionalNames: "both" },
    )).toEqual(["Janez /Novak/"]);
  });

  it("\"incoming\" keeps the incoming primary name the name row kept as both", () => {
    // given = both keeps `Johann /Novak/` as a second name; replacing the
    // additional names then stripped it again, with the report still saying
    // the given name was kept.
    expect(namesAfter(
      ["Janez /Novak/", "Ivan /Novak/"],
      ["Johann /Novak/", "Hans /Novak/"],
      { given: "both", additionalNames: "incoming" },
    )).toEqual(["Janez /Novak/", "Johann /Novak/", "Hans /Novak/"]);
  });

  it("\"incoming\" replaces the main's additional names", () => {
    expect(namesAfter(
      ["Janez /Novak/", "Ivan /Novak/"],
      ["Janez /Novak/", "Hans /Novak/"],
      { additionalNames: "incoming" },
    )).toEqual(["Janez /Novak/", "Hans /Novak/"]);
  });
});
