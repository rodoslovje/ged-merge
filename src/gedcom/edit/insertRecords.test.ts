import { describe, expect, it } from "vitest";
import type { GedNode } from "../types";
import { insertRecord, insertRecords } from "./shared";

const rec = (tag: string, xref?: string): GedNode => ({ level: 0, tag, ...(xref ? { xref } : {}), children: [] });
const shape = (records: GedNode[]) => records.map((r) => r.xref ?? r.tag);

describe("insertRecords", () => {
  it("places records where inserting them one by one would", () => {
    const base = () => [rec("HEAD"), rec("INDI", "@I1@"), rec("FAM", "@F1@"), rec("INDI", "@I2@"), rec("SOUR", "@S1@"), rec("TRLR")];
    // Tags the file has, tags it has none of, interleaved.
    const added = () => [
      rec("INDI", "@I3@"), rec("NOTE", "@N1@"), rec("FAM", "@F2@"), rec("OBJE", "@O1@"),
      rec("NOTE", "@N2@"), rec("SOUR", "@S2@"), rec("INDI", "@I4@"), rec("REPO", "@R1@"),
    ];
    const oneByOne = base();
    for (const r of added()) insertRecord(oneByOne, r);
    const batch = base();
    insertRecords(batch, added());
    expect(shape(batch)).toEqual(shape(oneByOne));
  });

  it("appends when there is no TRLR", () => {
    const oneByOne = [rec("HEAD"), rec("INDI", "@I1@")];
    const batch = [rec("HEAD"), rec("INDI", "@I1@")];
    const added = () => [rec("NOTE", "@N1@"), rec("INDI", "@I2@"), rec("SOUR", "@S1@"), rec("NOTE", "@N2@")];
    for (const r of added()) insertRecord(oneByOne, r);
    insertRecords(batch, added());
    expect(shape(batch)).toEqual(shape(oneByOne));
  });
});
