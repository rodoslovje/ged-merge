import { describe, expect, it } from "vitest";
import { buildDataset } from "./builder";
import { parseGedcom } from "./parser";
import { unionMark } from "./union";

const fam = (lines: string) => {
  const text = `0 HEAD\n1 CHAR UTF-8\n0 @I1@ INDI\n1 FAMS @F1@\n0 @I2@ INDI\n1 FAMS @F1@\n0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n${lines}0 TRLR\n`;
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer)).families.get("@F1@");
};

describe("unionMark", () => {
  it("reads a union with nothing recorded as a marriage", () => {
    expect(unionMark(fam(""))).toEqual({ glyph: "⚭" });
    expect(unionMark(undefined)).toEqual({ glyph: "⚭" });
  });

  it("marks a dissolved marriage as divorced", () => {
    expect(unionMark(fam("1 MARR\n2 DATE 1900\n1 DIV\n2 DATE 1910\n"))).toEqual({ glyph: "⚮", ended: "divorced" });
    expect(unionMark(fam("1 ANUL Y\n"))).toEqual({ glyph: "⚮", ended: "divorced" });
  });

  it("marks a separated marriage as separated", () => {
    expect(unionMark(fam("1 MARR Y\n1 SEPA\n2 DATE 1905\n"))).toEqual({ glyph: "⚬⚬", ended: "separated" });
  });

  it("marks a recorded unmarried partnership, and its separation", () => {
    expect(unionMark(fam("1 _MSTAT Partners\n"))).toEqual({ glyph: "⚯" });
    expect(unionMark(fam("1 _MSTAT Partners\n1 SEPA\n"))).toEqual({ glyph: "⚬⚬", ended: "separated" });
  });
});
