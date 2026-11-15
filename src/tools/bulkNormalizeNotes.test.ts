import { describe, expect, it, vi } from "vitest";
import { buildDataset } from "../gedcom/builder";
import * as edit from "../gedcom/edit";
import { parseGedcom } from "../gedcom/parser";
import { targetFormatOverrides } from "../normalize/target";
import type { NormalizeOptions } from "../normalize/types";
import { applyBulkNormalize } from "./bulkNormalize";

vi.mock("../gedcom/edit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gedcom/edit")>();
  return { ...actual, rebuildNoteReferrers: vi.fn(actual.rebuildNoteReferrers) };
});

const ALL: NormalizeOptions = { dates: true, places: true, links: true, names: true, vendorTags: true, sourceCoverage: true, noteShape: false, repairs: true, stripInternal: false };

describe("applyBulkNormalize", () => {
  it("rebuilds the referrers of a changed 7.0 shared note (SNOTE)", () => {
    const text = [
      "0 HEAD", "1 GEDC", "2 VERS 7.0",
      "0 @I1@ INDI", "1 NAME Ana /Kos/", "1 SNOTE @N1@",
      "0 @N1@ SNOTE Shared text", "1 LANG en", "1 LANG en",
      "0 TRLR", "",
    ].join("\n");
    const ds = buildDataset(parseGedcom(new TextEncoder().encode(text).buffer as ArrayBuffer));
    const patches = applyBulkNormalize(ds, ALL, targetFormatOverrides({}, { strict: true, version: "7.0" }));
    expect(patches.some((p) => p.type === "record" && p.id === "@N1@")).toBe(true);
    const calls = vi.mocked(edit.rebuildNoteReferrers).mock.calls;
    expect(calls.flatMap(([, changes]) => changes.map((c) => c.xref))).toContain("@N1@");
  });
});
