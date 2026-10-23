import { describe, expect, it } from "vitest";
import { sharedMediaMutation } from "./sharedMedia";
import type { RecordPatch } from "../historyTypes";
import type { GedNode } from "../../gedcom/types";

const records = (): GedNode[] => [
  { level: 0, tag: "HEAD", children: [] },
  { level: 0, tag: "INDI", xref: "@I1@", children: [] },
  { level: 0, tag: "OBJE", xref: "@O1@", children: [{ level: 1, tag: "FILE", value: "old.jpg", children: [] }] },
  { level: 0, tag: "TRLR", children: [] },
];

// Regression: the shared OBJE record was created before the commit ran, so a
// commit that bailed out (no person on screen) left it orphaned in the file —
// with no undo patch and nothing marked unsaved.
describe("sharedMediaMutation", () => {
  it("creates the media record only when the commit runs the mutation", () => {
    const recs = records();
    const patches: RecordPatch[] = [];
    const mutate = sharedMediaMutation(recs, "new.jpg", undefined, patches);
    expect(recs).toHaveLength(4); // a bailing commit never calls it: nothing created
    const person = recs[1];
    mutate(person);
    const created = recs.find((r) => r.tag === "OBJE" && r.xref !== "@O1@")!;
    expect(created.children[0].value).toBe("new.jpg");
    expect(person.children.map((c) => `${c.tag} ${c.value}`)).toEqual([`OBJE ${created.xref}`]);
    expect(patches).toEqual([expect.objectContaining({ type: "record", id: created.xref, before: null })]);
  });

  it("reuses a record with the same file", () => {
    const recs = records();
    const patches: RecordPatch[] = [];
    sharedMediaMutation(recs, "old.jpg", undefined, patches)(recs[1]);
    expect(recs).toHaveLength(4);
    expect(patches).toEqual([]);
    expect(recs[1].children[0].value).toBe("@O1@");
  });
});
