import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import { offersEventValue } from "../gedcom/eventTags";
import { decisionKey, type CandidateDecision } from "../review/types";
import { targetFormatOverrides } from "../normalize/target";
import { validateConformance } from "../tools/conformance/conformance";
import { mergeDecisions } from "./merge";

/**
 * A value on an event's own line is offered, and copied, only where the
 * target's version gives that line text: 7.0's death and retirement take only
 * the `Y` flag.
 */

const dataset = (text: string) => buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
const wrap = (version: string, body: string) => `0 HEAD\n1 GEDC\n2 VERS ${version}\n1 CHAR UTF-8\n${body}0 TRLR\n`;
const tr = (key: string) => key;
const NO_MATCHES = { individuals: [], families: [] };
const confirmed = (fields: Record<string, "main" | "incoming" | "both">): Map<string, CandidateDecision> =>
  new Map([[decisionKey("individual", "@I1@", "@P1@"), { status: "confirmed", fields }]]);

describe("offersEventValue", () => {
  it("asks the target version's table", () => {
    expect(offersEventValue("DEAT", "7.0")).toBe(false);
    expect(offersEventValue("RETI", "7.0")).toBe(false);
    expect(offersEventValue("OCCU", "7.0")).toBe(true);
    expect(offersEventValue("RESI", "7.0")).toBe(true);
    expect(offersEventValue("NCHI", "7.0")).toBe(true);
    // 5.5.1's table holds its event lines as text.
    expect(offersEventValue("DEAT", "5.5.1")).toBe(true);
    // An extension keeps its value; a tag with none is never offered one.
    expect(offersEventValue("_MILT", "7.0")).toBe(true);
    expect(offersEventValue("BIRT", "7.0")).toBe(false);
  });
});

describe("merging a death's description", () => {
  it.each(["5.5.1", "7.0"] as const)("leaves a strict %s file nothing to find", (version) => {
    const main = dataset(wrap(version, "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 DEAT\n2 DATE 1950\n"));
    const compare = dataset(wrap(version, "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 DEAT died young\n2 DATE 1950\n"));
    const before = validateConformance(main);
    const overrides = targetFormatOverrides({}, { strict: true, version });
    const { records } = mergeDecisions(main, compare, confirmed({ "DEAT.value": "incoming" }), NO_MATCHES, tr, [], overrides);
    const out = serializeGedcom(records);
    if (version === "7.0") expect(out).toContain("1 DEAT\n2 DATE 1950\n2 NOTE died young\n");
    else expect(out).toContain("1 DEAT died young\n2 DATE 1950\n");
    expect(validateConformance({ records })).toEqual(before);
  });
});
