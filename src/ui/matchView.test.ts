import { describe, expect, it } from "vitest";
import { applyFilters, NO_FILTERS, type Candidate } from "./matchView";

const cand = (mainId: string): Candidate => ({ mainId, compareId: `C${mainId}`, name: mainId, score: 90 }) as Candidate;

describe("applyFilters — the kin filter", () => {
  const list = [cand("@START@"), cand("@FATHER@"), cand("@STRANGER@")];

  it("keeps only the main ids in the start person's line", () => {
    const line = new Set(["@START@", "@FATHER@"]);
    expect(applyFilters(list, { ...NO_FILTERS, kin: "ancestors" }, line).map((c) => c.mainId)).toEqual(["@START@", "@FATHER@"]);
  });

  it("keeps everyone when no line is given (all people, or no start person)", () => {
    expect(applyFilters(list, { ...NO_FILTERS, kin: "blood" })).toHaveLength(3);
  });
});
