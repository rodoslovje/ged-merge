import { describe, expect, it } from "vitest";
import { coalescePatches, type RecordPatch } from "./historyTypes";
import type { GedNode } from "../gedcom/types";

const node = (value: string): GedNode => ({ level: 0, tag: "INDI", value, children: [] });

describe("coalescePatches", () => {
  it("merges two patches of one record into first-before / last-after", () => {
    const patches: RecordPatch[] = [
      { type: "individual", id: "@I1@", before: node("original"), after: node("renamed") },
      { type: "individual", id: "@I1@", before: node("renamed"), after: node("renamed+map") },
      { type: "individual", id: "@I2@", before: node("x"), after: node("y") },
    ];
    const merged = coalescePatches(patches);
    expect(merged).toHaveLength(2);
    expect((merged[0].before as GedNode).value).toBe("original");
    expect((merged[0].after as GedNode).value).toBe("renamed+map");
    expect(merged[1].id).toBe("@I2@");
  });

  it("keeps a trailing delete, with its index", () => {
    const patches: RecordPatch[] = [
      { type: "individual", id: "@I1@", before: node("a"), after: node("b") },
      { type: "individual", id: "@I1@", before: node("b"), after: null, index: 3 },
    ];
    const merged = coalescePatches(patches);
    expect(merged).toHaveLength(1);
    expect((merged[0].before as GedNode).value).toBe("a");
    expect(merged[0].after).toBeNull();
    expect(merged[0].index).toBe(3);
  });
});
