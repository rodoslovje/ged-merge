import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import { removeFamily } from "../gedcom/edit";
import { applyPassSafely } from "./passSafety";
import { applyPlaceRename } from "./placeEdit";
import { mergeDuplicate, mergeDuplicateChain } from "./mergeDuplicate";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

const FILE = [
  "0 HEAD",
  "1 CHAR UTF-8",
  "0 @I1@ INDI",
  "1 NAME Janez /Novak/",
  "1 SEX M",
  "1 BIRT",
  "2 PLAC Kranj",
  "1 FAMS @F1@",
  "0 @I2@ INDI",
  "1 NAME Janez /Novak/",
  "1 SEX M",
  "1 BIRT",
  "2 PLAC Kranj",
  "0 @I3@ INDI",
  "1 NAME Marija /Kos/",
  "1 SEX F",
  "1 FAMS @F1@",
  "0 @F1@ FAM",
  "1 HUSB @I1@",
  "1 WIFE @I3@",
  "0 TRLR",
].join("\n");

describe("applyPassSafely", () => {
  it("puts back every record a throwing pass touched, created or removed", () => {
    const ds = dataset(FILE);
    const original = serializeGedcom(ds.records);
    expect(() =>
      applyPassSafely(ds, (journal) => {
        journal.touch("@I1@");
        ds.individuals.get("@I1@")!.raw.children[0].value = "Changed /Name/";
        ds.records.splice(1, 0, { level: 0, xref: "@S9@", tag: "SOUR", children: [] });
        for (const id of ["@I1@", "@I3@"]) journal.touch(id);
        removeFamily(ds, ds.families.get("@F1@")!);
        throw new Error("halfway");
      }),
    ).toThrow("halfway");
    expect(serializeGedcom(ds.records)).toBe(original);
    // The typed model is back in step with the records.
    expect(ds.families.get("@F1@")?.husband).toBe("@I1@");
    expect(ds.individuals.get("@I1@")!.spouseOf).toEqual(["@F1@"]);
    expect(ds.individuals.get("@I1@")!.raw).toBe(ds.records.find((r) => r.xref === "@I1@"));
  });

  it("returns what the pass returns and changes nothing else when it succeeds", () => {
    const ds = dataset(FILE);
    expect(applyPassSafely(ds, () => 42)).toBe(42);
  });

  it("a whole-file place pass that throws partway leaves no record half-renamed", () => {
    const ds = dataset(FILE);
    const original = serializeGedcom(ds.records);
    // The second person's record is one the rename cannot read: it throws
    // there, after the first person's place was already renamed in place.
    Object.defineProperty(ds.individuals.get("@I2@")!.raw, "children", {
      get() {
        throw new Error("unreadable");
      },
    });
    expect(() => applyPlaceRename(ds, "Kranj", "Kranj, Slovenija")).toThrow("unreadable");
    const i1 = ds.individuals.get("@I1@")!.raw;
    expect(serializeGedcom([i1])).toBe(original.slice(original.indexOf("0 @I1@"), original.indexOf("0 @I2@")));
  });

  it("a merge chain whose second step throws takes the first step back too", () => {
    // A third record of Janez, absorbed by the chain's second step.
    const text = FILE.replace("0 @I3@ INDI", "0 @I4@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n0 @I3@ INDI");
    const decision = { status: "confirmed" as const, fields: {} };
    const steps = [
      { survivorId: "@I1@", removedId: "@I2@", decision },
      { survivorId: "@I1@", removedId: "@I4@", decision },
    ];
    // How many labels the first merge asks for: the second step's first ask throws.
    let calls = 0;
    mergeDuplicate(dataset(text), "@I1@", "@I2@", decision, (k: string) => (calls++, k));
    expect(calls).toBeGreaterThan(0);
    let n = 0;
    const t = (k: string) => {
      if (++n > calls) throw new Error("second step");
      return k;
    };

    const ds = dataset(text);
    const original = serializeGedcom(ds.records);
    expect(() => mergeDuplicateChain(ds, steps, t)).toThrow("second step");
    expect(serializeGedcom(ds.records)).toBe(original);
    expect(ds.individuals.has("@I2@")).toBe(true);
  });
});
