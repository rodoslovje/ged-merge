import { describe, expect, it } from "vitest";
import { parseGedcom } from "./parser";
import { buildDataset } from "./builder";

const SAMPLE = `0 HEAD
1 SOUR Test
1 GEDC
2 VERS 5.5.1
2 FORM LINEAGE-LINKED
1 CHAR UTF-8
0 @I1@ INDI
1 NAME John /Smith/
1 SEX M
1 BIRT
2 DATE 12 JAN 1900
2 PLAC Springfield, Illinois, USA
1 FAMS @F1@
0 @I2@ INDI
1 NAME Jane /Doe/
1 SEX F
1 BIRT
2 DATE ABT 1902
1 FAMS @F1@
0 @I3@ INDI
1 NAME Baby /Smith/
1 FAMC @F1@
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 CHIL @I3@
1 MARR
2 DATE 5 JUN 1925
0 TRLR
`;

function toBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

describe("parseGedcom", () => {
  it("detects version and charset", () => {
    const parsed = parseGedcom(toBuffer(SAMPLE));
    expect(parsed.version).toBe("5.5.1");
    expect(parsed.charset).toBe("UTF-8");
  });

  it("builds individuals and families with relationships", () => {
    const ds = buildDataset(parseGedcom(toBuffer(SAMPLE)));
    expect(ds.individuals.size).toBe(3);
    expect(ds.families.size).toBe(1);

    const john = ds.individuals.get("@I1@")!;
    expect(john.names[0].given).toBe("John");
    expect(john.names[0].surname).toBe("Smith");
    expect(john.sex).toBe("M");
    expect(john.events.find((e) => e.tag === "BIRT")?.date?.year).toBe(1900);
    expect(john.events.find((e) => e.tag === "BIRT")?.place?.parts).toEqual([
      "Springfield",
      "Illinois",
      "USA",
    ]);
    expect(john.spouseOf).toContain("@F1@");

    const fam = ds.families.get("@F1@")!;
    expect(fam.husband).toBe("@I1@");
    expect(fam.wife).toBe("@I2@");
    expect(fam.children).toEqual(["@I3@"]);
    expect(fam.events.find((e) => e.tag === "MARR")?.date?.year).toBe(1925);
  });

  it("parses approximate dates", () => {
    const ds = buildDataset(parseGedcom(toBuffer(SAMPLE)));
    const jane = ds.individuals.get("@I2@")!;
    const birth = jane.events.find((e) => e.tag === "BIRT");
    expect(birth?.date?.qualifier).toBe("about");
    expect(birth?.date?.year).toBe(1902);
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
    ["CR", "\r"], // classic-Mac, e.g. Reunion exports
  ])("detects %s line endings and round-trips them", (_name, eol) => {
    const text = SAMPLE.replace(/\n/g, eol);
    const parsed = parseGedcom(toBuffer(text));
    expect(parsed.eol).toBe(eol);
    // Lines still split correctly regardless of ending.
    const ds = buildDataset(parsed);
    expect(ds.individuals.size).toBe(3);
  });

  describe("unparsable lines", () => {
    // A malformed line (no space after the level) inside a record, plus junk
    // before the header.
    const BAD = [
      "garbage before header",
      "0 HEAD",
      "1 GEDC",
      "2 VERS 5.5.1",
      "0 @I1@ INDI",
      "1 NAME Janez /Novak/",
      "1SEX M",
      "1 BIRT",
      "2 DATE 1850",
      "0 TRLR",
      "",
    ].join("\n");

    it("keeps them as verbatim nodes at their original position, with a syntax warning", () => {
      const parsed = parseGedcom(toBuffer(BAD));
      expect(parsed.warnings.filter((w) => w.kind === "syntax")).toHaveLength(2);
      // The bad line follows "1 NAME …", so it hangs off the deepest open node
      // (NAME) — depth-first serialization re-emits it at the same stream position.
      const indi = parsed.records.find((r) => r.xref === "@I1@")!;
      const name = indi.children.find((c) => c.tag === "NAME")!;
      const bad = name.children.find((c) => c.verbatim !== undefined);
      expect(bad?.verbatim).toBe("1SEX M");
      expect(bad?.tag).toBe(""); // never matches any tag lookup
      // Junk before the first record becomes a verbatim root.
      expect(parsed.records[0].verbatim).toBe("garbage before header");
    });

    it("does not disturb the surrounding structure", () => {
      const ds = buildDataset(parseGedcom(toBuffer(BAD)));
      const indi = ds.individuals.get("@I1@")!;
      expect(indi.names[0].full).toContain("Janez");
      expect(indi.events.some((e) => e.tag === "BIRT" && e.date?.year === 1850)).toBe(true);
    });
  });
});
