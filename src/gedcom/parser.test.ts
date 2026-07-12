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

    // MyHeritage attaches auto-generated transcription blurbs to source
    // citations, and when the pasted text itself contains a line break, it
    // writes that break as a bare physical line instead of another CONC/CONT
    // line — not valid GEDCOM syntax, but overwhelmingly the real-world cause
    // of "unparsable line" warnings, so it's folded back into the value
    // instead of being flagged and detached.
    const MYHERITAGE_TEXT = [
      "0 HEAD",
      "1 GEDC",
      "2 VERS 5.5.1",
      "0 @I1@ INDI",
      "1 NAME Rudolph /Simonich/",
      "1 SOUR @S1@",
      "2 DATA",
      "3 TEXT Rudolph Simonich, born 1866",
      "4 CONC ; a newspaper excerpt follows:",
      "In the rugged town of Butte, where men are",
      "measured by exacting standards.",
      "4 CONC  He was unanimously respected.",
      "1 BIRT",
      "2 DATE 1866",
      "0 TRLR",
      "",
    ].join("\n");

    it("folds a MyHeritage-style embedded line break into the TEXT value, with no warning", () => {
      const parsed = parseGedcom(toBuffer(MYHERITAGE_TEXT));
      expect(parsed.warnings).toHaveLength(0);
      const indi = parsed.records.find((r) => r.xref === "@I1@")!;
      const text = indi.children.find((c) => c.tag === "SOUR")!.children.find((c) => c.tag === "DATA")!.children.find(
        (c) => c.tag === "TEXT",
      )!;
      // CONC lines concatenate with no separator; folded free-text lines join
      // with "\n" (matching CONT semantics for a genuine embedded line break).
      expect(text.value).toBe(
        "Rudolph Simonich, born 1866; a newspaper excerpt follows:\n" +
          "In the rugged town of Butte, where men are\n" +
          "measured by exacting standards. He was unanimously respected.",
      );
      expect(text.children).toHaveLength(0);
    });

    it("still parses the record's other fields correctly", () => {
      const ds = buildDataset(parseGedcom(toBuffer(MYHERITAGE_TEXT)));
      const indi = ds.individuals.get("@I1@")!;
      expect(indi.names[0].full).toContain("Rudolph");
      expect(indi.events.some((e) => e.tag === "BIRT" && e.date?.year === 1866)).toBe(true);
    });
  });

  it("warns when two records define the same xref (last one wins)", () => {
    const text = [
      "0 HEAD",
      "0 @I1@ INDI",
      "1 NAME Ana /Novak/",
      "0 @I1@ INDI",
      "1 NAME Bo /Kos/",
      "0 TRLR",
      "",
    ].join("\n");
    const ds = buildDataset(parseGedcom(toBuffer(text)));
    expect(ds.individuals.size).toBe(1);
    expect(ds.individuals.get("@I1@")?.names[0].full).toContain("Bo");
    expect(
      ds.warnings.some((w) => w.kind === "structure" && w.message.startsWith("Duplicate xref @I1@")),
    ).toBe(true);
    // The shadowed earlier record is dropped from records[] too — otherwise
    // both would serialize and the *saved* file would carry @I1@ twice.
    const copies = ds.records.filter((r) => r.xref === "@I1@");
    expect(copies).toHaveLength(1);
    expect(copies[0].children.find((c) => c.tag === "NAME")?.value).toBe("Bo /Kos/");
  });

  it("folds a doubled leading at-sign (@@) back to a literal @", () => {
    const text = ["0 HEAD", "0 @I1@ INDI", "1 NOTE @@home with Mother", "0 TRLR", ""].join("\n");
    const parsed = parseGedcom(toBuffer(text));
    const indi = parsed.records.find((r) => r.xref === "@I1@")!;
    expect(indi.children.find((c) => c.tag === "NOTE")?.value).toBe("@home with Mother");
  });

  describe("level-jump recovery", () => {
    it("attaches a line that skips a level to the deepest open node, with a warning", () => {
      const text = [
        "0 HEAD",
        "0 @I1@ INDI",
        "1 BIRT",
        "3 PLAC Kranj", // level 3 under a level-1 event: no level-2 parent open
        "0 TRLR",
        "",
      ].join("\n");
      const parsed = parseGedcom(toBuffer(text));
      expect(parsed.warnings.some((w) => w.kind === "structure" && w.message.includes("attached to the nearest"))).toBe(
        true,
      );
      // The stray line stays inside its record (under BIRT), not at top level.
      expect(parsed.records).toHaveLength(3);
      const birt = parsed.records[1].children.find((c) => c.tag === "BIRT")!;
      expect(birt.children.find((c) => c.tag === "PLAC")?.value).toBe("Kranj");
    });

    it("keeps children of a clamped node attached to it", () => {
      const text = [
        "0 HEAD",
        "0 @I1@ INDI",
        "2 BIRT", // level jump: clamps under INDI
        "3 DATE 1900", // its child must follow it
        "0 TRLR",
        "",
      ].join("\n");
      const parsed = parseGedcom(toBuffer(text));
      const birt = parsed.records[1].children.find((c) => c.tag === "BIRT")!;
      expect(birt.children.find((c) => c.tag === "DATE")?.value).toBe("1900");
    });
  });

  describe("NAME value parsing", () => {
    const nameOf = (nameLine: string) => {
      const text = ["0 HEAD", "0 @I1@ INDI", `1 NAME ${nameLine}`, "0 TRLR", ""].join("\n");
      const ds = buildDataset(parseGedcom(toBuffer(text)));
      return ds.individuals.get("@I1@")!.names[0];
    };

    it("keeps a token after the surname as the suffix", () => {
      const name = nameOf("John /Smith/ Jr");
      expect(name.given).toBe("John");
      expect(name.surname).toBe("Smith");
      expect(name.suffix).toBe("Jr");
      expect(name.full).toBe("John Smith Jr");
    });

    it("treats the token after the slashes as the given name when nothing precedes them", () => {
      const name = nameOf("/Novak/ Janez");
      expect(name.given).toBe("Janez");
      expect(name.surname).toBe("Novak");
      expect(name.suffix).toBeUndefined();
    });
  });
});
