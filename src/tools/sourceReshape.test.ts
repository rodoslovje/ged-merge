import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import type { ReshapeSite } from "./sourceReshape";
import {
  classifyBookType,
  fetchReshapeMeta,
  findReshapableLinks,
  parseFamilySearchUrl,
  parseGeneanetCemeteryPage,
  parseMatriculaBookPage,
  parseMatriculaTitle,
  parseMatriculaUrl,
  reshapeSources,
} from "./sourceReshape";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

const BOOK = "https://data.matricula-online.eu/sl/slovenia/maribor/sentjur-pri-celju/03869";
const BOOK2 = "https://data.matricula-online.eu/sl/slovenia/ljubljana/vodice/04406";

/** Scan with defaults; `sites` may widen/narrow the categories. */
function scan(text: string, sites?: ReshapeSite[]) {
  return findReshapableLinks(dataset(text), sites ? new Set(sites) : undefined);
}

/** Run the full pipeline (all groups selected) and return the serialized output. */
function applyAll(text: string, opts?: { relocate?: boolean; quay?: string }) {
  const ds = dataset(text);
  const report = findReshapableLinks(ds, undefined, opts);
  const groups = report.groups.map((g) => (opts?.quay ? { ...g, quay: opts.quay } : g));
  const { records, counts } = reshapeSources(ds.records, groups, undefined, opts);
  return { text: serializeGedcom(records), records, counts, report };
}

describe("URL parsers", () => {
  it("parses a Matricula book URL with page", () => {
    expect(parseMatriculaUrl(`${BOOK}/?pg=215`)).toEqual({
      lang: "sl",
      country: "slovenia",
      archiveSlug: "maribor",
      parishSlug: "sentjur-pri-celju",
      bookId: "03869",
      page: "215",
    });
  });

  it("decodes double-percent-encoded Koper signatures", () => {
    const url = "https://data.matricula-online.eu/sl/slovenia/koper/Kubed/%25C5%25A0AK+%25C5%25BD+Kub+MKK+6/?pg=19";
    expect(parseMatriculaUrl(url)?.bookId).toBe("ŠAK Ž Kub MKK 6");
  });

  it("rejects archive-index URLs (not a 5-segment book path)", () => {
    expect(parseMatriculaUrl("https://data.matricula-online.eu/en/slovenia/ljubljana/")).toBeUndefined();
  });

  it("parses FamilySearch image, record and tree URLs", () => {
    expect(
      parseFamilySearchUrl("https://www.familysearch.org/ark:/61903/3:1:3Q9M-CS2T-N985-8?cat=406380&i=137&lang=en"),
    ).toEqual({ kind: "image", ark: "3:1:3Q9M-CS2T-N985-8", cat: "406380", image: "137" });
    expect(parseFamilySearchUrl("https://familysearch.org/ark:/61903/1:1:XNJ8-FPJ")).toEqual({
      kind: "record",
      ark: "1:1:XNJ8-FPJ",
    });
    expect(parseFamilySearchUrl("https://www.familysearch.org/en/tree/person/details/GPZG-CXL")?.kind).toBe("tree");
    expect(parseFamilySearchUrl("https://example.org/x")).toBeUndefined();
  });
});

describe("classifyBookType", () => {
  it("recognizes Slovenian/German/Latin register names and abbreviations", () => {
    expect(classifyBookType(["Krstna knjiga / Taufbuch"])).toBe("baptism");
    expect(classifyBookType(["Krstni index"])).toBe("baptism");
    expect(classifyBookType(["Poročna knjiga / Trauungsbuch"])).toBe("marriage");
    expect(classifyBookType(["Liber matrimoniorum"])).toBe("marriage");
    expect(classifyBookType(["Matična knjiga umrlih"])).toBe("death");
    expect(classifyBookType(["Sterbebuch"])).toBe("death");
    expect(classifyBookType(["KK"])).toBe("baptism");
    expect(classifyBookType(["PK"])).toBe("marriage");
  });

  it("returns unknown for no signal or conflicting signals", () => {
    expect(classifyBookType([undefined, ""])).toBe("unknown");
    expect(classifyBookType(["Matična knjiga"])).toBe("unknown");
    expect(classifyBookType(["Krstna in mrliška knjiga"])).toBe("unknown");
  });
});

describe("findReshapableLinks — scan", () => {
  it("finds an event-level WWW link with its page and groups by book", () => {
    const report = scan(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ana /Novak/
1 BIRT
2 DATE 1889
2 WWW ${BOOK}/?pg=94
0 TRLR`);
    expect(report.groups).toHaveLength(1);
    const g = report.groups[0];
    expect(g.site).toBe("matricula");
    expect(g.proposed.filingNumber).toBe("03869");
    expect(g.proposed.place).toBe("Sentjur Pri Celju");
    expect(g.pages).toEqual(["94"]);
    expect(g.members[0]).toMatchObject({ shape: "link", eventTag: "BIRT", page: "94", recordTag: "INDI" });
    expect(g.members[0].recordLabel).toContain("Ana");
  });

  it("collects two pages of one book into one group, different books apart", () => {
    const report = scan(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 SOUR ${BOOK}/?pg=94
1 DEAT
2 SOUR ${BOOK}/?pg=215
0 @I2@ INDI
1 BIRT
2 SOUR ${BOOK2}/?pg=3
0 TRLR`);
    expect(report.groups).toHaveLength(2);
    const big = report.groups.find((g) => g.pages.length === 2)!;
    expect(big.pages).toEqual(["94", "215"]);
    expect(big.members).toHaveLength(2);
    expect(report.totalOccurrences).toBe(3);
  });

  it("folds language variants of the same book/grave into one group", () => {
    const report = scan(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NOTE https://de.geneanet.org/friedhof/view/123
1 BIRT
2 SOUR https://data.matricula-online.eu/de/slovenia/maribor/sentjur-pri-celju/03869/?pg=94
2 SOUR ${BOOK}/?pg=94
0 @I2@ INDI
1 NOTE Grob: https://en.geneanet.org/cemetery/view/123/persons/?individu_filter=GRUDNIK%2BAnton
0 TRLR`);
    expect(report.groups).toHaveLength(2);
    const gene = report.groups.find((g) => g.site === "geneanet")!;
    expect(gene.members).toHaveLength(2);
    expect(gene.bookType).toBe("burial");
    expect(gene.proposed.title).toContain("GRUDNIK Anton");
    expect(report.bySite.matricula).toBe(2);
  });

  it("recognizes _WEBTAG, inline SOUR with prefix, and NOTE-embedded URLs", () => {
    const report = scan(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 _WEBTAG
2 NAME Krstna knjiga
2 URL ${BOOK}/?pg=94
1 BIRT
2 SOUR KK ${BOOK}/?pg=95
2 NOTE See the register at ${BOOK}/?pg=96 for details.
0 TRLR`);
    const g = report.groups[0];
    expect(g.members.map((m) => m.shape).sort()).toEqual(["inline", "note", "webtag"].sort());
    const inline = g.members.find((m) => m.shape === "inline")!;
    expect(inline.prefix).toBe("KK");
    expect(g.bookType).toBe("baptism");
  });

  it("reuses an existing paginated SOUR for the same book", () => {
    const report = scan(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 WWW ${BOOK}/?pg=200
0 @S1@ SOUR
1 TITL Krstna knjiga - 03869 | Šentjur
1 OBJE @O1@
0 @O1@ OBJE
1 FILE ${BOOK}/?pg=94
0 TRLR`);
    expect(report.groups[0].existingSourceXref).toBe("@S1@");
    expect(report.groups[0].existingSourceTitle).toContain("Krstna knjiga");
    expect(report.groups[0].bookType).toBe("baptism");
  });

  it("skips OBJE page media already owned by a SOUR, converts free person-level OBJE pointers", () => {
    const report = scan(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 OBJE @O1@
1 OBJE @O2@
0 @S1@ SOUR
1 TITL Book
1 OBJE @O1@
0 @O1@ OBJE
1 FILE ${BOOK}/?pg=94
0 @O2@ OBJE
1 FILE ${BOOK2}/?pg=5
0 TRLR`);
    expect(report.totalOccurrences).toBe(1);
    expect(report.groups[0].members[0]).toMatchObject({ shape: "obje", url: `${BOOK2}/?pg=5` });
  });

  it("finds pageUrl citations and URL-titled SOUR records", () => {
    const report = scan(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 DEAT
2 SOUR @S1@
3 PAGE ${BOOK}/?pg=19
0 @S1@ SOUR
1 TITL Matična knjiga umrlih
0 @S2@ SOUR
1 TITL ${BOOK2}/?pg=6
0 TRLR`);
    expect(report.groups).toHaveLength(2);
    const pageUrl = report.groups.find((g) => g.members[0].shape === "pageUrl")!;
    expect(pageUrl.bookType).toBe("death");
    const sourTitle = report.groups.find((g) => g.members[0].shape === "sourTitle")!;
    expect(sourTitle.existingSourceXref).toBe("@S2@");
  });

  it("groups FamilySearch images by cat and records by quoted collection", () => {
    const report = scan(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 NOTE "Croatia, Church Books, 1516-1994," database with images, FamilySearch (https://familysearch.org/ark:/61903/1:1:XNJ8-FPJ : 2020).
1 DEAT
2 SOUR https://www.familysearch.org/ark:/61903/3:1:3Q9M-CS2T-N985-8?cat=406380&i=137
2 SOUR https://www.familysearch.org/ark:/61903/3:1:3Q9M-CS2T-N9DM-D?cat=406380&i=113
0 TRLR`);
    const fs = report.groups.filter((g) => g.site === "familysearch");
    expect(fs).toHaveLength(2);
    const film = fs.find((g) => g.proposed.filingNumber === "406380")!;
    expect(film.pages).toEqual(["113", "137"]);
    const coll = fs.find((g) => g.proposed.title.startsWith("Croatia"))!;
    expect(coll.members[0].shape).toBe("note");
  });

  it("ignores other hosts unless the 'other' category is enabled", () => {
    const text = `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 SOUR https://www.sistory.si/ww2/ABC
0 TRLR`;
    expect(scan(text).groups).toHaveLength(0);
    const withOther = scan(text, ["matricula", "geneanet", "familysearch", "other"]);
    expect(withOther.groups).toHaveLength(1);
    expect(withOther.groups[0].site).toBe("other");
  });
});

describe("reshapeSources — apply", () => {
  it("creates a paginated SOUR + page OBJE and rewrites the link into a citation", () => {
    const { text, counts } = applyAll(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 DATE 1889
2 WWW ${BOOK}/?pg=94
0 TRLR`);
    expect(text).toContain("0 @S1@ SOUR");
    expect(text).toContain("1 TITL Matricula 03869 | Sentjur Pri Celju");
    expect(text).toContain("1 FILN 03869");
    expect(text).toContain("1 PLAC Sentjur Pri Celju");
    expect(text).toContain(`1 FILE ${BOOK}/?pg=94`);
    expect(text).toContain("TITL #94 - Matricula 03869 | Sentjur Pri Celju");
    expect(text).toContain("2 SOUR @S1@\n3 PAGE 94");
    expect(text).not.toContain("WWW");
    expect(counts).toMatchObject({ sourcesCreated: 1, mediaCreated: 1, citationsAdded: 1, linksRemoved: 1 });
  });

  it("reuses an existing book SOUR: new page adds an OBJE, known page does not", () => {
    const { text, counts } = applyAll(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 WWW ${BOOK}/?pg=94
1 DEAT
2 WWW ${BOOK}/?pg=200
0 @S1@ SOUR
1 TITL Krstna knjiga - 03869
1 OBJE @O1@
0 @O1@ OBJE
1 FILE ${BOOK}/?pg=94
0 TRLR`);
    expect(counts.sourcesCreated).toBe(0);
    expect(counts.sourcesReused).toBe(1);
    expect(counts.mediaCreated).toBe(1); // only pg=200
    expect(text).toContain("2 SOUR @S1@\n3 PAGE 94");
    expect(text).toContain(`1 FILE ${BOOK}/?pg=200`);
  });

  it("keeps a reused source's new page OBJE grouped with the existing ones, ahead of REPO/CHAN", () => {
    const { text } = applyAll(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 WWW ${BOOK}/?pg=200
0 @S1@ SOUR
1 TITL Krstna knjiga - 03869
1 OBJE @O1@
1 REPO @R1@
1 CHAN
2 DATE 01 JAN 2026
0 @O1@ OBJE
1 FILE ${BOOK}/?pg=94
0 @R1@ REPO
1 NAME Arhiv
0 TRLR`);
    expect(text).toMatch(/1 OBJE @O1@\n1 OBJE @O\d+@\n1 REPO @R1@\n1 CHAN/);
  });

  it("preserves note prose around a removed URL, drops URL-only notes", () => {
    const { text, counts } = applyAll(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 NOTE Baptism entry: ${BOOK}/?pg=94 (second column)
1 DEAT
2 NOTE ${BOOK}/?pg=95
0 TRLR`);
    expect(text).toContain("2 NOTE Baptism entry: (second column)");
    expect(text).not.toContain("NOTE http");
    expect(counts.notesRewritten).toBe(1);
    expect(counts.linksRemoved).toBe(1);
  });

  it("converts inline citations in place, preserving prefix and children", () => {
    const { text, counts } = applyAll(
      `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 SOUR KK ${BOOK}/?pg=95
3 QUAY 2
0 TRLR`,
      { quay: "3" },
    );
    expect(text).toContain("2 SOUR @S1@");
    expect(text).toContain("3 PAGE 95");
    expect(text).toContain("3 NOTE KK");
    expect(text).toContain("3 QUAY 2"); // existing QUAY preserved, not overwritten
    expect(text).not.toContain("QUAY 3");
    expect(counts.citationsRewritten).toBe(1);
  });

  it("stamps the selected QUAY on written citations", () => {
    const { text } = applyAll(
      `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 WWW ${BOOK}/?pg=94
0 TRLR`,
      { quay: "3" },
    );
    expect(text).toContain("3 QUAY 3");
  });

  it("folds a record-level attachment into the identical event-level one (file prefers folded)", () => {
    // @I2's event-only link ties the doubling count 1:1 → the file reads as
    // preferring folded links, so @I1's doubled attachment collapses.
    const { text, report, counts } = applyAll(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 DATE 10 NOV 1889
2 OBJE @O1@
1 OBJE @O1@
0 @I2@ INDI
1 DEAT
2 WWW ${BOOK}/?pg=30
0 @O1@ OBJE
1 FILE ${BOOK}/?pg=20
0 TRLR`);
    const group = report.groups[0];
    expect(group.members.find((m) => !m.eventTag)?.foldedInto).toBe("BIRT");
    expect(text).toMatch(/1 BIRT\n2 DATE 10 NOV 1889\n2 SOUR @S1@\n3 PAGE 20/);
    expect(text).not.toMatch(/0 @I1@ INDI\n1 SOUR/);
    const indiBlock = text.split(/^0 /m).find((b) => b.startsWith("@I1@"))!;
    expect(indiBlock).not.toContain("OBJE"); // both person-side pointers gone
    expect(counts.citationsAdded).toBe(2); // @I1 BIRT + @I2 DEAT
  });

  it("keeps both citations in a file that doubles its links", () => {
    // Two of two event links are doubled onto the record → doubling is the
    // house style; the record-level occurrences convert in place, unmoved.
    const { text, report } = applyAll(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 OBJE @O1@
1 OBJE @O1@
0 @I2@ INDI
1 BIRT
2 OBJE @O2@
1 OBJE @O2@
0 @O1@ OBJE
1 FILE ${BOOK}/?pg=20
0 @O2@ OBJE
1 FILE ${BOOK}/?pg=21
0 TRLR`);
    const members = report.groups[0].members;
    expect(members.every((m) => !m.foldedInto)).toBe(true);
    expect(text).toMatch(/1 BIRT\n2 SOUR @S1@\n3 PAGE 20/); // event citation
    expect(text).toMatch(/0 @I1@ INDI\n1 BIRT\n2 SOUR @S1@\n3 PAGE 20\n1 SOUR @S1@\n2 PAGE 20/); // record one kept
  });

  it("per-reference QUAY override beats the group default", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 WWW ${BOOK}/?pg=10
0 @I2@ INDI
1 BIRT
2 WWW ${BOOK}/?pg=11
0 TRLR`);
    const report = findReshapableLinks(ds);
    const g = report.groups[0];
    const members = g.members.map((m) => (m.page === "11" ? { ...m, quay: "1" } : m));
    const { records } = reshapeSources(ds.records, [{ ...g, quay: "3", members }]);
    const text = serializeGedcom(records);
    expect(text).toMatch(/3 PAGE 10\n3 QUAY 3/);
    expect(text).toMatch(/3 PAGE 11\n3 QUAY 1/);
  });

  it("dedupes the same URL cited twice on one event", () => {
    const { text, counts } = applyAll(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 DEAT
2 WWW ${BOOK}/?pg=94
2 WWW ${BOOK}/?pg=94
0 TRLR`);
    expect(counts.citationsAdded).toBe(1);
    expect(counts.linksRemoved).toBe(2);
    expect(text.match(/2 SOUR @S1@/g)).toHaveLength(1);
  });

  it("re-links an existing OBJE even when a bare link with the same URL comes first in the file", () => {
    const { text, counts } = applyAll(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 WWW ${BOOK}/?pg=94
0 @I2@ INDI
1 OBJE @O1@
0 @O1@ OBJE
1 FILE ${BOOK}/?pg=94
0 TRLR`);
    expect(counts.mediaCreated).toBe(0); // @O1@ re-linked, no duplicate minted
    expect(text.match(/0 @O\d+@ OBJE/g)).toHaveLength(1);
    expect(text).toMatch(/0 @S1@ SOUR\n(1 .*\n)*1 OBJE @O1@/);
  });

  it("preserves prose around the URL in a pageUrl PAGE value", () => {
    const { text } = applyAll(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 DEAT
2 SOUR @S1@
3 PAGE fol. 23, ${BOOK}/?pg=5
1 BIRT
2 SOUR @S1@
3 PAGE list 12, ${BOOK2}/
0 @S1@ SOUR
1 TITL Matična knjiga
0 TRLR`);
    expect(text).toContain("3 PAGE fol. 23, 5"); // URL swapped for its page number
    expect(text).toContain("3 PAGE list 12"); // no page number: URL removed, prose kept
  });

  it("matches per-reference QUAY by occurrence key, tolerating member-list drift", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 WWW ${BOOK}/?pg=10
0 @I2@ INDI
1 BIRT
2 WWW ${BOOK}/?pg=11
0 TRLR`);
    const report = findReshapableLinks(ds);
    const g = report.groups[0];
    // Simulate a stale report: only the pg=11 member survives, with an override.
    const members = g.members.filter((m) => m.page === "11").map((m) => ({ ...m, quay: "1" }));
    const { records } = reshapeSources(ds.records, [{ ...g, quay: "3", members }]);
    const text = serializeGedcom(records);
    expect(text).toMatch(/3 PAGE 10\n3 QUAY 3/); // default, not the drifted override
    expect(text).toMatch(/3 PAGE 11\n3 QUAY 1/); // override found by key, not position
  });

  it("resolves places against the file's own place format and fills the BURI place", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NOTE https://en.geneanet.org/cemetery/view/10085092
0 @I2@ INDI
1 BIRT
2 PLAC Žabnica,Kranj,Slovenia
0 TRLR`);
    const report = findReshapableLinks(ds);
    const enrichment = new Map([[report.groups[0].id, { place: "Žabnica, Slovenia" }]]);
    const { records } = reshapeSources(ds.records, report.groups, enrichment);
    const text = serializeGedcom(records);
    expect(text).toContain("1 PLAC Žabnica,Kranj,Slovenia"); // SOUR place in the file's format
    expect(text).toMatch(/1 BURI\n2 PLAC Žabnica,Kranj,Slovenia\n2 SOUR @S1@/); // burial place filled
  });

  it("matches a diacritic-less slug place to the file's real place", () => {
    const { text } = applyAll(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 WWW ${BOOK}/?pg=94
0 @I2@ INDI
1 RESI
2 PLAC Šentjur pri Celju,Slovenija
0 TRLR`);
    // Offline guess "Sentjur Pri Celju" resolves to the existing place value.
    expect(text).toContain("1 PLAC Šentjur pri Celju,Slovenija");
  });

  it("never overwrites an existing BURI place", () => {
    const { text } = applyAll(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BURI
2 PLAC Ljubljana - Žale
2 NOTE https://en.geneanet.org/cemetery/view/777
0 TRLR`);
    expect(text).toContain("2 PLAC Ljubljana - Žale");
    expect(text.match(/PLAC/g)).toHaveLength(1);
  });

  it("creates a Geneanet Cemeteries REPO in a repository-layout file", () => {
    const { text } = applyAll(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NOTE https://de.geneanet.org/friedhof/view/123
1 BIRT
2 SOUR @S9@
0 @S9@ SOUR
1 TITL Some archive
1 REPO @R9@
0 @R9@ REPO
1 NAME Local archive
1 WWW https://example.org/
0 TRLR`);
    expect(text).toContain("1 NAME Geneanet Cemeteries");
    expect(text).toContain("1 WWW https://en.geneanet.org/cemetery/");
    expect(text).toMatch(/0 @S\d+@ SOUR\n1 TITL 123 - Geneanet Cemeteries\n(1 .*\n)*1 REPO @R\d+@/);
  });

  it("re-points pageUrl citations to the book SOUR with a numeric PAGE", () => {
    const { text } = applyAll(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 DEAT
2 SOUR @S1@
3 PAGE ${BOOK}/?pg=19
0 @S1@ SOUR
1 TITL Matična knjiga umrlih
0 TRLR`);
    expect(text).toContain("2 SOUR @S2@\n3 PAGE 19");
    expect(text).toContain("0 @S2@ SOUR");
    // The generic record survives for the duplicates tool to handle.
    expect(text).toContain("1 TITL Matična knjiga umrlih");
  });

  it("rewrites URL-titled SOUR records in place with parsed fields and a page OBJE", () => {
    const { text, counts, report } = applyAll(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 SOUR @S1@
0 @S1@ SOUR
1 TITL ${BOOK2}/?pg=6
0 TRLR`);
    expect(report.groups[0].urlTitled).toBe(true); // stays enrichable in the panel
    expect(counts.sourcesCreated).toBe(0);
    expect(text).toContain("1 TITL Matricula 04406 | Vodice");
    expect(text).toContain("1 FILN 04406");
    expect(text).toContain(`1 FILE ${BOOK2}/?pg=6`);
    expect(text).toContain("2 SOUR @S1@"); // citation untouched
  });

  it("re-links a person-level OBJE record under the SOUR instead of duplicating it", () => {
    const { text, counts } = applyAll(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 OBJE @O1@
0 @O1@ OBJE
1 FILE ${BOOK}/?pg=94
0 TRLR`);
    expect(text).toMatch(/0 @S1@ SOUR\n(1 \w+.*\n)*1 OBJE @O1@/); // OBJE now hangs off the SOUR
    expect(text).not.toMatch(/0 @I1@ INDI\n1 OBJE/); // person pointer replaced by the citation
    expect(text.match(/0 @O\d+@ OBJE/g)).toHaveLength(1); // no duplicate media record
    expect(counts.mediaCreated).toBe(0);
  });

  it("attaches an existing Matricula REPO to new sources", () => {
    const { text } = applyAll(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 WWW ${BOOK}/?pg=94
0 @R1@ REPO
1 NAME Nadškofijski arhiv Maribor
1 WWW https://data.matricula-online.eu/sl/slovenia/maribor/
0 TRLR`);
    expect(text).toContain("1 REPO @R1@");
  });

  it("never mutates the input records", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 WWW ${BOOK}/?pg=94
2 NOTE Entry at ${BOOK}/?pg=95 here
0 TRLR`);
    const before = serializeGedcom(ds.records);
    const report = findReshapableLinks(ds);
    reshapeSources(ds.records, report.groups);
    expect(serializeGedcom(ds.records)).toBe(before);
  });

  it("is idempotent: rescanning the output finds nothing", () => {
    const { records } = applyAll(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 SOUR KK ${BOOK}/?pg=95
1 NOTE https://de.geneanet.org/friedhof/view/123
1 OBJE @O1@
0 @O1@ OBJE
1 FILE ${BOOK2}/?pg=5
0 TRLR`);
    const again = findReshapableLinks(
      buildDataset(parseGedcom(new TextEncoder().encode(serializeGedcom(records)).buffer)),
    );
    expect(again.groups).toHaveLength(0);
  });

  it("applies enrichment overrides including the DATE range", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 WWW ${BOOK2}/?pg=3
0 TRLR`);
    const report = findReshapableLinks(ds);
    const enrichment = new Map([
      [
        report.groups[0].id,
        { title: "Krstna knjiga / Taufbuch - 04406 | Vodice", agency: "Nadškofijski arhiv Ljubljana", place: "Vodice", dateRange: "1891-1920" },
      ],
    ]);
    const { records } = reshapeSources(ds.records, report.groups, enrichment);
    const text = serializeGedcom(records);
    expect(text).toContain("1 TITL Krstna knjiga / Taufbuch - 04406 | Vodice");
    expect(text).toContain("1 AGNC Nadškofijski arhiv Ljubljana");
    expect(text).toContain("1 PLAC Vodice");
    expect(text).toContain("1 DATE 1891-1920");
  });

  it("returns the input unchanged for an empty selection", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 WWW ${BOOK}/?pg=94
0 TRLR`);
    const { records, counts } = reshapeSources(ds.records, []);
    expect(records).toBe(ds.records);
    expect(counts.citationsAdded).toBe(0);
  });
});

describe("reshapeSources — citation placement", () => {
  it("moves a record-level baptism citation onto BIRT, creating the event", () => {
    const { text, counts } = applyAll(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ana /Novak/
1 SOUR KK ${BOOK}/?pg=95
0 TRLR`);
    expect(text).toContain("1 BIRT\n2 SOUR @S1@\n3 PAGE 95");
    expect(counts.eventsCreated).toBe(1);
  });

  it("follows the file's BAPM habit for baptism books", () => {
    const { text } = applyAll(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BAPM
2 DATE 1890
2 SOUR @S9@
1 SOUR KK ${BOOK}/?pg=95
0 @I2@ INDI
1 BAPM
2 SOUR @S9@
0 @S9@ SOUR
1 TITL X
0 TRLR`);
    expect(text).toMatch(/1 BAPM\n2 DATE 1890\n2 SOUR @S9@\n2 SOUR @S10@\n3 PAGE 95/);
  });

  it("moves a marriage citation to the sole family's MARR, stays put when ambiguous", () => {
    const { text } = applyAll(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 SOUR PK ${BOOK}/?pg=10
1 FAMS @F1@
0 @I2@ INDI
1 SOUR PK ${BOOK}/?pg=11
1 FAMS @F1@
1 FAMS @F2@
0 @F1@ FAM
1 HUSB @I1@
0 @F2@ FAM
0 TRLR`);
    expect(text).toMatch(/0 @F1@ FAM\n1 HUSB @I1@\n1 MARR\n2 SOUR @S1@\n3 PAGE 10/);
    expect(text).toMatch(/0 @I2@ INDI\n1 SOUR @S1@\n2 PAGE 11/); // ambiguous: converted in place
  });

  it("places cemetery citations on a created BURI event", () => {
    const { text } = applyAll(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NOTE https://de.geneanet.org/friedhof/view/123
0 TRLR`);
    expect(text).toMatch(/1 BURI\n2 SOUR @S1@/);
    expect(text).not.toContain("NOTE http");
  });

  it("treats Find a Grave memorials like graves: person-named source, BURI placement", () => {
    const { text, report } = applyAll(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NOTE https://www.findagrave.com/memorial/12345/anton-grudnik
1 DEAT
2 WWW https://www.findagrave.com/memorial/12345
0 TRLR`);
    const grave = report.groups.find((g) => g.site === "findagrave")!;
    expect(grave.members).toHaveLength(2); // slug and slugless variants share the memorial group
    expect(grave.bookType).toBe("burial");
    expect(grave.proposed.title).toBe("Anton Grudnik - 12345 - Find a Grave");
    expect(text).toContain("1 TITL Anton Grudnik - 12345 - Find a Grave");
    expect(text).toMatch(/1 BURI\n2 SOUR @S1@/); // record-level note moved to a created BURI
    expect(text).toMatch(/1 DEAT\n2 SOUR @S1@/); // DEAT is an acceptable spot for a grave — stays
  });

  it("treats Legacy.com obituaries as death evidence: DEAT placement, id+name title", () => {
    const { text, report } = applyAll(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NOTE https://www.legacy.com/us/obituaries/theherald-news/name/peter-ancel-obituary?id=26608778
0 TRLR`);
    const g = report.groups.find((x) => x.site === "legacy")!;
    expect(g.bookType).toBe("death");
    expect(g.proposed.title).toBe("Peter Ancel - 26608778 - Legacy.com");
    expect(text).toMatch(/1 DEAT\n2 SOUR @S1@/); // record-level note moved to a created DEAT
    expect(text).toContain("1 TITL Peter Ancel - 26608778 - Legacy.com");
  });

  it("treats SIstory.si WW records as death evidence with the quoted person name", () => {
    const { text, report } = applyAll(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 SOUR INZ, »Fani Grudnik«, Smrtne žrtve druge svetovne vojne, https://www.sistory.si/ww2/F01EDD85-E7BB-4D18-9599-1428852BAA1F
0 TRLR`);
    const g = report.groups.find((x) => x.site === "sistory")!;
    expect(g.bookType).toBe("death");
    expect(g.proposed.title).toBe("Fani Grudnik - F01EDD85-E7BB-4D18-9599-1428852BAA1F - SIstory.si WW2");
    expect(text).toMatch(/1 DEAT\n2 SOUR @S1@/); // inline citation moved onto a created DEAT
    expect(text).toContain("1 TITL Fani Grudnik - F01EDD85-E7BB-4D18-9599-1428852BAA1F - SIstory.si WW2");
  });

  it("recognizes both SIstory WW1 shapes and groups the same victim across them", () => {
    const { text, report } = applyAll(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 SOUR https://www.sistory.si/ww1/15691
1 NOTE https://zv1.sistory.si/zrtev?id=15691-%C4%8Cehun-Matija-1877
0 TRLR`);
    const g = report.groups.find((x) => x.site === "sistory")!;
    expect(g.members).toHaveLength(2); // path and zv1 variants share the record
    expect(g.bookType).toBe("death");
    expect(g.proposed.title).toBe("Matija Čehun (1877) - 15691 - SIstory.si WW1"); // name from the zv1 id
    expect(text).toMatch(/1 DEAT\n2 SOUR @S1@/);
  });

  it("leaves acceptable placements alone (death book on BURI)", () => {
    const { text } = applyAll(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BURI
2 SOUR MK ${BOOK}/?pg=40
0 TRLR`);
    expect(text).toMatch(/1 BURI\n2 SOUR @S1@\n3 PAGE 40/);
    expect(text).not.toContain("1 DEAT");
  });

  it("keeps original placement with relocate off or unknown book type", () => {
    const { text } = applyAll(
      `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 SOUR KK ${BOOK}/?pg=95
1 WWW ${BOOK2}/?pg=3
0 TRLR`,
      { relocate: false },
    );
    expect(text).toMatch(/0 @I1@ INDI\n1 SOUR @S1@\n2 PAGE 95/);
    expect(text).not.toContain("1 BIRT");
    // The bare WWW link (unknown type) also stays at record level.
    expect(text).toMatch(/1 SOUR @S2@\n2 PAGE 3/);
  });
});

describe("enrichment parsing & fetching", () => {
  const PAGE_HTML = `<html><head><title>Krstna knjiga / Taufbuch - 04406 | Vodice | Nadškofijski arhiv Ljubljana | Slovenia | Matricula Online</title></head>
<body><table class="table table-register-data">
<tr><th>Parish/place</th><td><a href="/en/slovenia/ljubljana/vodice/">Vodice</a></td>
<tr><th>ID</th><td>04406</td>
<tr><th>Type</th><td>Krstna knjiga / Taufbuch</td>
<tr><th>Date from</th><td>Jan. 1, 1891</td>
<tr><th>Date to</th><td>Dec. 31, 1920</td>
</table></body></html>`;

  // Captured from r.jina.ai (the rendering relay): markdown, no "Matricula
  // Online" title suffix, metadata as a pipe table.
  const PAGE_MD = `Title: Krstni index / Taufindex - 01556 | Naklo | Nadškofijski arhiv Ljubljana | Slovenia

URL Source: https://data.matricula-online.eu/en/slovenia/ljubljana/naklo/01556/

Markdown Content:
| Parish/place | [Naklo](https://data.matricula-online.eu/en/slovenia/ljubljana/naklo/) |
| --- |
| ID | 01556 |
| Type | Krstni index / Taufindex |
| Date from | Jan. 1, 1843 |
| Date to | Dec. 31, 1909 |`;

  const GRAVE_MD = `Title: Žabnica - Cemetery - #10085092

URL Source: https://en.geneanet.org/cemetery/view/10085092

**Localisation**

[Pokopališče Zgornje Bitnje](https://en.geneanet.org/cemetery/collection/214223-pokopalisce-zgornje-bitnje) - P02

[Žabnica](https://en.geneanet.org/cemetery/search/?country%5B0%5D=SVN) (Slovenia)

GPS Coordinates : 46.2181,14.3463`;

  it("parses the rendering relay's markdown book page", () => {
    expect(parseMatriculaBookPage(PAGE_MD)).toMatchObject({
      title: "Krstni index / Taufindex - 01556 | Naklo",
      type: "Krstni index / Taufindex",
      place: "Naklo",
      agency: "Nadškofijski arhiv Ljubljana",
      dateFrom: "Jan. 1, 1843",
      dateTo: "Dec. 31, 1909",
    });
  });

  it("parses the Geneanet cemetery page's Localisation block", () => {
    expect(parseGeneanetCemeteryPage(GRAVE_MD)).toEqual({
      title: "Žabnica - Cemetery - #10085092",
      cemetery: "Pokopališče Zgornje Bitnje",
      plot: "P02",
      town: "Žabnica",
      country: "Slovenia",
    });
    expect(parseGeneanetCemeteryPage("nothing here")).toBeUndefined();
  });

  it("enriches a Geneanet group with the grave's place", async () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NOTE https://en.geneanet.org/cemetery/view/10085092
0 TRLR`);
    const report = findReshapableLinks(ds);
    const enrichment = await fetchReshapeMeta(report.groups, async () => GRAVE_MD);
    expect(enrichment.get(report.groups[0].id)).toEqual({
      place: "Žabnica, Slovenia", // PLAC is the place; the cemetery names the source
      title: "Pokopališče Zgornje Bitnje, Žabnica - 10085092 - Geneanet Cemeteries",
    });
  });

  it("enriches a Find a Grave group with the memorial's name, id kept", async () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NOTE https://www.findagrave.com/memorial/60350966
0 TRLR`);
    const report = findReshapableLinks(ds);
    const enrichment = await fetchReshapeMeta(
      report.groups,
      async () => `<html><head><title>Frank Gorishek (1881-1968) - Find a Grave Memorial</title></head></html>`,
    );
    expect(enrichment.get(report.groups[0].id)).toEqual({
      title: "Frank Gorishek (1881-1968) - 60350966 - Find a Grave",
    });
  });

  it("parses the Matricula page title", () => {
    expect(
      parseMatriculaTitle("Krstna knjiga / Taufbuch - 04406 | Vodice | Nadškofijski arhiv Ljubljana | Slovenia | Matricula Online"),
    ).toEqual({ title: "Krstna knjiga / Taufbuch - 04406 | Vodice", place: "Vodice", agency: "Nadškofijski arhiv Ljubljana" });
    expect(parseMatriculaTitle("Something else")).toBeUndefined();
  });

  it("parses the book page's metadata table", () => {
    expect(parseMatriculaBookPage(PAGE_HTML)).toMatchObject({
      title: "Krstna knjiga / Taufbuch - 04406 | Vodice",
      type: "Krstna knjiga / Taufbuch",
      place: "Vodice",
      agency: "Nadškofijski arhiv Ljubljana",
      dateFrom: "Jan. 1, 1891",
      dateTo: "Dec. 31, 1920",
    });
  });

  it("does not let a fetched 'unknown' type clobber the offline classification", async () => {
    // Distinct book URL: the module-level enrichment cache persists across tests.
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 SOUR KK https://data.matricula-online.eu/sl/slovenia/ljubljana/skofja-loka/09901/?pg=3
0 TRLR`);
    const report = findReshapableLinks(ds);
    expect(report.groups[0].bookType).toBe("baptism"); // from the KK prefix
    // A page with a title but no recognizable Type row → classify = "unknown".
    const enrichment = await fetchReshapeMeta(
      report.groups,
      async () =>
        `<html><head><title>Krstna knjiga / Taufbuch - 04406 | Vodice | Nadškofijski arhiv Ljubljana | Slovenia | Matricula Online</title></head><body></body></html>`,
    );
    expect(enrichment.get(report.groups[0].id)?.bookType).toBeUndefined();
    // Apply still relocates to BIRT using the offline type.
    const { records } = reshapeSources(ds.records, report.groups, enrichment);
    expect(serializeGedcom(records)).toMatch(/1 BIRT\n2 SOUR @S1@/);
  });

  it("fetches once per book (the /en/ variant) and swallows failures", async () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 WWW ${BOOK2}/?pg=3
1 DEAT
2 WWW ${BOOK2}/?pg=9
1 NOTE https://de.geneanet.org/friedhof/view/99
0 TRLR`);
    const report = findReshapableLinks(ds);
    const fetched: string[] = [];
    const enrichment = await fetchReshapeMeta(report.groups, async (url) => {
      fetched.push(url);
      return url.includes("matricula") ? PAGE_HTML : undefined;
    });
    expect(fetched.filter((u) => u.includes("matricula"))).toEqual([
      "https://data.matricula-online.eu/en/slovenia/ljubljana/vodice/04406/",
    ]);
    const matGroup = report.groups.find((g) => g.site === "matricula")!;
    expect(enrichment.get(matGroup.id)).toMatchObject({
      title: "Krstna knjiga / Taufbuch - 04406 | Vodice",
      dateRange: "1891-1920",
      bookType: "baptism",
    });
    const geneGroup = report.groups.find((g) => g.site === "geneanet")!;
    expect(enrichment.has(geneGroup.id)).toBe(false); // fetch failed → offline fallback stays
  });
});
