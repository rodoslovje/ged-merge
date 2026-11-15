import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import type { GedNode } from "../gedcom/types";
import { setPrivateFlag } from "../gedcom/private";
import { decisionKey, type CandidateDecision } from "../review/types";
import { convertVersion } from "../save/outputFile";
import { validateConformance } from "../tools/conformance/conformance";
import { mergeDecisions } from "./merge";

/** Lines the merge builds sit at their true depth in memory too, not only in
 *  the text the serializer writes: privacy and the 5.5.1 → 7.0 conversion read
 *  `level`, and a merged line must answer them as its parsed twin would. */

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}
const tr = (key: string) => key;
const NO_MATCHES = { individuals: [], families: [] };
const head = (vers: string) => `0 HEAD\n1 SOUR TEST\n1 GEDC\n2 VERS ${vers}\n${vers === "7.0" ? "" : "2 FORM LINEAGE-LINKED\n1 CHAR UTF-8\n"}`;
const wrap = (vers: string, body: string) => `${head(vers)}${body}0 TRLR\n`;

function confirmed(fields: Record<string, "main" | "incoming" | "both"> = {}): Map<string, CandidateDecision> {
  return new Map([[decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields }]]);
}

function everyLevelTrue(records: GedNode[]): boolean {
  const ok = (n: GedNode, depth: number): boolean => n.level === depth && n.children.every((c) => ok(c, depth + 1));
  return records.every((r) => ok(r, 0));
}

describe("merge-created lines carry their true level", () => {
  for (const vers of ["5.5.1", "7.0"] as const) {
    it(`a merged event marked private gets RESN, as a parsed one does (${vers})`, () => {
      const main = dataset(wrap(vers, "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1880\n"));
      const compare = dataset(wrap(vers, "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1880\n1 BURI\n2 DATE 1950\n2 PLAC Kranj\n"));
      const { records } = mergeDecisions(main, compare, confirmed(), NO_MATCHES, tr);
      expect(everyLevelTrue(records)).toBe(true);

      const person = records.find((r) => r.xref === "@I1@")!;
      const buri = person.children.find((c) => c.tag === "BURI")!;
      setPrivateFlag(buri, true, "RESN", vers);
      const out = serializeGedcom(records);
      expect(out).toContain(`1 BURI\n2 DATE 1950\n2 PLAC Kranj\n2 RESN ${vers === "7.0" ? "PRIVACY" : "privacy"}\n`);
      expect(out).not.toContain("_PRIV");
      expect(validateConformance(dataset(out))).toEqual([]);
    });
  }

  it("a merged aka NAME, _UID and text SOUR convert to 7.0 like parsed ones", () => {
    const main = dataset(wrap("5.5.1", "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1880\n"));
    const compare = dataset(wrap("5.5.1",
      "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 NAME Ivan /Novak/\n2 TYPE aka\n1 SEX M\n" +
      "1 _UID 0123456789ABCDEF0123456789ABCDEF\n" +
      "1 BIRT\n2 DATE 1880\n1 DEAT\n2 DATE 1950\n2 SOUR Told by his son\n"));
    const { records } = mergeDecisions(main, compare, confirmed({ additionalNames: "both" }), NO_MATCHES, tr);
    expect(everyLevelTrue(records)).toBe(true);
    const merged = serializeGedcom(records);
    expect(merged).toContain("1 NAME Ivan /Novak/\n2 TYPE aka\n");
    expect(merged).toContain("1 _UID 0123456789ABCDEF0123456789ABCDEF\n");
    expect(merged).toContain("2 SOUR Told by his son\n");
    expect(validateConformance(dataset(merged))).toEqual([]);

    convertVersion(records, "5.5.1", "7.0");
    const out = serializeGedcom(records);
    expect(out).toContain("1 NAME Ivan /Novak/\n2 TYPE AKA\n");
    expect(out).not.toContain("_UID");
    expect(out).toMatch(/\n1 UID /);
    expect(out).not.toContain("2 SOUR Told by his son");
    expect(validateConformance(dataset(out))).toEqual([]);
  });
});
