import { describe, expect, it } from "vitest";
import { buildDataset } from "../builder";
import { parseGedcom } from "../parser";
import { noteCtx } from "./notes";
import { preferredFsIdTag, recordLinkTag, setFamilyLinks, setFamilyNotes, setIndividualLinks, setNotes } from "./records";

describe("recordLinkTag — a link on a person or family record", () => {
  it("never writes WWW on a record in a strict target format", () => {
    const ds = dataset(wrap("0 @I1@ INDI\n1 NAME A /B/\n1 WWW https://old.example\n"));
    const indi = ds.individuals.get("@I1@")!;
    expect(recordLinkTag(ds.records, indi.raw, { standard: "5.5.1" })).toBe("_URL");
  });

  it("keeps the record's own tag, else the file's, in the file's own format", () => {
    const ds = dataset(wrap(
      "0 @I1@ INDI\n1 NAME A /B/\n1 _LINK https://own.example\n" +
      "0 @I2@ INDI\n1 NAME C /D/\n" +
      "0 @I3@ INDI\n1 NAME E /F/\n1 WWW https://a.example\n" +
      "0 @I4@ INDI\n1 NAME G /H/\n1 WWW https://b.example\n",
    ));
    expect(recordLinkTag(ds.records, ds.individuals.get("@I1@")!.raw)).toBe("_LINK");
    expect(recordLinkTag(ds.records, ds.individuals.get("@I2@")!.raw)).toBe("WWW");
  });

  it("writes the extension where the file has no habit", () => {
    const ds = dataset(wrap("0 @I1@ INDI\n1 NAME A /B/\n1 BIRT\n2 WWW https://event.example\n"));
    expect(recordLinkTag(ds.records, ds.individuals.get("@I1@")!.raw)).toBe("_URL");
  });
});

describe("preferredFsIdTag", () => {
  const fs = (vers: string, line: string) =>
    dataset(`0 HEAD\n1 GEDC\n2 VERS ${vers}\n0 @I1@ INDI\n1 NAME A /B/\n${line}0 TRLR\n`);

  it("writes the standard EXID in a strict 7.0 target, whatever the file used", () => {
    expect(preferredFsIdTag(fs("7.0", "1 _FID KWZ1-ABC\n"), { standard: "7.0" })).toBe("EXID");
  });

  it("never writes EXID in a strict 5.5.1 target, which has none", () => {
    expect(preferredFsIdTag(fs("5.5.1", "1 _FID KWZ1-ABC\n"), { standard: "5.5.1" })).toBe("_FID");
    const exid = "1 EXID KWZ1-ABC\n2 TYPE https://www.familysearch.org/tree/person/\n";
    expect(preferredFsIdTag(fs("7.0", exid), { standard: "5.5.1" })).toBe("_FSFTID");
  });

  it("follows the file's own tag in its own format", () => {
    expect(preferredFsIdTag(fs("7.0", "1 _FID KWZ1-ABC\n"))).toBe("_FID");
  });
});

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;

const tagsOf = (node: { children: { tag: string }[] }) => node.children.map((c) => c.tag);
const linkValues = (node: { children: { tag: string; value?: string }[] }) =>
  node.children.filter((c) => ["WWW", "URL", "_URL", "_WEBTAG"].includes(c.tag)).map((c) => c.value);

describe("setIndividualLinks", () => {
  const build = () =>
    dataset(wrap("0 @I1@ INDI\n1 NAME A /B/\n1 WWW https://old.example\n1 BIRT\n2 DATE 1900\n"));

  it("replaces the existing links with the given ones", () => {
    const ds = build();
    const indi = ds.individuals.get("@I1@")!;
    setIndividualLinks(indi, ["https://new.example"], "WWW");

    expect(linkValues(indi.raw)).toEqual(["https://new.example"]);
  });

  it("clears every link dialect, not just WWW", () => {
    const ds = dataset(
      wrap("0 @I1@ INDI\n1 NAME A /B/\n1 WWW a\n1 URL b\n1 _URL c\n1 _WEBTAG\n2 URL d\n"),
    );
    const indi = ds.individuals.get("@I1@")!;
    setIndividualLinks(indi, [], "WWW");

    expect(linkValues(indi.raw)).toEqual([]);
    expect(tagsOf(indi.raw)).toEqual(["NAME"]);
  });

  it("writes new links as plain WWW lines", () => {
    const ds = build();
    const indi = ds.individuals.get("@I1@")!;
    setIndividualLinks(indi, ["https://a.example", "https://b.example"], "WWW");

    const www = indi.raw.children.filter((c) => c.tag === "WWW");
    expect(www.map((c) => c.value)).toEqual(["https://a.example", "https://b.example"]);
  });

  it("trims each link and drops blank entries", () => {
    const ds = build();
    const indi = ds.individuals.get("@I1@")!;
    setIndividualLinks(indi, ["  https://a.example  ", "", "   "], "WWW");

    expect(linkValues(indi.raw)).toEqual(["https://a.example"]);
  });

  it("leaves non-link children in place", () => {
    const ds = build();
    const indi = ds.individuals.get("@I1@")!;
    setIndividualLinks(indi, ["https://new.example"], "WWW");

    expect(tagsOf(indi.raw)).toContain("NAME");
    expect(tagsOf(indi.raw)).toContain("BIRT");
  });

  it("inserts links in canonical order, after the events rather than at the end of nothing", () => {
    const ds = build();
    const indi = ds.individuals.get("@I1@")!;
    setIndividualLinks(indi, ["https://new.example"], "WWW");

    const tags = tagsOf(indi.raw);
    expect(tags.indexOf("WWW")).toBeGreaterThan(tags.indexOf("BIRT"));
  });

  it("nests the link one level below the record", () => {
    const ds = build();
    const indi = ds.individuals.get("@I1@")!;
    setIndividualLinks(indi, ["https://new.example"], "WWW");

    const www = indi.raw.children.find((c) => c.tag === "WWW")!;
    expect(www.level).toBe(indi.raw.level + 1);
  });
});

describe("setFamilyLinks", () => {
  const build = () =>
    dataset(wrap("0 @F1@ FAM\n1 HUSB @I1@\n1 WWW https://old.example\n1 MARR\n2 DATE 1920\n"));

  it("replaces the existing links", () => {
    const ds = build();
    const fam = ds.families.get("@F1@")!;
    setFamilyLinks(fam, ["https://new.example"], "WWW");

    expect(linkValues(fam.raw)).toEqual(["https://new.example"]);
  });

  it("trims and drops blanks", () => {
    const ds = build();
    const fam = ds.families.get("@F1@")!;
    setFamilyLinks(fam, [" https://a.example ", "  "], "WWW");

    expect(linkValues(fam.raw)).toEqual(["https://a.example"]);
  });

  it("keeps the family's own structure", () => {
    const ds = build();
    const fam = ds.families.get("@F1@")!;
    setFamilyLinks(fam, [], "WWW");

    expect(tagsOf(fam.raw)).toEqual(["HUSB", "MARR"]);
  });

  it("inserts after the family events, per FAM_CHILD_ORDER", () => {
    const ds = build();
    const fam = ds.families.get("@F1@")!;
    setFamilyLinks(fam, ["https://new.example"], "WWW");

    const tags = tagsOf(fam.raw);
    expect(tags.indexOf("WWW")).toBeGreaterThan(tags.indexOf("MARR"));
  });
});

describe("setNotes / setFamilyNotes", () => {
  it("replaces an individual's inline notes", () => {
    const ds = dataset(wrap("0 @I1@ INDI\n1 NAME A /B/\n1 NOTE old\n"));
    const indi = ds.individuals.get("@I1@")!;
    setNotes(noteCtx(ds.records), indi, [{ text: "new" }]);

    const notes = indi.raw.children.filter((c) => c.tag === "NOTE");
    expect(notes.map((n) => n.value)).toEqual(["new"]);
  });

  it("clears an individual's notes when given none", () => {
    const ds = dataset(wrap("0 @I1@ INDI\n1 NAME A /B/\n1 NOTE old\n"));
    const indi = ds.individuals.get("@I1@")!;
    setNotes(noteCtx(ds.records), indi, []);

    expect(tagsOf(indi.raw)).toEqual(["NAME"]);
  });

  it("writes several notes in order", () => {
    const ds = dataset(wrap("0 @I1@ INDI\n1 NAME A /B/\n"));
    const indi = ds.individuals.get("@I1@")!;
    setNotes(noteCtx(ds.records), indi, [{ text: "one" }, { text: "two" }]);

    expect(indi.raw.children.filter((c) => c.tag === "NOTE").map((n) => n.value)).toEqual(["one", "two"]);
  });

  it("replaces a family's notes", () => {
    const ds = dataset(wrap("0 @F1@ FAM\n1 HUSB @I1@\n1 NOTE old\n"));
    const fam = ds.families.get("@F1@")!;
    setFamilyNotes(noteCtx(ds.records), fam, [{ text: "new" }]);

    expect(fam.raw.children.filter((c) => c.tag === "NOTE").map((n) => n.value)).toEqual(["new"]);
  });

  it("keeps a shared-note pointer as a pointer rather than inlining its text", () => {
    const ds = dataset(
      wrap("0 @I1@ INDI\n1 NAME A /B/\n1 NOTE @N1@\n0 @N1@ NOTE shared text\n"),
    );
    const indi = ds.individuals.get("@I1@")!;
    const ctx = noteCtx(ds.records);
    setNotes(ctx, indi, [{ xref: "@N1@", text: "shared text" }]);

    const note = indi.raw.children.find((c) => c.tag === "NOTE")!;
    expect(note.value).toBe("@N1@");
  });
});
