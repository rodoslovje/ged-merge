import { describe, expect, it } from "vitest";
import { parseGedcom } from "./parser";
import { buildDataset } from "./builder";
import { buildObjeIndex, cropOf, findExistingSource, inferSourceFormat, objeInfoOf, objeNodesFor } from "./source";
import type { GedNode } from "./types";

function buildFromText(text: string) {
  const buf = new TextEncoder().encode(text);
  const parsed = parseGedcom(buf.buffer);
  return buildDataset(parsed);
}

describe("resolveSourceCitation via buildDataset", () => {
  it("matches the cited page by the ?pg= query param among several OBJE images", () => {
    const text = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 NAME Test /Person/
1 BIRT
2 SOUR @S1@
3 PAGE 56
0 @S1@ SOUR
1 TITL Krstna knjiga - Šenčur
1 AGNC Nadškofijski arhiv Ljubljana
1 FILN 03173
1 OBJE @O1@
1 OBJE @O2@
0 @O1@ OBJE
1 FILE https://data.matricula-online.eu/sl/slovenia/ljubljana/sencur/03173/?pg=42
0 @O2@ OBJE
1 FILE https://data.matricula-online.eu/sl/slovenia/ljubljana/sencur/03173/?pg=56
0 TRLR
`;
    const ds = buildFromText(text);
    const indi = ds.individuals.get("@I1@")!;
    const sources = indi.events[0].sources;
    expect(sources).toHaveLength(1);
    expect(sources![0]).toMatchObject({
      sourceId: "@S1@",
      title: "Krstna knjiga - Šenčur",
      agency: "Nadškofijski arhiv Ljubljana",
      filingNumber: "03173",
      page: "56",
      url: "https://data.matricula-online.eu/sl/slovenia/ljubljana/sencur/03173/?pg=56",
      exact: true,
    });
  });

  it("matches the cited page by a #NNN marker in the OBJE title when there is no ?pg= param", () => {
    const text = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 NAME Test /Person/
1 BIRT
2 SOUR @S1@
3 PAGE 41
0 @S1@ SOUR
1 TITL Births, Ravna Gora
1 OBJE @O1@
1 OBJE @O2@
0 @O1@ OBJE
1 FILE 2150826.jpg
2 TITL Rački - Ravna Gora 174
0 @O2@ OBJE
1 FILE https://www.familysearch.org/ark:/61903/3:1:abc
2 TITL #041 - Births, Ravna Gora
0 TRLR
`;
    const ds = buildFromText(text);
    const indi = ds.individuals.get("@I1@")!;
    const sources = indi.events[0].sources!;
    expect(sources[0]).toMatchObject({
      url: "https://www.familysearch.org/ark:/61903/3:1:abc",
      exact: true,
    });
  });

  it("falls back to the source's lone image when there is no page to disambiguate", () => {
    const text = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 NAME Test /Person/
1 DEAT
2 SOUR @S1@
0 @S1@ SOUR
1 TITL Death record
1 OBJE @O1@
0 @O1@ OBJE
1 FILE https://example.com/death.jpg
0 TRLR
`;
    const ds = buildFromText(text);
    const indi = ds.individuals.get("@I1@")!;
    const sources = indi.events[0].sources!;
    expect(sources[0]).toMatchObject({
      url: "https://example.com/death.jpg",
      exact: true,
    });
    expect(sources[0].page).toBeUndefined();
  });

  it("ignores a local-filename OBJE (no real URL) and picks the one real media link", () => {
    // MacFamilyTree periodical sources often carry two OBJE: a locally cached
    // copy (bare filename, also referenced directly on the event) and the real
    // article URL. Only the latter is a usable link.
    const text = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 NAME Test /Person/
1 OCCU Farmer
2 DATE 1934
2 SOUR @S1@
3 PAGE 5
2 OBJE @OLOCAL@
0 @S1@ SOUR
1 PERI Kmetski list, 4 Apr 1934
1 OBJE @OLOCAL@
1 OBJE @OREAL@
1 REPO @R1@
0 @OLOCAL@ OBJE
1 FILE 14698248.jpg
2 TITL Kmetski list - Renko
0 @OREAL@ OBJE
1 FILE https://dlib.si/details/URN:NBN:SI:DOC-BFIH3O16
2 TITL dLib.si - Kmetski list
0 @R1@ REPO
1 NAME Publikacije - dLib.si
1 WWW https://dlib.si/Publications.aspx
0 TRLR
`;
    const ds = buildFromText(text);
    const indi = ds.individuals.get("@I1@")!;
    const sources = indi.events[0].sources!;
    expect(sources[0]).toMatchObject({
      url: "https://dlib.si/details/URN:NBN:SI:DOC-BFIH3O16",
      exact: true,
    });
  });

  it("falls back to the repository website when the source has no media", () => {
    const text = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 NAME Test /Person/
1 BIRT
2 SOUR @S1@
0 @S1@ SOUR
1 TITL U.S. Census 1900
1 AUTH Ancestry.com
1 PUBL Ancestry.com Operations, Inc.
1 REPO @R1@
0 @R1@ REPO
1 NAME Ancestry.com
1 WWW https://www.ancestry.com/
0 TRLR
`;
    const ds = buildFromText(text);
    const indi = ds.individuals.get("@I1@")!;
    const sources = indi.events[0].sources!;
    expect(sources[0]).toMatchObject({
      title: "U.S. Census 1900",
      url: "https://www.ancestry.com/",
      exact: false,
    });
  });

  it("uses an AUTH/PUBL fallback title when there is no TITL", () => {
    const text = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 NAME Test /Person/
1 BIRT
2 SOUR @S1@
0 @S1@ SOUR
1 AUTH Jane Smith
1 PUBL Self-published, 2020
0 TRLR
`;
    const ds = buildFromText(text);
    const indi = ds.individuals.get("@I1@")!;
    const sources = indi.events[0].sources!;
    expect(sources[0].title).toBe("Jane Smith, Self-published, 2020");
    expect(sources[0].url).toBeUndefined();
    expect(sources[0].exact).toBe(false);
  });

  it("prefers ABBR over an AUTH/PUBL fallback when there is no TITL", () => {
    // Some files (e.g. Modrijan.ged) use AUTH for the record's compiler, not
    // the source itself, with the actual archive reference held in ABBR.
    const text = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 NAME Test /Person/
1 BIRT
2 SOUR @S1@
0 @S1@ SOUR
1 AUTH Janez Modrijan
1 ABBR NŠAL Rovte P 1816 - 1889
1 REPO @R1@
0 @R1@ REPO
1 NAME NŠAL
0 TRLR
`;
    const ds = buildFromText(text);
    const indi = ds.individuals.get("@I1@")!;
    const sources = indi.events[0].sources!;
    expect(sources[0].title).toBe("NŠAL Rovte P 1816 - 1889");
    expect(sources[0].url).toBeUndefined();
  });

  it("treats a citation with a non-pointer value as inline free text", () => {
    const text = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 NAME Test /Person/
1 BIRT
2 SOUR Family bible, kept by Smith family
0 TRLR
`;
    const ds = buildFromText(text);
    const indi = ds.individuals.get("@I1@")!;
    const sources = indi.events[0].sources!;
    expect(sources[0]).toMatchObject({
      sourceId: "Family bible, kept by Smith family",
      title: "Family bible, kept by Smith family",
      exact: false,
    });
    expect(sources[0].url).toBeUndefined();
  });

  it("surfaces a dangling SOUR pointer with no matching record gracefully", () => {
    const text = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 NAME Test /Person/
1 BIRT
2 SOUR @S404@
3 PAGE 12
0 TRLR
`;
    const ds = buildFromText(text);
    const indi = ds.individuals.get("@I1@")!;
    const sources = indi.events[0].sources!;
    expect(sources[0]).toMatchObject({ sourceId: "@S404@", page: "12", exact: false });
    expect(sources[0].url).toBeUndefined();
  });

  it("attaches citations on family (MARR) events too", () => {
    const text = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 NAME H /H/
1 FAMS @F1@
0 @I2@ INDI
1 NAME W /W/
1 FAMS @F1@
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 MARR
2 SOUR @S1@
3 PAGE 5
0 @S1@ SOUR
1 TITL Marriage register
1 OBJE @O1@
0 @O1@ OBJE
1 FILE https://example.com/marriages/?pg=5
0 TRLR
`;
    const ds = buildFromText(text);
    const fam = ds.families.get("@F1@")!;
    const marr = fam.events.find((e) => e.tag === "MARR")!;
    expect(marr.sources![0]).toMatchObject({ url: "https://example.com/marriages/?pg=5", exact: true });
  });
});

describe("inferSourceFormat", () => {
  it("detects a paginated archive-scan convention", () => {
    const text = `0 HEAD
0 @S1@ SOUR
1 TITL Book A
1 OBJE @O1@
1 OBJE @O2@
0 @S2@ SOUR
1 TITL Book B
1 OBJE @O3@
1 OBJE @O4@
0 @O1@ OBJE
1 FILE https://example.com/a/?pg=1
0 @O2@ OBJE
1 FILE https://example.com/a/?pg=2
0 @O3@ OBJE
1 FILE https://example.com/b/?pg=1
0 @O4@ OBJE
1 FILE https://example.com/b/?pg=2
0 TRLR
`;
    const buf = new TextEncoder().encode(text);
    const ds = buildDataset(parseGedcom(buf.buffer));
    expect(inferSourceFormat(ds.records).layout).toBe("paginated");
  });

  it("classifies a single real page link as paginated (local filenames still don't count)", () => {
    const text = `0 HEAD
0 @S1@ SOUR
1 PERI Kmetski list, 4 Apr 1934
1 OBJE @O1@
1 OBJE @O2@
1 REPO @R1@
0 @O1@ OBJE
1 FILE 12345.jpg
0 @O2@ OBJE
1 FILE https://dlib.si/details/URN:NBN:SI:DOC-ABC
0 @R1@ REPO
1 NAME dLib.si
1 WWW https://dlib.si/
0 TRLR
`;
    const buf = new TextEncoder().encode(text);
    const ds = buildDataset(parseGedcom(buf.buffer));
    // ONE real-URL OBJE is already the page-link shape (the local filename
    // doesn't count) — the REPO link no longer outranks it.
    expect(inferSourceFormat(ds.records).layout).toBe("paginated");
  });

  it("detects a repository convention when sources link out with no page media", () => {
    const text = `0 HEAD
0 @S1@ SOUR
1 TITL DB A
1 REPO @R1@
0 @S2@ SOUR
1 TITL DB B
1 REPO @R1@
0 @R1@ REPO
1 NAME Ancestry.com
1 WWW https://www.ancestry.com/
0 TRLR
`;
    const buf = new TextEncoder().encode(text);
    const ds = buildDataset(parseGedcom(buf.buffer));
    expect(inferSourceFormat(ds.records).layout).toBe("repository");
  });

  it("detects an inline convention when citations are mostly free text", () => {
    const text = `0 HEAD
0 @I1@ INDI
1 BIRT
2 SOUR Family bible
1 DEAT
2 SOUR Town records, as told by aunt
0 TRLR
`;
    const buf = new TextEncoder().encode(text);
    const ds = buildDataset(parseGedcom(buf.buffer));
    expect(inferSourceFormat(ds.records).layout).toBe("inline");
  });

  it("reports unknown when there is no source signal at all", () => {
    const text = `0 HEAD
0 @I1@ INDI
1 NAME Test /Person/
0 TRLR
`;
    const buf = new TextEncoder().encode(text);
    const ds = buildDataset(parseGedcom(buf.buffer));
    expect(inferSourceFormat(ds.records).layout).toBe("unknown");
  });
});

describe("findExistingSource", () => {
  const text = `0 HEAD
0 @I1@ INDI
1 NAME Test /Person/
1 BIRT
2 SOUR @S1@
3 PAGE 56
0 @S1@ SOUR
1 TITL Krstna knjiga - Šenčur
1 OBJE @O1@
0 @O1@ OBJE
1 FILE https://data.matricula-online.eu/sl/slovenia/ljubljana/sencur/03173/?pg=56
0 TRLR
`;

  it("finds an exact match (mod language/case/slash) and returns its OBJE xref", () => {
    const ds = buildFromText(text);
    const match = findExistingSource(ds.records, "HTTPS://data.matricula-online.eu/de/slovenia/ljubljana/sencur/03173/?pg=56/");
    expect(match).toEqual({ sourceXref: "@S1@", objeXref: "@O1@", page: "56" });
  });

  it("finds a same-book match for a different page, without an OBJE xref", () => {
    const ds = buildFromText(text);
    const match = findExistingSource(ds.records, "https://data.matricula-online.eu/de/slovenia/ljubljana/sencur/03173/?pg=58");
    expect(match).toEqual({ sourceXref: "@S1@", objeXref: undefined, page: "58" });
  });

  it("returns undefined for an unrelated URL", () => {
    const ds = buildFromText(text);
    const match = findExistingSource(ds.records, "https://www.sistory.si/ww2/5046DECC-E88C-4EA6-8B61-82D7A78C8626");
    expect(match).toBeUndefined();
  });
});

describe("objeInfoOf", () => {
  const text = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @LOCAL@ OBJE
1 FILE 12345.jpg
2 TITL Nested Title
1 DATE 1 JAN 1900
1 PLAC Kranj, Slovenia
1 _DSCR A photo of the family
0 @RECTITLE@ OBJE
1 FILE sub/photo2.jpg
1 TITL Record Title
1 NOTE A note used as description
0 @URL@ OBJE
1 FILE https://data.matricula-online.eu/sl/x/?pg=42
1 TITL Scan
0 @NOFILE@ OBJE
1 TITL Has no file
0 TRLR
`;
  const objeBy = (records: GedNode[]) => {
    const map = new Map<string, GedNode>();
    for (const r of records) if (r.tag === "OBJE" && r.xref) map.set(r.xref, r);
    return map;
  };

  it("reads a local file plus its descriptive content fields", () => {
    const ds = buildFromText(text);
    const info = objeInfoOf(objeBy(ds.records).get("@LOCAL@")!);
    expect(info).toEqual({
      file: "12345.jpg",
      url: undefined,
      title: "Nested Title",
      date: "1 JAN 1900",
      place: "Kranj, Slovenia",
      description: "A photo of the family",
    });
  });

  it("sets url (equal to file) only when the FILE value is an absolute URL", () => {
    const ds = buildFromText(text);
    const info = objeInfoOf(objeBy(ds.records).get("@URL@")!);
    expect(info.url).toBe("https://data.matricula-online.eu/sl/x/?pg=42");
    expect(info.file).toBe(info.url);
  });

  it("prefers a TITL nested under FILE, else falls back to the record-level TITL", () => {
    const ds = buildFromText(text);
    const by = objeBy(ds.records);
    expect(objeInfoOf(by.get("@LOCAL@")!).title).toBe("Nested Title");
    expect(objeInfoOf(by.get("@RECTITLE@")!).title).toBe("Record Title");
  });

  it("falls back to NOTE for the description when there is no _DSCR", () => {
    const ds = buildFromText(text);
    expect(objeInfoOf(objeBy(ds.records).get("@RECTITLE@")!).description).toBe("A note used as description");
  });

  it("leaves file and url undefined when the OBJE has no FILE", () => {
    const ds = buildFromText(text);
    const info = objeInfoOf(objeBy(ds.records).get("@NOFILE@")!);
    expect(info.file).toBeUndefined();
    expect(info.url).toBeUndefined();
    expect(info.title).toBe("Has no file");
  });

  it("buildObjeIndex maps every top-level OBJE xref via objeInfoOf", () => {
    const ds = buildFromText(text);
    const index = buildObjeIndex(ds.records);
    expect([...index.keys()].sort()).toEqual(["@LOCAL@", "@NOFILE@", "@RECTITLE@", "@URL@"]);
    expect(index.get("@LOCAL@")).toEqual(objeInfoOf(objeBy(ds.records).get("@LOCAL@")!));
  });
});

describe("objeNodesFor", () => {
  const text = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 NAME Test /Person/
0 @O1@ OBJE
1 FILE a.jpg
0 @O2@ OBJE
1 FILE b.jpg
0 TRLR
`;

  it("indexes only top-level OBJE records by xref", () => {
    const ds = buildFromText(text);
    const map = objeNodesFor(ds.records);
    expect([...map.keys()].sort()).toEqual(["@O1@", "@O2@"]);
    expect(map.get("@O1@")!.children.find((c) => c.tag === "FILE")?.value).toBe("a.jpg");
  });

  it("caches per records-array reference (same array → same map)", () => {
    const ds = buildFromText(text);
    expect(objeNodesFor(ds.records)).toBe(objeNodesFor(ds.records));
  });
});

describe("cropOf", () => {
  // The crop lives on the OBJE *link* node (a `1 OBJE @x@` child of the INDI),
  // not on the shared media record — two people crop the same photo differently.
  function indiLink(text: string): GedNode {
    const ds = buildFromText(text);
    const indi = ds.records.find((r) => r.tag === "INDI")!;
    return indi.children.find((c) => c.tag === "OBJE")!;
  }

  it("reads a full crop region from a link node", () => {
    const link = indiLink(`0 HEAD
0 @I1@ INDI
1 OBJE @O1@
2 CROP
3 TOP 1187
3 LEFT 1138
3 HEIGHT 233
3 WIDTH 412
0 @O1@ OBJE
1 FILE group.jpg
0 TRLR
`);
    expect(cropOf(link)).toEqual({ top: 1187, left: 1138, height: 233, width: 412 });
  });

  it("defaults missing TOP/LEFT to 0", () => {
    const link = indiLink(`0 HEAD
0 @I1@ INDI
1 OBJE @O1@
2 CROP
3 HEIGHT 233
3 WIDTH 412
0 @O1@ OBJE
1 FILE group.jpg
0 TRLR
`);
    expect(cropOf(link)).toEqual({ top: 0, left: 0, height: 233, width: 412 });
  });

  it("returns undefined without a CROP or without usable width/height", () => {
    const noCrop = indiLink(`0 HEAD
0 @I1@ INDI
1 OBJE @O1@
0 @O1@ OBJE
1 FILE group.jpg
0 TRLR
`);
    expect(cropOf(noCrop)).toBeUndefined();

    const noSize = indiLink(`0 HEAD
0 @I1@ INDI
1 OBJE @O1@
2 CROP
3 TOP 10
3 LEFT 10
0 @O1@ OBJE
1 FILE group.jpg
0 TRLR
`);
    expect(cropOf(noSize)).toBeUndefined();
  });
});
