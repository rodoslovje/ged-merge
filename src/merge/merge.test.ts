import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import { decisionKey, type CandidateDecision } from "../review/types";
import { mergeDecisions } from "./merge";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}
const tr = (key: string) => key;
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;

// Master lacks a birth place and has a differing given name from incoming.
const MASTER = wrap(
  "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n" +
    "0 @I2@ INDI\n1 NAME Ana /Kos/\n1 SEX F\n1 BIRT\n2 DATE 1855\n",
);
const COMPARE = wrap(
  "0 @P1@ INDI\n1 NAME Jan;ez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n2 PLAC Kranj\n",
);

function confirmed(fields: Record<string, "master" | "incoming" | "both"> = {}): Map<string, CandidateDecision> {
  const m = new Map<string, CandidateDecision>();
  m.set(decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields });
  return m;
}

describe("mergeDecisions", () => {
  const master = dataset(MASTER);
  const compare = dataset(COMPARE);

  it("fills in a field the master is missing (default = incoming)", () => {
    const { records, report } = mergeDecisions(master, compare, confirmed(), tr);
    const out = serializeGedcom(records);
    expect(out).toContain("1 BIRT\n2 DATE 1850\n2 PLAC Kranj");
    expect(report.changes.some((c) => c.to === "Kranj")).toBe(true);
  });

  it("leaves a conflicting field on master unless explicitly chosen", () => {
    const { records } = mergeDecisions(master, compare, confirmed(), tr);
    const out = serializeGedcom(records);
    expect(out).toContain("1 NAME Janez /Novak/"); // master name kept
    expect(out).not.toContain("Jan;ez");
  });

  it("takes a conflicting field when the user chose incoming", () => {
    const { records } = mergeDecisions(master, compare, confirmed({ given: "incoming" }), tr);
    const out = serializeGedcom(records);
    expect(out).toContain("1 NAME Jan;ez /Novak/");
  });

  it("changes only the merged record (minimal diff)", () => {
    const before = serializeGedcom(master.records);
    const { records } = mergeDecisions(master, compare, confirmed(), tr);
    const after = serializeGedcom(records);

    const diff = lineDiff(before, after);
    // Only the added PLAC line should appear; nothing removed, @I2@ untouched.
    expect(diff.added).toEqual(["2 PLAC Kranj"]);
    expect(diff.removed).toEqual([]);
    expect(after).toContain("0 @I2@ INDI\n1 NAME Ana /Kos/");
  });

  it("ignores non-confirmed decisions", () => {
    const m = new Map<string, CandidateDecision>();
    m.set(decisionKey("individual", "@I1@", "@P1@"), { status: "deferred", fields: {} });
    const { records, report } = mergeDecisions(master, compare, m, tr);
    expect(report.changes).toHaveLength(0);
    expect(serializeGedcom(records)).toBe(serializeGedcom(master.records));
  });
});

/** Naive line-level diff for asserting which lines were added/removed. */
function lineDiff(before: string, after: string): { added: string[]; removed: string[] } {
  const b = new Map<string, number>();
  for (const l of before.split("\n")) b.set(l, (b.get(l) ?? 0) + 1);
  const a = new Map<string, number>();
  for (const l of after.split("\n")) a.set(l, (a.get(l) ?? 0) + 1);
  const added: string[] = [];
  const removed: string[] = [];
  for (const [l, n] of a) if (l && n > (b.get(l) ?? 0)) added.push(l);
  for (const [l, n] of b) if (l && n > (a.get(l) ?? 0)) removed.push(l);
  return { added, removed };
}
