import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { buildStatsFacts } from "./facts";
import { applyCountry, DEFAULT_SCOPE, scopeFacts } from "./scope";
import { surnameDecades } from "./surnames";

function scoped(text: string) {
  const facts = buildStatsFacts(buildDataset(parseGedcom(new TextEncoder().encode(text).buffer)), "si");
  return applyCountry(facts, scopeFacts(facts, DEFAULT_SCOPE, null, undefined), DEFAULT_SCOPE);
}

const person = (id: string, name: string, year: string | null) =>
  [`0 @${id}@ INDI`, `1 NAME ${name}`, ...(year ? ["1 BIRT", `2 DATE ${year}`] : [])].join("\n");

/** Three Novaks (one spelled in capitals, one undated), two Kranjcs, one
 *  without a surname. */
const FILE = [
  "0 HEAD\n1 CHAR UTF-8",
  person("I1", "Janez /Novak/", "1801"),
  person("I2", "Marija /NOVAK/", "1809"),
  person("I3", "Jože /Novak/", "1835"),
  person("I4", "Ana /Novak/", null),
  person("I5", "Franc /Kranjc/", "1850"),
  person("I6", "Neža /Kranjc/", "1852"),
  person("I7", "Miha //", "1850"),
  "0 TRLR",
].join("\n");

describe("surnameDecades", () => {
  it("gives the commonest surnames a row of decades, accent- and case-blind", () => {
    const d = surnameDecades(scoped(FILE));
    expect(d.rows.map((r) => [r.label, r.count])).toEqual([["Novak", 3], ["Kranjc", 2]]);
    expect([...d.rows[0].byDecade]).toEqual([[1800, ["@I1@", "@I2@"]], [1830, ["@I3@"]]]);
    expect([...d.rows[1].byDecade]).toEqual([[1850, ["@I5@", "@I6@"]]]);
    expect([d.first, d.last, d.max]).toEqual([1800, 1850, 2]);
  });

  it("keeps only the top rows", () => {
    expect(surnameDecades(scoped(FILE), 1).rows.map((r) => r.label)).toEqual(["Novak"]);
  });
});
