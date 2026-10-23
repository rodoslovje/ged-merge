import { describe, expect, it } from "vitest";
import { declaredVersion, NOT_GEDCOM, parseGedcom } from "./parser";
import { buildDataset } from "./builder";
import { cloneNode } from "./node";
import { downloadOptions, serializeGedcom } from "./serialize";

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

  it("keeps a CONT/CONC at the wrong level with the text it continues", () => {
    const text = [
      "0 HEAD",
      "0 @I1@ INDI",
      "1 NOTE first",
      "1 CONT second", // one level too shallow: would land on the INDI itself
      "1 BIRT",
      "2 DATE 1900",
      "2 NOTE born at home",
      "4 CONC  in the village", // two levels too deep: had no parent at all
      "1 TITL Dr.",
      "1 CONC  med.", // shallow, with no NOTE in progress
      "0 TRLR",
      "",
    ].join("\n");
    const parsed = parseGedcom(toBuffer(text));
    const indi = parsed.records.find((r) => r.xref === "@I1@")!;
    expect(indi.value).toBeUndefined();
    expect(indi.children.find((c) => c.tag === "NOTE")?.value).toBe("first\nsecond");
    const birt = indi.children.find((c) => c.tag === "BIRT")!;
    expect(birt.children.find((c) => c.tag === "NOTE")?.value).toBe("born at home in the village");
    expect(indi.children.find((c) => c.tag === "TITL")?.value).toBe("Dr. med.");
    expect(parsed.warnings.filter((w) => w.kind === "structure" && /CONT|CONC/.test(w.message))).toHaveLength(3);
    // Written back at the level the continuation belongs to.
    const out = serializeGedcom(parsed.records);
    expect(out).toContain("1 NOTE first\n2 CONT second\n");
    expect(out).toContain("2 NOTE born at home in the village\n");
    expect(out).toContain("1 TITL Dr. med.\n");
  });

  it("does not fold a level-skipping line into a NOTE pointer", () => {
    const text = ["0 HEAD", "0 @I1@ INDI", "1 NOTE @N1@", "3 DATE 1900", "0 @N1@ NOTE story", "0 TRLR", ""].join("\n");
    const parsed = parseGedcom(toBuffer(text));
    const indi = parsed.records.find((r) => r.xref === "@I1@")!;
    const note = indi.children.find((c) => c.tag === "NOTE")!;
    expect(note.value).toBe("@N1@");
    // Clamped into the record like any other level skip, not turned into text.
    expect(note.children.map((c) => `${c.tag} ${c.value}`)).toEqual(["DATE 1900"]);
    expect(parsed.warnings.some((w) => /level 3 has no parent/.test(w.message))).toBe(true);
    expect(serializeGedcom(parsed.records)).not.toContain("CONT");
  });

  it("keeps both records that share an xref, renaming the earlier one", () => {
    const text = [
      "0 HEAD",
      "0 @I1@ INDI",
      "1 NAME Ana /Novak/",
      "0 @I1@ INDI",
      "1 NAME Bo /Kos/",
      "1 FAMS @F1@",
      "0 @I2@ INDI",
      "1 NAME Cene /Kos/",
      "0 @F1@ FAM",
      "1 HUSB @I1@",
      "0 TRLR",
      "",
    ].join("\n");
    const ds = buildDataset(parseGedcom(toBuffer(text)));
    // The pointer still binds to the last copy, as it always has.
    expect(ds.individuals.get("@I1@")?.names[0].full).toContain("Bo");
    expect(ds.families.get("@F1@")?.husband).toBe("@I1@");
    expect(
      ds.warnings.some((w) => w.kind === "structure" && w.message.startsWith("Duplicate xref @I1@") && w.message.includes("@I3@")),
    ).toBe(true);
    // The shadowed earlier person is kept under a fresh id — dropping it lost
    // them from the save, keeping both ids would write @I1@ twice.
    expect(ds.individuals.size).toBe(3);
    expect(ds.individuals.get("@I3@")?.names[0].full).toContain("Ana");
    expect(ds.records.filter((r) => r.xref === "@I1@")).toHaveLength(1);
    const out = serializeGedcom(ds.records);
    expect(out).toContain("0 @I3@ INDI\n1 NAME Ana /Novak/\n0 @I1@ INDI\n1 NAME Bo /Kos/");
  });

  it("folds a doubled leading at-sign (@@) back to a literal @", () => {
    const text = ["0 HEAD", "0 @I1@ INDI", "1 NOTE @@home with Mother", "0 TRLR", ""].join("\n");
    const parsed = parseGedcom(toBuffer(text));
    const indi = parsed.records.find((r) => r.xref === "@I1@")!;
    expect(indi.children.find((c) => c.tag === "NOTE")?.value).toBe("@home with Mother");
  });

  it("decodes every @@ in a 5.5.x file, only a leading one in 7.0", () => {
    const body = ["0 @I1@ INDI", "1 EMAIL ana@@example.si", "1 NOTE @@a", "2 CONT b@@c", "0 TRLR", ""];
    const v551 = parseGedcom(toBuffer(["0 HEAD", "1 GEDC", "2 FORM LINEAGE-LINKED", "2 VERS 5.5.1", ...body].join("\n")));
    const v7 = parseGedcom(toBuffer(["0 HEAD", "1 GEDC", "2 VERS 7.0", ...body].join("\n")));
    const undeclared = parseGedcom(toBuffer(["0 HEAD", ...body].join("\n")));
    const vals = (r: typeof v551) => r.records[1].children.map((c) => c.value);
    expect(vals(v551)).toEqual(["ana@example.si", "@a\nb@c"]);
    expect(vals(undeclared)).toEqual(["ana@example.si", "@a\nb@c"]);
    expect(vals(v7)).toEqual(["ana@@example.si", "@a\nb@@c"]);
  });

  it("reads the declared version off the header text", () => {
    expect(declaredVersion("0 HEAD\r\n1 GEDC\r\n2 FORM LINEAGE-LINKED\r\n2 VERS 5.5.5\r\n")).toBe("5.5.5");
    expect(declaredVersion("0 HEAD\n1 SOUR X\n2 VERS 3.1\n1 GEDC\n2 VERS 7.0\n")).toBe("7.0");
    expect(declaredVersion("0 HEAD\n1 SOUR X\n2 VERS 3.1\n")).toBeUndefined();
  });

  it("accepts indented lines, as 5.5.1 asks readers to", () => {
    const text = ["0 HEAD", "0 @I1@ INDI", "  1 NAME Bo /Kos/", "    2 GIVN Bo", "0 TRLR", ""].join("\n");
    const parsed = parseGedcom(toBuffer(text));
    expect(parsed.warnings.filter((w) => w.kind === "syntax")).toEqual([]);
    const indi = parsed.records.find((r) => r.xref === "@I1@")!;
    const name = indi.children.find((c) => c.tag === "NAME")!;
    expect(name.value).toBe("Bo /Kos/");
    expect(name.children[0]?.value).toBe("Bo");
  });

  it("remembers a UTF-8 byte-order mark, and the download writes it back", () => {
    const text = "﻿0 HEAD\n1 CHAR UTF-8\n0 TRLR\n";
    const parsed = parseGedcom(toBuffer(text));
    expect(parsed.bom).toBe(true);
    expect(parsed.records[0].tag).toBe("HEAD");
    const ds = buildDataset(parsed);
    expect(serializeGedcom(ds.records, downloadOptions(ds))).toBe(text);
    expect(parseGedcom(toBuffer("0 HEAD\n0 TRLR\n")).bom).toBeUndefined();
  });

  it("applies an ANSEL combining mark to the special letter that follows it", () => {
    // 0xE2 (acute) precedes 0xB2 (ø): ǿ. The mark used to be dropped here and
    // leak onto the next plain letter instead.
    const enc = (s: string) => [...new TextEncoder().encode(s)];
    const bytes = new Uint8Array([
      ...enc("0 HEAD\n1 CHAR ANSEL\n0 @I1@ INDI\n1 NAME "), 0xe2, 0xb2, ...enc("re /Kos/\n0 TRLR\n"),
    ]);
    const parsed = parseGedcom(bytes.buffer as ArrayBuffer);
    const name = parsed.records[1].children.find((c) => c.tag === "NAME")?.value;
    expect(name?.normalize("NFC")).toBe("ǿre /Kos/");
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

describe("parseGedcom version detection", () => {
  it("reads GEDCOM 5.5.5 as the 5.5.1 family", () => {
    const parsed = parseGedcom(toBuffer("0 HEAD\n1 GEDC\n2 VERS 5.5.5\n0 TRLR\n"));
    expect(parsed.version).toBe("5.5.1");
    expect(parsed.warnings.some((w) => w.kind === "version")).toBe(false);
  });
});

describe("parseGedcom keeps a tag's own spelling", () => {
  const src = "0 HEAD\n1 GEDC\n2 VERS 5.5.1\n0 @I1@ INDI\n1 Name Jo /X/\n1 _myTag val\n2 _Sub x\n0 TRLR\n";

  it("matches tags case-insensitively but writes them back as written", () => {
    const parsed = parseGedcom(toBuffer(src));
    const indi = parsed.records[1];
    expect(indi.children.map((c) => c.tag)).toEqual(["NAME", "_MYTAG"]);
    expect(serializeGedcom(parsed.records)).toBe(src);
    expect(serializeGedcom(parsed.records.map(cloneNode))).toBe(src);
  });

  it("drops the spelling once the tag itself is changed", () => {
    const parsed = parseGedcom(toBuffer(src));
    parsed.records[1].children[1].tag = "_OTHER";
    expect(serializeGedcom(parsed.records)).toContain("1 _OTHER val\n");
  });
});

describe("parseGedcom refuses what is not a GEDCOM file", () => {
  const bytes = (s: string) => new TextEncoder().encode(s).buffer;

  it("throws NOT_GEDCOM for an empty file", () => {
    expect(() => parseGedcom(bytes(""))).toThrow(NOT_GEDCOM);
  });

  it("throws NOT_GEDCOM for a text with no header and no records", () => {
    expect(() => parseGedcom(bytes("<!doctype html><html><body>Not found</body></html>\n"))).toThrow(NOT_GEDCOM);
  });

  it("throws NOT_GEDCOM for binary junk", () => {
    const junk = new Uint8Array(4096);
    for (let i = 0; i < junk.length; i++) junk[i] = (i * 7919 + 13) & 0xff;
    expect(() => parseGedcom(junk.buffer)).toThrow(NOT_GEDCOM);
  });

  it("accepts a header-only file (a new, empty tree) and a bare record fragment", () => {
    expect(parseGedcom(bytes("0 HEAD\n1 GEDC\n2 VERS 5.5.1\n0 TRLR\n")).records).toHaveLength(2);
    expect(parseGedcom(bytes("0 @S1@ SOUR\n1 TITL Book\n")).records).toHaveLength(1);
  });
});

describe("parseGedcom on a file split in pieces", () => {
  const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
  // Several megabytes, so the text is split a piece at a time; the notes'
  // continuation lines and an unparsable line straddle the pieces' seams.
  const big = (eol: string, finalNewline: boolean) => {
    const lines = ["0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8"];
    for (let i = 1; i <= 60000; i++) {
      lines.push(`0 @I${i}@ INDI`, `1 NAME Oseba${i} /Novak/`);
      if (i % 9999 === 0) lines.push("prosta vrstica brez oznake");
      lines.push(`1 NOTE Prva vrstica ${i}`, "2 CONT druga vrstica", "2 CONC  in konec");
    }
    lines.push("0 TRLR");
    return lines.join(eol) + (finalNewline ? eol : "");
  };

  it("reads every line as one piece would, line numbers included", () => {
    for (const [eol, finalNewline] of [["\r\n", true], ["\n", false], ["\r", true]] as const) {
      const text = big(eol, finalNewline);
      const parsed = parseGedcom(bytes(text));
      expect(parsed.records).toHaveLength(60002);
      expect(parsed.eol).toBe(eol);
      // Compared as a boolean: a failing diff of megabytes takes minutes to print.
      expect(serializeGedcom(parsed.records, downloadOptions(parsed)) === text).toBe(true);
      expect(parsed.warnings.map((w) => w.line)).toEqual(
        [...text.split(/\r\n?|\n/).entries()].filter(([, l]) => l.startsWith("prosta")).map(([i]) => i + 1),
      );
    }
    // Three multi-megabyte files parsed and written: on a machine busy with
    // other suites this outlasts the 5 s default without anything being wrong.
  }, 60_000);
});
