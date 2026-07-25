import { describe, expect, it } from "vitest";
import { clusterDuplicates, duplicatePairKey, parseDuplicatePairKey, type DuplicatePair } from "./duplicates";

function pair(aId: string, bId: string, score: number): DuplicatePair {
  return { aId, bId, aLabel: aId, bLabel: bId, score, category: "strong" };
}

describe("duplicatePairKey / parseDuplicatePairKey", () => {
  it("is order-independent, so a flipped orientation keys the same pair", () => {
    expect(duplicatePairKey("@I2@", "@I1@")).toBe(duplicatePairKey("@I1@", "@I2@"));
  });

  it("round-trips both ids regardless of the order they were built from", () => {
    for (const [a, b] of [["@I1@", "@I2@"], ["@I2@", "@I1@"]]) {
      expect(parseDuplicatePairKey(duplicatePairKey(a, b))).toEqual({ aId: "@I1@", bId: "@I2@" });
    }
  });

  it.each([
    ["empty", ""],
    ["no separator", "@I1@"],
    ["too many parts", "@I1@|@I2@|@I3@"],
    ["blank first id", "|@I2@"],
    ["blank second id", "@I1@|"],
  ])("rejects a malformed key (%s)", (_case, key) => {
    expect(parseDuplicatePairKey(key)).toBeUndefined();
  });
});

describe("clusterDuplicates", () => {
  it("keeps a lone pair as a one-pair cluster", () => {
    const clusters = clusterDuplicates([pair("A", "B", 90)]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].pairs).toHaveLength(1);
    expect(clusters[0].memberIds).toEqual(["A", "B"]);
    expect(clusters[0].id).toBe("A");
    expect(clusters[0].maxScore).toBe(90);
  });

  it("merges pairs that share a record into one cluster", () => {
    // A-B and A-C share A → one cluster {A,B,C}; D-E is separate.
    const clusters = clusterDuplicates([
      pair("A", "B", 88),
      pair("A", "C", 92),
      pair("D", "E", 80),
    ]);
    expect(clusters).toHaveLength(2);
    // The bigger blob (2 pairs) sorts first.
    expect(clusters[0].memberIds).toEqual(["A", "B", "C"]);
    expect(clusters[0].pairs).toHaveLength(2);
    // Pairs within a cluster are sorted by score descending.
    expect(clusters[0].pairs.map((p) => p.score)).toEqual([92, 88]);
    expect(clusters[1].memberIds).toEqual(["D", "E"]);
  });

  it("chains transitively (A-B, B-C, C-D) into a single cluster", () => {
    const clusters = clusterDuplicates([
      pair("A", "B", 70),
      pair("B", "C", 71),
      pair("C", "D", 72),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].memberIds).toEqual(["A", "B", "C", "D"]);
    expect(clusters[0].pairs).toHaveLength(3);
  });

  it("orders clusters by pair count, then top score", () => {
    const clusters = clusterDuplicates([
      pair("X", "Y", 99), // lone high-score pair
      pair("A", "B", 80),
      pair("B", "C", 81), // 2-pair blob, lower scores
    ]);
    expect(clusters[0].pairs).toHaveLength(2); // blob first despite lower score
    expect(clusters[1].memberIds).toEqual(["X", "Y"]);
  });

  it("returns nothing for an empty input", () => {
    expect(clusterDuplicates([])).toEqual([]);
  });
});
