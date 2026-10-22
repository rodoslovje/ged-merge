import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { rebuildIndividual } from "../gedcom/edit";
import type { GedNode } from "../gedcom/types";
import { baptismTargetTag, detectCitationPlacement } from "./sourceReshape";

const dataset = (body: string) =>
  buildDataset(parseGedcom(new TextEncoder().encode(`0 HEAD\n1 CHAR UTF-8\n${body}0 TRLR\n`).buffer));
const line = (level: number, tag: string, value?: string, children: GedNode[] = []): GedNode => ({ level, tag, value, children });

describe("citation habits are read afresh once the file changes", () => {
  it("detectCitationPlacement and baptismTargetTag follow an edit", () => {
    const ds = dataset(
      "0 @S1@ SOUR\n1 TITL Krstna knjiga\n" +
        "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SOUR @S1@\n1 BIRT\n2 DATE 1850\n1 BAPM\n2 DATE 1850\n2 SOUR @S1@\n",
    );
    // One record-level citation against one event citation: events win ties.
    expect(detectCitationPlacement(ds.records)).toBe("event");
    expect(baptismTargetTag(ds.records)).toBe("BAPM");
    // Asked again with nothing changed: the same answers, from the memo.
    expect(detectCitationPlacement(ds.records)).toBe("event");

    // Three more record-level citations, and two on the birth, made through
    // the edit helpers (lines, then the rebuild): both habits turn.
    const janez = ds.individuals.get("@I1@")!;
    janez.raw.children.push(line(1, "SOUR", "@S1@"), line(1, "SOUR", "@S1@"), line(1, "SOUR", "@S1@"));
    const birt = janez.raw.children.find((c) => c.tag === "BIRT")!;
    birt.children.push(line(2, "SOUR", "@S1@"), line(2, "SOUR", "@S1@"));
    rebuildIndividual(ds, janez);
    expect(detectCitationPlacement(ds.records)).toBe("record");
    expect(baptismTargetTag(ds.records)).toBe("BIRT");
  });
});
