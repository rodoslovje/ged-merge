import { describe, expect, it } from "vitest";
import { parseGedcom } from "../gedcom/parser";
import { buildDataset } from "../gedcom/builder";
import { validateConformance } from "../tools/conformance/conformance";
import { branchGedcomText } from "./exportGedcom";

const load = (text: string) => buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));

const FILE = (version: "5.5.1" | "7.0") => [
  "0 HEAD",
  "1 SOUR TEST",
  "1 GEDC",
  ...(version === "7.0" ? ["2 VERS 7.0"] : ["2 VERS 5.5.1", "2 FORM LINEAGE-LINKED", "1 CHAR UTF-8"]),
  "0 @I1@ INDI",
  "1 NAME Janez /Novak/",
  "1 FAMC @F1@",
  "1 FAMS @F2@",
  "1 SLGC",
  "2 FAMC @F1@",
  "1 BIRT",
  "2 DATE 1 JAN 1900",
  ...(version === "7.0" ? ["2 SOUR @VOID@", "3 PAGE Parish book, p. 12"] : ["2 SOUR Parish book, p. 12"]),
  "0 @I2@ INDI",
  "1 NAME Neža /Dolenc/",
  "1 FAMS @F2@",
  "0 @I3@ INDI",
  "1 NAME Franc /Novak/",
  "1 FAMS @F1@",
  "0 @F1@ FAM",
  "1 HUSB @I3@",
  "1 CHIL @I1@",
  "0 @F2@ FAM",
  "1 HUSB @I1@",
  "1 WIFE @I2@",
  "0 TRLR",
].join("\n") + "\n";

describe("branchGedcomText — a chart's branch file", () => {
  for (const [from, to] of [["5.5.1", "7.0"], ["7.0", "5.5.1"]] as const) {
    it(`is written in a strict ${to} target's version from a ${from} file, valid in it`, () => {
      const out = branchGedcomText(load(FILE(from)), ["@I1@", "@I2@"], { strict: true, version: to });
      expect(out).toContain(`2 VERS ${to}`);
      const back = load(out);
      expect(back.version).toBe(to);
      expect(validateConformance(back)).toEqual([]);
      // The citation of an unrecorded source survives either way.
      expect(out).toContain("Parish book, p. 12");
    });

    it(`stays in a ${from} file's own version in Master file mode`, () => {
      const out = branchGedcomText(load(FILE(from)), ["@I1@", "@I2@"], { strict: false, version: from });
      expect(load(out).version).toBe(from);
    });
  }
});
