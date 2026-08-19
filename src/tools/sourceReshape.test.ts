import { describe, expect, it, vi } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import { canonicalFamilySearchUrl, familySearchPageUrl, linkKey } from "../normalize/links";
import { createSourceRecord } from "../gedcom/edit";
import type { ReshapeEnrichment, ReshapeSite } from "./sourceReshape";
import {
  applySiteSourceExtras,
  detectPageMediaStyle,
  classifyBookType,
  fetchBookMeta,
  fetchReshapeMeta,
  createSiteRepo,
  findReshapableLinks,
  isFetchableSite,
  mergeFsBooks,
  narrowFsRegister,
  proposedSiteRepo,
  splitFsRegisters,
  parseFamilySearchArkJson,
  parsePastedFsCitation,
  parseFamilySearchUrl,
  parseGeneanetCemeteryPage,
  parseMatriculaBookPage,
  parseMatriculaTitle,
  parseMatriculaUrl,
  recognizeSourceUrl,
  reshapeOptionsFromOverrides,
  smartCitationTarget,
  reshapeSources,
  siteSourceTitle,
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
function applyAll(text: string, opts?: import("./sourceReshape").ReshapeOptions & { quay?: string }) {
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

  it("stores a FamilySearch link as ark + image + film, without the viewer trail", () => {
    expect(
      familySearchPageUrl("https://www.familysearch.org/ark:/61903/3:1:3Q9M-CS2T-N985-8?view=explore&cat=406380&i=137&lang=en"),
    ).toBe("https://www.familysearch.org/ark:/61903/3:1:3Q9M-CS2T-N985-8?i=137&cat=406380");
    expect(familySearchPageUrl("https://familysearch.org/ark:/61903/1:1:XNJ8-FPJ?lang=sl")).toBe(
      "https://www.familysearch.org/ark:/61903/1:1:XNJ8-FPJ",
    );
    expect(familySearchPageUrl("https://data.matricula-online.eu/sl/x/?pg=5")).toBe(
      "https://data.matricula-online.eu/sl/x/?pg=5",
    );
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

  it("recognizes cemetery and grave collections", () => {
    expect(classifyBookType(["Pokopališče Kranj - Geneanet Cemeteries"])).toBe("burial");
    expect(classifyBookType(["U.S., Find a Grave® Index, 1600s-Current"])).toBe("burial");
    expect(classifyBookType(["Global, Geneanet Cemetery Index, 1500-current"])).toBe("burial");
    expect(classifyBookType(["BillionGraves"])).toBe("burial");
    expect(classifyBookType(["Groblje Zagreb"])).toBe("burial");
    expect(classifyBookType(["Friedhof Graz"])).toBe("burial");
  });

  it("reads a death register that also names the graveyard as a death register", () => {
    // Not rival readings: the two events accept each other's citations, and a
    // grave site is pinned by its URL long before the title is consulted.
    expect(classifyBookType(["U.S., Cemetery and Funeral Home Collection, 1847-Current"])).toBe("death");
    expect(classifyBookType(["Mrliška knjiga in pokopališče Kranj"])).toBe("death");
  });

  it("returns unknown for no signal or conflicting signals", () => {
    expect(classifyBookType([undefined, ""])).toBe("unknown");
    expect(classifyBookType(["Matična knjiga"])).toBe("unknown");
    expect(classifyBookType(["Krstna in mrliška knjiga"])).toBe("unknown");
    expect(classifyBookType(["1950 United States Federal Census"])).toBe("unknown");
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

  it("converts person-level OBJE pointers — free ones and, in a links-on-events file, sour-owned page media too", () => {
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
    expect(report.totalOccurrences).toBe(2);
    // The pointer to @S1@'s own page image resolves to that source (reuse);
    // the free pointer mints a new one.
    const owned = report.groups.find((g) => g.existingSourceXref === "@S1@")!;
    expect(owned.members[0]).toMatchObject({ shape: "obje", url: `${BOOK}/?pg=94` });
    const free = report.groups.find((g) => !g.existingSourceXref)!;
    expect(free.members[0]).toMatchObject({ shape: "obje", url: `${BOOK2}/?pg=5` });
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
    // FamilySearch's `i=` counts from zero: i=113 is its image 114.
    expect(film.pages).toEqual(["114", "138"]);
    const coll = fs.find((g) => g.proposed.title.startsWith("Croatia"))!;
    expect(coll.members[0].shape).toBe("note");
    // A collection spans many records — no single ARK can be its filing number.
    expect(coll.proposed.filingNumber).toBeUndefined();
  });

  it("extracts the ARK id as the filing number for lone FamilySearch links", () => {
    const report = scan(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 SOUR https://familysearch.org/ark:/61903/1:1:XNJ8-FPJ
1 DEAT
2 SOUR https://www.familysearch.org/ark:/61903/3:1:3Q9M-CS2T-N985-8?i=137
0 TRLR`);
    const fs = report.groups.filter((g) => g.site === "familysearch");
    expect(fs.map((g) => g.proposed.filingNumber).sort()).toEqual(["1:1:XNJ8-FPJ", "3:1:3Q9M-CS2T-N985-8"]);
  });

  it("ignores other hosts unless the 'other' category is enabled", () => {
    const text = `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 SOUR https://example.org/records/ABC
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

  it("reads a page already cited through the other source that holds it as done", () => {
    // One image, two source records holding it — an overlap the file made
    // itself (two books, or a duplicate the merge tool has yet to collapse).
    // The event cites one of them; which one the scan picks is record order,
    // so the row must not come back offering the other's citation beside it.
    const file = `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 SOUR @S2@
3 PAGE 94
2 OBJE @O1@
0 @S1@ SOUR
1 TITL Krstna knjiga - 03869 (older)
1 OBJE @O1@
0 @S2@ SOUR
1 TITL Krstna knjiga - 03869
1 OBJE @O1@
0 @O1@ OBJE
1 FILE ${BOOK}/?pg=94
0 TRLR`;
    const ds = dataset(file);
    const opts = { pageMedia: "event" as const, relocate: false };
    // Nothing is listed — the scan picks @S1@ for the group, the file cites @S2@.
    const report = findReshapableLinks(ds, undefined, opts);
    expect(report.groups).toHaveLength(0);
    // …and a run asked for it anyway (an older report, a hand-ticked row)
    // leaves the citation alone rather than hanging a second one beside it.
    const forced = findReshapableLinks(ds, undefined, { ...opts, pageMedia: "source" });
    expect(forced.groups[0].existingSourceXref).toBe("@S1@");
    const text = serializeGedcom(reshapeSources(ds.records, forced.groups, undefined, opts).records);
    expect(text.match(/2 SOUR @S\d@/g)).toEqual(["2 SOUR @S2@"]);
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

  it("titles a site's source with both the name and the id (shared with the editor)", () => {
    // The Edit Source dialog's "Fetch again" runs the same rule, so a record
    // filled from its link ends up named like one the tool wrote.
    expect(siteSourceTitle("geneanet", "Pokopališče Kranj - Geneanet Cemeteries", "9833001")).toBe(
      "Pokopališče Kranj - 9833001 - Geneanet Cemeteries",
    );
    expect(siteSourceTitle("geneanet", "Pokopališče Kranj", "9833001")).toBe(
      "Pokopališče Kranj - 9833001 - Geneanet Cemeteries",
    );
    // An id already in the title, a title with no id to add, and another
    // site's title are all left exactly as they are.
    expect(siteSourceTitle("geneanet", "9833001 - Geneanet Cemeteries", "9833001")).toBe("9833001 - Geneanet Cemeteries");
    expect(siteSourceTitle("geneanet", "Pokopališče Kranj - Geneanet Cemeteries", undefined)).toBe(
      "Pokopališče Kranj - Geneanet Cemeteries",
    );
    expect(siteSourceTitle("matricula", "Krstna knjiga - 03869", "03869")).toBe("Krstna knjiga - 03869");
    expect(siteSourceTitle(undefined, undefined, "9833001")).toBeUndefined();
  });

  it("keeps the view id in a looked-up cemetery's title, so two graves differ", () => {
    // Every grave in one cemetery answers with the same name. Without the id
    // the file fills with sources called "Pokopališče Kranj - Geneanet
    // Cemeteries" that nothing tells apart — and the duplicate finder, which
    // compares a record's own content, reads two graves as one record.
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NOTE https://en.geneanet.org/cemetery/view/9833001
0 @I2@ INDI
1 NOTE https://en.geneanet.org/cemetery/view/9833663
0 TRLR`);
    const report = findReshapableLinks(ds);
    const enrichment = new Map(
      report.groups.map((g) => [g.id, { title: "Pokopališče Kranj - Geneanet Cemeteries", place: "Kranj, Slovenia" }]),
    );
    const text = serializeGedcom(reshapeSources(ds.records, report.groups, enrichment).records);
    expect(text).toContain("1 TITL Pokopališče Kranj - 9833001 - Geneanet Cemeteries");
    expect(text).toContain("1 TITL Pokopališče Kranj - 9833663 - Geneanet Cemeteries");
    // …and the id is a field of its own, not only part of the name.
    expect(text).toContain("1 FILN 9833001");
  });

  it("fills the id a reused source was made without, in the field the file uses", () => {
    // The id is stated once: as the filing number in a file written this way
    // (MacFamilyTree and its kin), as the repository link's call number in a
    // file that states them there. A record made before the id was known has
    // neither, and the tool fills whichever the file calls for.
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NOTE https://en.geneanet.org/cemetery/view/9833001
0 @S1@ SOUR
1 TITL Pokopališče Kranj - Geneanet Cemeteries
1 REPO @R1@
1 OBJE @M1@
0 @R1@ REPO
1 NAME Geneanet - Cemeteries and Memorials
0 @M1@ OBJE
1 FILE https://en.geneanet.org/cemetery/view/9833001
0 TRLR`);
    const report = findReshapableLinks(ds);
    expect(report.groups[0].existingSourceXref).toBe("@S1@");
    const text = serializeGedcom(reshapeSources(ds.records, report.groups).records);
    expect(text).toContain("1 FILN 9833001");
    expect(text).not.toContain("2 CALN");
    // The reader's own title is theirs — only the empty fields are filled.
    expect(text).toContain("1 TITL Pokopališče Kranj - Geneanet Cemeteries");
  });

  it("fills the call number instead, in a file that states ids there", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NOTE https://en.geneanet.org/cemetery/view/9833001
0 @S1@ SOUR
1 TITL Pokopališče Kranj - Geneanet Cemeteries
1 REPO @R1@
1 OBJE @M1@
0 @S2@ SOUR
1 TITL Neka druga knjiga
1 REPO @R1@
2 CALN 1234
0 @R1@ REPO
1 NAME Geneanet - Cemeteries and Memorials
0 @M1@ OBJE
1 FILE https://en.geneanet.org/cemetery/view/9833001
0 TRLR`);
    const text = serializeGedcom(reshapeSources(ds.records, findReshapableLinks(ds).groups).records);
    expect(text).toMatch(/1 REPO @R1@\n2 CALN 9833001/);
  });

  it("writes the spec's DATA coverage in a standard-coverage file", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NOTE ${BOOK}/?pg=10
0 TRLR`);
    const report = findReshapableLinks(ds);
    const enrichment = new Map([
      [report.groups[0].id, { bookType: "death" as const, place: "Šentjur", dateRange: "1896-1911", agency: "NŠAM" }],
    ]);
    const { records } = reshapeSources(ds.records, report.groups, enrichment, { sourceCoverage: "standard" });
    const text = serializeGedcom(records);
    // One DATA > EVEN block: type, period value, jurisdiction; AGNC in its
    // spec spot under DATA — and no flat vendor copies beside it.
    expect(text).toMatch(/1 DATA\n2 EVEN DEAT\n3 DATE FROM 1896 TO 1911\n3 PLAC Šentjur\n2 AGNC NŠAM/);
    expect(text).not.toMatch(/\n1 PLAC /);
    expect(text).not.toMatch(/\n1 AGNC /);
    // No repository in this file, so no CALN to carry the number — the flat
    // FILN survives rather than losing the id.
    expect(text).toContain("1 FILN 03869");
  });

  it("moves the filing number wholly into CALN when a repository carries it", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NOTE ${BOOK}/?pg=10
0 @S9@ SOUR
1 TITL Krstna knjiga
1 REPO @R9@
0 @R9@ REPO
1 NAME Nekje
0 TRLR`);
    const report = findReshapableLinks(ds);
    const enrichment = new Map([[report.groups[0].id, { bookType: "death" as const, dateRange: "1896-1911" }]]);
    const { records } = reshapeSources(ds.records, report.groups, enrichment, { sourceCoverage: "standard" });
    const text = serializeGedcom(records);
    expect(text).toMatch(/1 REPO @R\d+@\n2 CALN 03869/);
    expect(text).not.toContain("1 FILN");
  });

  it("states one EVEN per register of a multi-register FamilySearch book", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NOTE https://www.familysearch.org/ark:/61903/3:1:TEST-COVER-1
0 TRLR`);
    const report = findReshapableLinks(ds);
    const enrichment = new Map([
      [
        report.groups[0].id,
        {
          bookType: "unknown" as const,
          place: "Ravna Gora",
          dateRange: "1805-1843",
          book: "Marriages (Vjenčani) 1805-1812 Births (Rođeni) 1815-1843",
        },
      ],
    ]);
    const { records } = reshapeSources(ds.records, report.groups, enrichment, { sourceCoverage: "standard" });
    const text = serializeGedcom(records);
    expect(text).toMatch(/2 EVEN MARR\n3 DATE FROM 1805 TO 1812\n3 PLAC Ravna Gora/);
    expect(text).toMatch(/2 EVEN BIRT\n3 DATE FROM 1815 TO 1843\n3 PLAC Ravna Gora/);
  });

  it("keeps the flat fields when the register type is unknown, even in standard mode", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NOTE ${BOOK}/?pg=10
0 TRLR`);
    const report = findReshapableLinks(ds);
    const enrichment = new Map([[report.groups[0].id, { place: "Šentjur", dateRange: "1896-1911" }]]);
    const { records } = reshapeSources(ds.records, report.groups, enrichment, { sourceCoverage: "standard" });
    const text = serializeGedcom(records);
    // A coverage claim needs an event type — without one nothing is invented,
    // and the values still land (as the flat fields).
    expect(text).not.toContain("1 DATA");
    expect(text).toContain("1 PLAC Šentjur");
    expect(text).toContain("1 DATE 1896-1911");
  });

  it("follows the file's own coverage habit on auto", () => {
    // The file's one covering source already speaks the standard shape, so a
    // new source does too — no override needed.
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NOTE ${BOOK}/?pg=10
0 @S9@ SOUR
1 TITL Mrliška knjiga Kranj
1 DATA
2 EVEN DEAT
3 DATE FROM 1800 TO 1850
0 TRLR`);
    const report = findReshapableLinks(ds);
    const enrichment = new Map([[report.groups[0].id, { bookType: "death" as const, dateRange: "1896-1911" }]]);
    const { records } = reshapeSources(ds.records, report.groups, enrichment);
    expect(serializeGedcom(records)).toMatch(/1 DATA\n2 EVEN DEAT\n3 DATE FROM 1896 TO 1911/);
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

  it("puts the cemetery into the BURI ADDR in a place+address file", () => {
    // Several PLAC+ADDR pairs make the file read as structured-addr layout.
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NOTE https://en.geneanet.org/cemetery/view/555
1 BIRT
2 PLAC Žabnica,Kranj,Slovenia
2 ADDR Žabnica 12
0 @I2@ INDI
1 BIRT
2 PLAC Strahinj,Naklo,Slovenia
2 ADDR Strahinj 36
1 RESI
2 PLAC Kranj,Kranj,Slovenia
2 ADDR Cesta 1
0 TRLR`);
    const report = findReshapableLinks(ds);
    const enrichment = new Map([
      [report.groups[0].id, { place: "Žabnica, Slovenia", address: "Pokopališče Zgornje Bitnje", page: "P02" }],
    ]);
    const { records } = reshapeSources(ds.records, report.groups, enrichment);
    const text = serializeGedcom(records);
    // Cemetery in the ADDR; the plot is the citation's where-within-source.
    expect(text).toMatch(/1 BURI\n2 PLAC Žabnica,Kranj,Slovenia\n2 ADDR Pokopališče Zgornje Bitnje\n2 SOUR @S\d+@\n3 PAGE P02/);
  });

  it("adds the cemetery ADDR even when the BURI already has a place", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BURI
2 PLAC Žabnica,Kranj,Slovenia
2 NOTE https://en.geneanet.org/cemetery/view/555
0 @I2@ INDI
1 BIRT
2 PLAC Strahinj,Naklo,Slovenia
2 ADDR Strahinj 36
1 RESI
2 PLAC Kranj,Kranj,Slovenia
2 ADDR Cesta 1
1 DEAT
2 PLAC Žabnica,Kranj,Slovenia
2 ADDR Žabnica 12
0 TRLR`);
    const report = findReshapableLinks(ds);
    const enrichment = new Map([
      [report.groups[0].id, { place: "Žabnica, Slovenia", address: "Pokopališče Zgornje Bitnje", page: "P02" }],
    ]);
    const { records } = reshapeSources(ds.records, report.groups, enrichment);
    const text = serializeGedcom(records);
    // The existing place is kept, the cemetery still lands in the ADDR.
    expect(text).toMatch(/1 BURI\n2 PLAC Žabnica,Kranj,Slovenia\n2 ADDR Pokopališče Zgornje Bitnje\n2 SOUR @S\d+@\n3 PAGE P02/);
  });

  it("an offline rerun converges on a grave whose PAGE only enrichment knew", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NOTE https://en.geneanet.org/cemetery/view/555
0 TRLR`);
    const report = findReshapableLinks(ds, undefined, { pageMedia: "event" });
    const enrichment = new Map([[report.groups[0].id, { page: "P02" }]]);
    const groups = report.groups.map((g) => ({ ...g, quay: "3" }));
    const { records } = reshapeSources(ds.records, groups, enrichment, { pageMedia: "event" });
    const text = serializeGedcom(records);
    expect(text).toMatch(/1 BURI\n2 OBJE @O\d+@\n2 SOUR @S\d+@\n3 PAGE P02\n3 QUAY 3/);
    // The rescan has no enrichment, so it can't know the plot PAGE — the
    // settled citation must still count and the group must not reappear.
    expect(findReshapableLinks(dataset(text), undefined, { pageMedia: "event" }).groups).toHaveLength(0);
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
    // The cemetery view id is stated once, in the field this file uses for
    // it: no call number stands anywhere here, so it is the filing number.
    expect(text).toContain("1 FILN 123");
    expect(text).not.toMatch(/2 CALN 123/);
  });

  it("writes the FORM a new page image's FILE calls for", () => {
    const { text } = applyAll(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 NOTE https://data.matricula-online.eu/sl/slovenia/maribor/sentjur-pri-celju/03869/?pg=10
0 TRLR`);
    // A web page link: FORM htm, nested under the FILE it describes.
    expect(text).toMatch(/1 FILE https:\/\/data\.matricula-online\.eu\/[^\n]*\n2 FORM htm/);
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

  it("fills the tree owner as AUTH when rewriting a URL-titled Geneanet tree SOUR", () => {
    const { text, counts } = applyAll(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 SOUR @S1@
0 @S1@ SOUR
1 TITL https://gw.geneanet.org/hawlina?lang=en&p=rajko&n=vute
0 TRLR`);
    expect(counts.sourcesCreated).toBe(0);
    expect(text).toContain("1 TITL Rajko Vute - hawlina - Geneanet Trees");
    expect(text).toContain("1 AUTH hawlina"); // same author the offline proposal carries
  });

  it("removeLinks strips a dead link everywhere without creating a source", () => {
    const url = "http://www.legacy.com/obituaries/gettysburgtimes/obituary.aspx?n=mary-c-chudovan-yaklich&pid=161495515";
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NOTE Obituary at ${url} in the Gettysburg Times.
1 SOUR @S1@
2 PAGE Publication Date: 8/ Dec/ 2012; URL: ${url}
1 DEAT
2 WWW ${url}
0 @S1@ SOUR
1 TITL U.S., Obituary Collection, 1930-Current
0 TRLR`);
    const report = findReshapableLinks(ds);
    const groups = report.groups.map((g) => (g.site === "legacy" ? { ...g, removeLinks: true } : g));
    const { records, counts } = reshapeSources(ds.records, groups);
    const text = serializeGedcom(records);
    expect(text).not.toContain("legacy.com"); // the dead link is gone everywhere
    expect(counts.sourcesCreated).toBe(0);
    expect(text).toContain("1 NOTE Obituary at in the Gettysburg Times."); // note text survives
    expect(text).toContain("2 PAGE Publication Date: 8/ Dec/ 2012"); // citation prose survives
    expect(text).toContain("1 SOUR @S1@"); // the Ancestry citation itself stays
    expect(text).not.toContain("2 WWW"); // the bare link field is dropped
    expect(counts.linksRemoved).toBe(1);
  });

  it("folds duplicated identical citations into one (Ancestry re-exports them verbatim)", () => {
    // Real shape from an Ancestry export: the same record-level citation —
    // same source, same PAGE with the obituary URL — appears twice on the
    // person. Both relocate to the death event and must become ONE citation.
    const url =
      "http://www.legacy.com/obituaries/gettysburgtimes/obituary.aspx?n=mary-c-chudovan-yaklich&pid=161495515";
    const { text } = applyAll(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 DEAT
2 DATE 17 OCT 1918
1 SOUR @S1@
2 PAGE Publication Date: 8/ Dec/ 2012; URL: ${url}
1 SOUR @S1@
2 PAGE Publication Date: 8/ Dec/ 2012; URL: ${url}
0 @S1@ SOUR
1 TITL U.S., Obituary Collection, 1930-Current
0 TRLR`);
    const indi = text.slice(text.indexOf("0 @I1@"), text.indexOf("0 @S"));
    expect(indi.match(/2 SOUR /g)).toHaveLength(1); // one citation, on DEAT
    // The "; URL:" label doesn't dangle once its link is gone.
    expect(indi).toContain("3 PAGE Publication Date: 8/ Dec/ 2012\n");
  });

  it("applies panel-edited fields: filing-number override, cleared author writes nothing", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 SOUR @S1@
0 @S1@ SOUR
1 TITL https://gw.geneanet.org/hawlina?lang=en&p=rajko&n=vute
0 TRLR`);
    const report = findReshapableLinks(ds);
    const enrichment = new Map([
      [report.groups[0].id, { title: "Hawlina family tree", author: "", filingNumber: "GT-7" }],
    ]);
    const { records } = reshapeSources(ds.records, report.groups, enrichment);
    const text = serializeGedcom(records);
    expect(text).toContain("1 TITL Hawlina family tree");
    expect(text).toContain("1 FILN GT-7");
    expect(text).not.toContain("1 AUTH"); // cleared in the editor — omitted
  });

  it("drops a person-level pointer to a source's page image when the event already cites that page", () => {
    // MyHeritage-style leftover: the person points at the register page image
    // that already hangs off the book SOUR, while BIRT properly cites the
    // book at that page. Links-on-events file → the pointer is redundant.
    const { text, counts } = applyAll(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 DATE 15 JUN 1879
2 SOUR @S1@
3 PAGE 111
1 OBJE @M1@
0 @S1@ SOUR
1 TITL Krstna knjiga / Taufbuch - 04104 | Podzemelj
1 OBJE @M1@
0 @M1@ OBJE
1 FILE ${BOOK2}/?pg=111
0 TRLR`);
    const indi = text.split(/\n(?=0 )/).find((r) => r.startsWith("0 @I1@"))!;
    expect(indi).not.toContain("1 OBJE @M1@"); // pointer gone
    expect(text.match(/2 SOUR @S1@\n3 PAGE 111/g)).toHaveLength(1); // citation not duplicated
    expect(text).toMatch(/0 @S1@ SOUR\n(1 .*\n)*1 OBJE @M1@/); // page image stays on the book
    expect(counts.linksRemoved).toBe(1);
  });

  it("converts a person-level page-image pointer into an event citation when none exists", () => {
    const { text } = applyAll(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 OBJE @M1@
0 @S1@ SOUR
1 TITL Krstna knjiga / Taufbuch - 04104 | Podzemelj
1 OBJE @M1@
0 @M1@ OBJE
1 FILE ${BOOK2}/?pg=111
0 TRLR`);
    // Baptism book → the citation lands on a created BIRT; the pointer goes.
    expect(text).toMatch(/1 BIRT\n2 SOUR @S1@\n3 PAGE 111/);
    const indi = text.split(/\n(?=0 )/).find((r) => r.startsWith("0 @I1@"))!;
    expect(indi).not.toContain("1 OBJE @M1@");
  });

  it("detects the file's page-media style", () => {
    const eventStyle = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 SOUR @S1@
3 PAGE 111
2 OBJE @M1@
0 @S1@ SOUR
1 TITL Krstna knjiga
1 OBJE @M1@
0 @M1@ OBJE
1 FILE ${BOOK2}/?pg=111
0 TRLR`);
    expect(detectPageMediaStyle(eventStyle.records)).toBe("event");
    const sourceStyle = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 SOUR @S1@
3 PAGE 111
0 @S1@ SOUR
1 TITL Krstna knjiga
1 OBJE @M1@
0 @M1@ OBJE
1 FILE ${BOOK2}/?pg=111
0 TRLR`);
    expect(detectPageMediaStyle(sourceStyle.records)).toBe("source");
  });

  it("event page-media style: converted links get the page image beside the citation", () => {
    const { text } = applyAll(
      `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 WWW ${BOOK}/?pg=94
0 TRLR`,
      { pageMedia: "event" },
    );
    // Citation + the cited page's OBJE side by side on the event.
    expect(text).toMatch(/1 BIRT\n2 OBJE @O\d+@\n2 SOUR @S\d+@\n3 PAGE 94/);
    expect(text).toMatch(/0 @S\d+@ SOUR\n(1 .*\n)*1 OBJE @O\d+@/); // and on the source
  });

  it("event page-media style: a pointer already beside its citation stays untouched", () => {
    const src = `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 SOUR @S1@
3 PAGE 111
2 OBJE @M1@
0 @S1@ SOUR
1 TITL Krstna knjiga / Taufbuch - 04104 | Podzemelj
1 OBJE @M1@
0 @M1@ OBJE
1 FILE ${BOOK2}/?pg=111
0 TRLR`;
    // Auto-detects "event" (the one cited event carries its page image).
    const { text, report } = applyAll(src);
    expect(report.totalOccurrences).toBe(0); // nothing to organize
    expect(text.match(/2 OBJE @M1@/g)).toHaveLength(1);
    expect(text.match(/2 SOUR @S1@/g)).toHaveLength(1);
  });

  it("event page-media style: a person-level pointer moves beside the event citation", () => {
    const { text } = applyAll(
      `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 SOUR @S1@
3 PAGE 111
1 OBJE @M1@
0 @S1@ SOUR
1 TITL Krstna knjiga / Taufbuch - 04104 | Podzemelj
1 OBJE @M1@
0 @M1@ OBJE
1 FILE ${BOOK2}/?pg=111
0 TRLR`,
      { pageMedia: "event" },
    );
    const indi = text.split(/\n(?=0 )/).find((r) => r.startsWith("0 @I1@"))!;
    expect(indi).not.toContain("1 OBJE @M1@"); // person-level pointer gone
    expect(indi).toMatch(/1 BIRT\n2 OBJE @M1@\n2 SOUR @S1@\n3 PAGE 111/); // now beside the citation
  });

  it("fills a missing QUAY on the existing citation an occurrence folds into", () => {
    // Real shape: the person's page-media pointer converts, but the event
    // already cites the book at that page — the pointer folds in, and the
    // chosen quality must land on that existing citation.
    const src = (quayLine: string) => `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 SOUR @S1@
3 PAGE 78${quayLine}
1 OBJE @M1@
0 @S1@ SOUR
1 TITL Krstna knjiga / Taufbuch - 00001 | Adlešiči
1 OBJE @M1@
0 @M1@ OBJE
1 FILE ${BOOK2}/?pg=78
0 TRLR`;
    const { text } = applyAll(src(""), { quay: "3", pageMedia: "event" });
    expect(text).toMatch(/2 SOUR @S1@\n3 PAGE 78\n3 QUAY 3/);
    // An already-set QUAY is the user's data — never overwritten.
    const { text: kept } = applyAll(src("\n3 QUAY 1"), { quay: "3", pageMedia: "event" });
    expect(kept).toContain("3 QUAY 1");
    expect(kept).not.toContain("3 QUAY 3");
  });

  it("keeps the person-level page-image pointer in a doubled-links file", () => {
    // Same-URL link on person AND event elsewhere = the file doubles links on
    // purpose (MacFamilyTree style) — the pointer is house style, not noise.
    const { text } = applyAll(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 WWW https://en.geneanet.org/cemetery/view/5
1 BURI
2 WWW https://en.geneanet.org/cemetery/view/5
0 @I2@ INDI
1 OBJE @M1@
0 @S1@ SOUR
1 TITL Krstna knjiga / Taufbuch - 04104 | Podzemelj
1 OBJE @M1@
0 @M1@ OBJE
1 FILE ${BOOK2}/?pg=111
0 TRLR`);
    const indi = text.split(/\n(?=0 )/).find((r) => r.startsWith("0 @I2@"))!;
    expect(indi).toContain("1 OBJE @M1@");
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

  it("resolves a multi-family person's marriage link via the other spouse's copy of the page", () => {
    // Pavel married twice; the register page image hangs on him AND on his
    // first wife (single FAMS) — that shared page pins his citation to @F1@.
    const { text, report } = applyAll(
      `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Pavel /Križaj/
1 OBJE @M1@
1 FAMS @F1@
1 FAMS @F2@
0 @I2@ INDI
1 NAME Neža /Zavrl/
1 OBJE @M1@
1 FAMS @F1@
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
0 @F2@ FAM
1 HUSB @I1@
0 @S1@ SOUR
1 TITL Poročna knjiga / Trauungsbuch - 00899
1 OBJE @M1@
0 @M1@ OBJE
1 FILE ${BOOK}/?pg=51
0 TRLR`,
      { pageMedia: "event" },
    );
    const pavel = report.groups[0].members.find((m) => m.recordLabel.includes("Pavel"))!;
    expect(pavel).toMatchObject({ targetEvent: "MARR", targetFam: "@F1@" });
    // One citation + page image on @F1@'s created MARR; both pointers gone.
    expect(text).toMatch(/0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n1 MARR\n2 OBJE @M1@\n2 SOUR @S1@\n3 PAGE 51/);
    expect(text.match(/2 SOUR @S1@/g)).toHaveLength(1);
    expect(text).not.toMatch(/0 @F2@ FAM\n1 MARR/);
    expect(text).not.toContain("1 OBJE @M1@\n1 FAMS"); // no person-level pointers left
    const again = findReshapableLinks(dataset(text), undefined, { pageMedia: "event" });
    expect(again.groups).toHaveLength(0);
  });

  it("resolves the family whose MARR already cites the page and cleans the record-level leftovers", () => {
    // The state an earlier run leaves behind: the family's MARR is properly
    // cited (via the other spouse), but the two-marriage person still carries
    // the pointer and a record-level citation. Both move/fold into @F1@.
    const { text } = applyAll(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Pavel /Križaj/
1 OBJE @M1@
1 SOUR @S1@
2 PAGE 51
2 QUAY 3
1 FAMS @F1@
1 FAMS @F2@
0 @F1@ FAM
1 HUSB @I1@
1 MARR
2 DATE 30 JAN 1843
2 OBJE @M1@
2 SOUR @S1@
3 PAGE 51
3 QUAY 3
0 @F2@ FAM
1 HUSB @I1@
1 MARR
2 DATE 1850
0 @S1@ SOUR
1 TITL Poročna knjiga / Trauungsbuch - 00899
1 OBJE @M1@
0 @M1@ OBJE
1 FILE ${BOOK}/?pg=51
0 TRLR`);
    const pavel = text.split(/\n(?=0 )/).find((r) => r.startsWith("0 @I1@"))!;
    expect(pavel).not.toContain("OBJE @M1@");
    expect(pavel).not.toContain("SOUR @S1@");
    expect(text.match(/SOUR @S1@\n3 PAGE 51\n3 QUAY 3/g)).toHaveLength(1); // only on @F1@'s MARR
    const again = findReshapableLinks(dataset(text));
    expect(again.groups).toHaveLength(0);
  });

  it("a converted pointer settles without a citation quality, so the row clears", () => {
    // What a run leaves when the reader never picked a citation quality: the
    // citation is there, the page image beside it, and no QUAY on either.
    // The row used to be offered for ever — each apply found the citation
    // already written, wrote nothing at all, and the re-scan listed it again,
    // so a run holding only such rows reported "nothing happened".
    const converted = `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Pavel /Križaj/
1 OBJE @M1@
1 SOUR @S1@
2 PAGE 51
1 FAMS @F1@
1 FAMS @F2@
0 @F1@ FAM
1 HUSB @I1@
0 @F2@ FAM
1 HUSB @I1@
0 @S1@ SOUR
1 TITL Poročna knjiga / Trauungsbuch - 00899
1 OBJE @M1@
0 @M1@ OBJE
1 FILE ${BOOK}/?pg=51
0 TRLR`;
    expect(scan(converted).groups).toHaveLength(0);
    // And applying it anyway is a no-op rather than a rewrite.
    const { text } = applyAll(converted);
    expect(text).toBe(serializeGedcom(dataset(converted).records));
  });

  it("an unresolvable multi-family marriage link settles at record level and stops being reported", () => {
    // No evidence ties the page to either family. With the citation already
    // beside the pointer (QUAY set), there is nothing left to organize.
    const settled = `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Pavel /Križaj/
1 OBJE @M1@
1 SOUR @S1@
2 PAGE 51
2 QUAY 3
1 FAMS @F1@
1 FAMS @F2@
0 @F1@ FAM
1 HUSB @I1@
0 @F2@ FAM
1 HUSB @I1@
0 @S1@ SOUR
1 TITL Poročna knjiga / Trauungsbuch - 00899
1 OBJE @M1@
0 @M1@ OBJE
1 FILE ${BOOK}/?pg=51
0 TRLR`;
    expect(scan(settled).groups).toHaveLength(0);

    // Missing QUAY = still work to do: the apply fills it (and keeps the
    // pointer beside the citation), after which the rescan finds nothing.
    const { text, report } = applyAll(settled.replace("\n2 QUAY 3", ""), { quay: "3" });
    expect(report.totalOccurrences).toBe(1);
    const pavel = text.split(/\n(?=0 )/).find((r) => r.startsWith("0 @I1@"))!;
    expect(pavel).toContain("1 OBJE @M1@");
    expect(pavel).toContain("1 SOUR @S1@\n2 PAGE 51\n2 QUAY 3");
    expect(findReshapableLinks(dataset(text)).groups).toHaveLength(0);
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
    // The memorial id is the filing number, not part of the title.
    expect(grave.proposed.title).toBe("Anton Grudnik - Find a Grave");
    expect(grave.proposed.filingNumber).toBe("12345");
    expect(text).toContain("1 TITL Anton Grudnik - Find a Grave");
    expect(text).toContain("1 FILN 12345");
    expect(text).toMatch(/1 BURI\n2 SOUR @S1@/); // record-level note moved to a created BURI
    expect(text).toMatch(/1 DEAT\n2 SOUR @S1@/); // DEAT is an acceptable spot for a grave — stays
  });

  it("treats Legacy.com obituaries as death evidence: DEAT placement, name title, id as filing number", () => {
    const { text, report } = applyAll(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NOTE https://www.legacy.com/us/obituaries/theherald-news/name/peter-ancel-obituary?id=26608778
0 TRLR`);
    const g = report.groups.find((x) => x.site === "legacy")!;
    expect(g.bookType).toBe("death");
    expect(g.proposed.title).toBe("Peter Ancel - Legacy.com");
    expect(g.proposed.filingNumber).toBe("26608778");
    expect(text).toMatch(/1 DEAT\n2 SOUR @S1@/); // record-level note moved to a created DEAT
    expect(text).toContain("1 TITL Peter Ancel - Legacy.com");
    expect(text).toContain("1 FILN 26608778");
  });

  it("gives 'other' links slug titles and classifies obituary/funeral URLs as death evidence", () => {
    const report = scan(
      `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 WWW https://www.tezakfuneralhome.com/obituaries/ann-vidmar
0 @I2@ INDI
1 WWW https://www.komunala-kranj.si/pogreb-angela-zupancic-v-druzinskem-krogu
0 @I3@ INDI
1 WWW https://www.preddvor.si/objava/773942
0 TRLR`,
      ["other"],
    );
    const obit = report.groups.find((g) => g.bookUrl.includes("tezak"))!;
    expect(obit.proposed.title).toBe("Ann Vidmar - tezakfuneralhome.com");
    expect(obit.bookType).toBe("death"); // "/obituaries/" in the URL
    const pogreb = report.groups.find((g) => g.bookUrl.includes("komunala"))!;
    expect(pogreb.proposed.title).toBe("Pogreb Angela Zupancic V Druzinskem Krogu - komunala-kranj.si");
    expect(pogreb.bookType).toBe("death");
    const idPage = report.groups.find((g) => g.bookUrl.includes("preddvor"))!;
    expect(idPage.proposed.title).toBe("https://www.preddvor.si/objava/773942"); // no name-like slug
    expect(idPage.bookType).toBe("unknown");
  });

  it("recognizes Geneanet member-tree person pages (own group, not cemeteries)", () => {
    // Semicolon-separated GeneWeb params; pz/nz (the sosa root) must not match.
    const rec = recognizeSourceUrl("http://gw.geneanet.org/hawlina?lang=de;pz=peter;nz=hawlina;ocz=0;p=rajko;n=vute")!;
    expect(rec.site).toBe("geneanettree");
    expect(rec.bookUrl).toBe("https://gw.geneanet.org/hawlina?lang=en&p=rajko&n=vute");
    // The tree's owner is the author, shown in the title.
    expect(rec.proposed.title).toBe("Rajko Vute - hawlina - Geneanet Trees");
    expect(rec.proposed.author).toBe("hawlina");

    // HTML-escaped params and a stray trailing paren from prose.
    const esc = recognizeSourceUrl("http://gw.geneanet.org/rfonda?lang=en&amp;p=jacobus&amp;n=magajna)")!;
    expect(esc.proposed.title).toBe("Jacobus Magajna - rfonda - Geneanet Trees");

    // Same person, oc disambiguator kept in the group identity.
    const oc = recognizeSourceUrl("https://gw.geneanet.org/hawlina?lang=en&pz=peter&nz=hawlina&p=janez&n=plut&oc=26")!;
    expect(oc.bookUrl).toBe("https://gw.geneanet.org/hawlina?lang=en&p=janez&n=plut&oc=26");
  });

  it("fetches the tree person's name from the rendered page title", async () => {
    // A trailing "(26)" is GeneWeb's same-name occurrence ordinal — stripped.
    const meta = await fetchBookMeta(
      "geneanettree",
      "https://gw.geneanet.org/hawlina?lang=en&p=janez&n=plut&oc=26",
      async () => `Title: Family tree of Janez Plut (26)\n\nURL Source: https://gw.geneanet.org/hawlina\n\nMarkdown Content:`,
    );
    expect(meta).toEqual({ title: "Janez Plut - hawlina - Geneanet Trees", author: "hawlina" });
  });

  it("groups Google Books by volume id and YouTube by video id", () => {
    const gb = recognizeSourceUrl(
      "https://books.google.si/books?id=90Q_AAAAIBAJ&pg=PA18&dq=joseph+matthew+yakopich&hl=en#v=onepage&q=joseph&f=false",
    )!;
    expect(gb.site).toBe("googlebooks");
    expect(gb.bookUrl).toBe("https://books.google.com/books?id=90Q_AAAAIBAJ");
    expect(gb.page).toBe("18"); // pg=PA18
    expect(gb.proposed.title).toBe("90Q_AAAAIBAJ - Google Books");
    expect(gb.proposed.filingNumber).toBe("90Q_AAAAIBAJ");

    const yt = recognizeSourceUrl("https://www.youtube.com/watch?v=lD5eGiGwlZs")!;
    expect(yt.site).toBe("youtube");
    expect(yt.bookUrl).toBe("https://www.youtube.com/watch?v=lD5eGiGwlZs");
    expect(yt.proposed.title).toBe("lD5eGiGwlZs - YouTube");
    expect(recognizeSourceUrl("https://youtu.be/lD5eGiGwlZs")?.bookUrl).toBe("https://www.youtube.com/watch?v=lD5eGiGwlZs");
  });

  it("recognizes Newspapers.com images with Ancestry citation prose", () => {
    // Real Ancestry PAGE shape: paper; Publication Date; Publication Place; URL.
    const rec = recognizeSourceUrl(
      "https://www.newspapers.com/image/504323954/?article=c0efbc58-dd91-411f-9635-99cee122af5e&focus=0.04,0.60&xid=3355",
      "The Windsor Star; Publication Date: 23 Jun 1998; Publication Place: Windsor, Ontario, Canada; URL: https://www.newspapers.com/image/504323954/",
    )!;
    expect(rec.site).toBe("newspapers");
    expect(rec.bookUrl).toBe("https://www.newspapers.com/image/504323954/");
    expect(rec.proposed.title).toBe("The Windsor Star, 23 Jun 1998 - Newspapers.com");
    expect(rec.proposed.place).toBe("Windsor, Ontario, Canada");
    expect(rec.proposed.filingNumber).toBe("504323954");
    expect(rec.proposed.dateRange).toBe("23 Jun 1998");

    // Ancestry's slashed date variant normalizes; a bare URL gets the id title.
    const slashed = recognizeSourceUrl(
      "https://www.newspapers.com/image/502046098/",
      "The Windsor Star; Publication Date: 13/ Jul/ 1967; Publication Place: Windsor, Ontario, Canada",
    )!;
    expect(slashed.proposed.title).toBe("The Windsor Star, 13 Jul 1967 - Newspapers.com");
    const bare = recognizeSourceUrl("https://www.newspapers.com/image/502046098/")!;
    expect(bare.proposed.title).toBe("502046098 - Newspapers.com");
  });

  it("converts a Newspapers.com obituary citation into a dated source on DEAT", () => {
    const url =
      "https://www.newspapers.com/image/504323954/?article=c0efbc58-dd91-411f-9635-99cee122af5e&xid=3355";
    const { text, report } = applyAll(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 DEAT
2 DATE 23 JUN 1998
1 SOUR @S1@
2 PAGE The Windsor Star; Publication Date: 23 Jun 1998; Publication Place: Windsor, Ontario, Canada; URL: ${url}
0 @I2@ INDI
1 BIRT
2 PLAC Windsor, Ontario, Canada
0 @S1@ SOUR
1 TITL Canada, Newspapers.com™ Obituary Index, 1800s-current
0 TRLR`);
    // The collection title classifies the group as death evidence.
    expect(report.groups.find((g) => g.site === "newspapers")?.bookType).toBe("death");
    expect(text).toContain("1 TITL The Windsor Star, 23 Jun 1998 - Newspapers.com");
    expect(text).toContain("1 PLAC Windsor, Ontario, Canada");
    expect(text).toContain("1 FILN 504323954");
    // The scraped date is rewritten in the file's own date format (its dates
    // are uppercase month-word), not left in the citation's casing.
    expect(text).toContain("1 DATE 23 JUN 1998");
    expect(text).toContain(`1 FILE ${url}`); // the clipping URL stays the media link
    expect(text).toMatch(/1 DEAT\n2 DATE 23 JUN 1998\n2 SOUR @S2@/); // relocated onto the death
  });

  it("recognizes Wikipedia articles across languages and URL forms", () => {
    const en = recognizeSourceUrl("https://en.wikipedia.org/wiki/Primo%C5%BE_Trubar")!;
    expect(en.site).toBe("wikipedia");
    expect(en.bookUrl).toBe("https://en.wikipedia.org/wiki/Primo%C5%BE_Trubar");
    expect(en.proposed.title).toBe("Primož Trubar - Wikipedia");

    // Mobile + index.php form land in the same group as the plain article.
    const mobile = recognizeSourceUrl("https://sl.m.wikipedia.org/wiki/Primo%C5%BE_Trubar")!;
    expect(mobile.site).toBe("wikipedia");
    const indexPhp = recognizeSourceUrl("https://sl.wikipedia.org/w/index.php?title=Primo%C5%BE_Trubar&oldid=5")!;
    expect(indexPhp.proposed.title).toBe("Primož Trubar - Wikipedia");
  });

  it("recognizes Slovenska biografija entries by their sbi id", () => {
    const rec = recognizeSourceUrl("https://www.slovenska-biografija.si/oseba/sbi729148/")!;
    expect(rec.site).toBe("biografija");
    expect(rec.bookUrl).toBe("https://www.slovenska-biografija.si/oseba/sbi729148/");
    expect(rec.proposed.title).toBe("sbi729148 - Slovenska biografija");
    expect(rec.proposed.filingNumber).toBe("sbi729148");
    expect(recognizeSourceUrl("https://www.slovenska-biografija.si/rodbina/sbi546925/")?.site).toBe("biografija");
  });

  it("recognizes Obrazi slovenskih pokrajin person pages", () => {
    const rec = recognizeSourceUrl("http://obrazislovenskihpokrajin.si/oseba/primoz-trubar")!;
    expect(rec.site).toBe("obrazi");
    expect(rec.bookUrl).toBe("https://www.obrazislovenskihpokrajin.si/oseba/primoz-trubar/");
    expect(rec.proposed.title).toBe("Primoz Trubar - Obrazi slovenskih pokrajin");
  });

  it("maps format overrides to reshape options, absent = auto", () => {
    expect(reshapeOptionsFromOverrides(undefined)).toEqual({
      pageMedia: "auto",
      sourceLayout: "auto",
      baptism: "auto",
      doubledLinks: "auto",
      sourceCoverage: "auto",
    });
    expect(reshapeOptionsFromOverrides({ pageMedia: "event", baptism: "BAPM", date: "DD.MM.YYYY" })).toEqual({
      pageMedia: "event",
      sourceLayout: "auto",
      baptism: "BAPM",
      doubledLinks: "auto",
      sourceCoverage: "auto",
    });
  });

  it("honors format overrides: baptism target, doubled links, source layout, citation placement", () => {
    // Baptism override: the file habit would say BIRT (no BAPM citations),
    // the override forces BAPM.
    const { text: bapm } = applyAll(
      `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NOTE Krstna knjiga: ${BOOK}/?pg=94
0 TRLR`,
      { baptism: "BAPM" },
    );
    expect(bapm).toMatch(/1 BAPM\n2 SOUR @S\d+@/);

    // Doubled-links override "keep": a record+event duplicated link keeps both
    // citations even though the file itself has no doubling habit.
    const doubled = `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 WWW ${BOOK}/?pg=94
1 BIRT
2 WWW ${BOOK}/?pg=94
0 TRLR`;
    const { text: kept } = applyAll(doubled, { doubledLinks: "keep" });
    expect(kept.match(/\d SOUR @S\d+@/g)?.length).toBe(2);
    const { text: folded } = applyAll(doubled, { doubledLinks: "fold" });
    expect(folded.match(/\d SOUR @S\d+@/g)?.length).toBe(1);

    // Source-layout override "repository" creates the site REPO in a file
    // whose own sources wouldn't classify as repository-style.
    const { text: repo } = applyAll(
      `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NOTE ${BOOK}/?pg=94
0 TRLR`,
      { sourceLayout: "repository" },
    );
    expect(repo).toContain("0 @R1@ REPO");

    // …and choosing another shape never costs a file the repositories it
    // keeps: page links are a record shape, not a statement about repositories.
    const withRepos = `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NOTE ${BOOK2}/?pg=94
0 @S1@ SOUR
1 TITL Krstna knjiga - 03869
1 REPO @R9@
1 OBJE @O1@
0 @O1@ OBJE
1 FILE ${BOOK}/?pg=94
0 @R9@ REPO
1 NAME Nadškofijski arhiv Ljubljana
0 TRLR`;
    for (const layout of ["auto", "paginated"] as const) {
      const { text } = applyAll(withRepos, { sourceLayout: layout });
      expect(text.match(/\d REPO @R\d+@/g)?.length).toBe(2);
    }

    // Citation-placement override on the Add Source helper.
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 SOUR @S1@
0 @S1@ SOUR
1 TITL X
0 TRLR`);
    // The file habit is record-level (1 record citation, 0 event) → no target;
    // the "event" override forces the smart event anyway.
    expect(smartCitationTarget(ds.records, "geneanet", undefined)).toBeUndefined();
    expect(smartCitationTarget(ds.records, "geneanet", undefined, { citations: "event" })).toEqual({
      eventTag: "BURI",
      onFam: false,
    });
    expect(
      smartCitationTarget(ds.records, "matricula", "Krstna knjiga", { citations: "event", baptism: "BAPM" }),
    ).toEqual({ eventTag: "BAPM", onFam: false });
  });

  it("counts an HTML note's <a href=url>url</a> as ONE occurrence", () => {
    // Košir-style files (MacFamilyTree HTML notes) repeat the URL as the
    // anchor text — that must not become two citations.
    const report = scan(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NOTE <p style="text-align: left;" dir="ltr"><a href="${BOOK}/?pg=22">${BOOK}/?pg=22</a></p>
0 TRLR`);
    expect(report.groups).toHaveLength(1);
    expect(report.groups[0].members).toHaveLength(1);
    expect(report.totalOccurrences).toBe(1);
  });

  it("titles generic document links by file name + host", () => {
    const report = scan(
      `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 WWW https://arhiv.gorenjskiglas.si/digitar/16298754_1992_6_L.pdf
0 TRLR`,
      ["other"],
    );
    expect(report.groups[0].proposed.title).toBe("16298754_1992_6_L.pdf - arhiv.gorenjskiglas.si");
  });

  it("treats BillionGraves graves like Find a Grave: BURI placement, id as filing number", () => {
    const { text, report } = applyAll(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NOTE https://billiongraves.com/grave/Polona-Renko/18374346
0 TRLR`);
    const g = report.groups.find((x) => x.site === "billiongraves")!;
    expect(g.bookType).toBe("burial");
    expect(g.proposed.title).toBe("Polona Renko - BillionGraves");
    expect(g.proposed.filingNumber).toBe("18374346");
    expect(text).toMatch(/1 BURI\n2 SOUR @S1@/);
    expect(text).toContain("1 FILN 18374346");
  });

  it("groups dLib.si details and stream links by URN, id as filing number", () => {
    const { text, report } = applyAll(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NOTE Osmrtnica: https://dlib.si/details/URN:NBN:SI:DOC-2CEAMMVU
1 OBJE
2 FILE https://www.dlib.si/stream/URN:NBN:SI:DOC-2CEAMMVU/51a3aa79-0f72-45c6-8746-f6ed95898f33/PDF
0 TRLR`);
    const g = report.groups.find((x) => x.site === "dlib")!;
    expect(g.members).toHaveLength(2); // details page and PDF stream share the document
    expect(g.bookUrl).toBe("https://dlib.si/details/URN:NBN:SI:DOC-2CEAMMVU");
    expect(g.proposed.title).toBe("URN:NBN:SI:DOC-2CEAMMVU - dLib.si"); // offline: URN distinguishes documents
    expect(g.proposed.filingNumber).toBe("URN:NBN:SI:DOC-2CEAMMVU");
    expect(text).toContain("1 FILN URN:NBN:SI:DOC-2CEAMMVU");
  });

  it("treats SIstory.si WW records as death evidence with the quoted person name", () => {
    const { text, report } = applyAll(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 SOUR INZ, »Fani Grudnik«, Smrtne žrtve druge svetovne vojne, https://www.sistory.si/ww2/F01EDD85-E7BB-4D18-9599-1428852BAA1F
0 TRLR`);
    const g = report.groups.find((x) => x.site === "sistory")!;
    expect(g.bookType).toBe("death");
    // The record id means nothing to a reader — filing number, not title.
    expect(g.proposed.title).toBe("Fani Grudnik - WW2 - SIstory.si");
    expect(g.proposed.filingNumber).toBe("F01EDD85-E7BB-4D18-9599-1428852BAA1F");
    expect(text).toMatch(/1 DEAT\n2 SOUR @S1@/); // inline citation moved onto a created DEAT
    expect(text).toContain("1 TITL Fani Grudnik - WW2 - SIstory.si");
    expect(text).toContain("1 FILN F01EDD85-E7BB-4D18-9599-1428852BAA1F");
  });

  it("recognizes short numeric WW1 record ids, keeping the id in the offline title", () => {
    const rec = recognizeSourceUrl("https://www.sistory.si/ww1/168")!;
    expect(rec.site).toBe("sistory");
    expect(rec.bookUrl).toBe("https://www.sistory.si/ww1/168");
    expect(rec.proposed.title).toBe("WW1 - 168 - SIstory.si"); // no name available offline
    expect(rec.proposed.filingNumber).toBe("168");
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
    expect(g.proposed.title).toBe("Matija Čehun (1877) - WW1 - SIstory.si"); // name from the zv1 id
    expect(g.proposed.filingNumber).toBe("15691");
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

  it("moves a grave citation to BURI on the strength of its own words", () => {
    // No grave site to recognize here — the cemetery is named in the citation
    // itself, and that is enough to place it.
    const { text } = applyAll(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 SOUR Pokopališče Kranj ${BOOK}/?pg=7
0 TRLR`);
    expect(text).toMatch(/1 BURI\n(?:2 (?!SOUR)[^\n]*\n)*2 SOUR @S1@\n3 PAGE 7/);
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
      address: "Pokopališče Zgornje Bitnje", // cemetery → BURI ADDR
      page: "P02", // plot = where within the cemetery → citation PAGE
      title: "Pokopališče Zgornje Bitnje - Geneanet Cemeteries",
    });
  });

  it("enriches a Find a Grave group with the memorial's name", async () => {
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
      title: "Frank Gorishek (1881-1968) - Find a Grave",
    });
  });

  it("parses the Find a Grave Burial block: cemetery into the title and address, location as place", async () => {
    // Trimmed from the rendering relay's markdown for a real memorial
    // (captured 2026-07-15) — FAG blocks the plain relays.
    const GRAVE_FAG_MD = `Title: Adam Troha (1868-1952) - Find a Grave Memorial

URL Source: https://www.findagrave.com/memorial/273320916/adam-troha

Markdown Content:
# Adam Troha

Birth 1868 Death 1952 (aged 83–84)Burial

[St. Theresa of Avila Catholic Church Cemetery](https://www.findagrave.com/cemetery/2622358/st.-theresa-of-avila-catholic-church-cemetery)

Ravna Gora, Općina Ravna Gora, Primorsko-Goranska, Croatia[_Add to Map_](https://www.findagrave.com/memorial/273320916/edit#gps-location)

Memorial ID 273320916 273320916`;
    const meta = await fetchBookMeta("findagrave", "https://www.findagrave.com/memorial/273320916", async () => GRAVE_FAG_MD);
    expect(meta).toEqual({
      title: "Adam Troha (1868-1952) - St. Theresa of Avila Catholic Church Cemetery - Find a Grave",
      place: "Ravna Gora, Općina Ravna Gora, Primorsko-Goranska, Croatia",
      address: "St. Theresa of Avila Catholic Church Cemetery",
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

  it("falls back to the breadcrumb archive link when the title carries no agency", async () => {
    // Some page shapes title only `{type} | {id}` — the agency then comes from
    // the breadcrumb's archive link (`Začetna / Slovenia / {archive} / {parish}`).
    const PAGE_NO_AGENCY = `<html><head><title>Krstna knjiga / Taufbuch | 01723</title></head>
<body><ol class="breadcrumb"><li><a href="/en/">Začetna</a></li><li><a href="/en/slovenia/">Slovenia</a></li>
<li><a href="/en/slovenia/ljubljana/">Nadškofijski arhiv Ljubljana</a></li>
<li><a href="/en/slovenia/ljubljana/podzemelj/">Podzemelj</a></li></ol>
<table class="table table-register-data">
<tr><th>Parish/place</th><td><a href="/en/slovenia/ljubljana/podzemelj/">Podzemelj</a></td>
<tr><th>ID</th><td>01723</td>
<tr><th>Type</th><td>Krstna knjiga / Taufbuch</td>
<tr><th>Date from</th><td>Jan. 1, 1675</td>
<tr><th>Date to</th><td>Dec. 31, 1725</td>
</table></body></html>`;
    const meta = await fetchBookMeta(
      "matricula",
      "https://data.matricula-online.eu/sl/slovenia/ljubljana/podzemelj/01723",
      async () => PAGE_NO_AGENCY,
    );
    expect(meta?.agency).toBe("Nadškofijski arhiv Ljubljana"); // not the parish link, not "Ljubljana"
    expect(meta?.title).toBe("Krstna knjiga / Taufbuch - 01723 | Podzemelj");
    expect(meta?.dateRange).toBe("1675-1725");
  });

  it("parses the BillionGraves grave page's schema.org JSON-LD", async () => {
    // Trimmed from the real grave page (captured 2026-07-15).
    const BG_HTML = `<html><head><title>Polona Renko (1927 - 1963) | BillionGraves GPS Headstones</title>
<script type="application/ld+json">${JSON.stringify([
      {
        "@context": "https://schema.org",
        "@type": "Person",
        name: "Polona Renko",
        birthDate: "1927-11-8",
        deathDate: "1963-7-3",
        deathPlace: {
          "@type": "Place",
          name: "Mirogoj",
          address: { "@type": "PostalAddress", addressLocality: "Zagreb", addressRegion: "Zagreb", addressCountry: "Croatia" },
        },
      },
    ])}</script></head><body></body></html>`;
    const meta = await fetchBookMeta("billiongraves", "https://billiongraves.com/grave/Polona-Renko/18374346", async () => BG_HTML);
    expect(meta).toEqual({
      title: "Polona Renko - Mirogoj - BillionGraves",
      place: "Zagreb, Croatia", // locality/region dedupe
      address: "Mirogoj",
    });
  });

  it("parses Google Books page titles and YouTube oEmbed JSON", async () => {
    // Reader page title captured 2026-07-15 — localized "Google Knjige" suffix.
    const gb = await fetchBookMeta(
      "googlebooks",
      "https://books.google.com/books?id=90Q_TESTIBAJ",
      async (url) => {
        // The About page has no issue date — the fetch must stay on the reader.
        expect(url).toContain("&printsec=frontcover");
        expect(url).toContain("&hl=en");
        return `<html><head><title>The Windsor Star - Google Knjige</title></head></html>`;
      },
    );
    // No dated volume heading (a book): the volume id stays in the title —
    // one paper spans many volumes and nothing else tells them apart.
    expect(gb).toEqual({ title: "The Windsor Star - 90Q_TESTIBAJ - Google Books" });

    // Newspaper reader heading captured 2026-07-15: the issue's date sits in
    // the h1's span — it names the issue and fills the source DATE.
    const news = await fetchBookMeta(
      "googlebooks",
      "https://books.google.com/books?id=92Q_TESTIBAJ",
      async () =>
        `<html><head><title>The Windsor Star - Google Books</title></head><body>` +
        `<h1 class="gb-volume-title" dir=ltr>The Windsor Star <span dir=ltr>May 23, 1969</span></h1></body></html>`,
    );
    expect(news).toEqual({ title: "The Windsor Star, May 23, 1969 - Google Books", dateRange: "May 23, 1969" });

    // The rendering relay flattens the same heading to markdown. The date
    // format varies per volume (captured 2026-07-15: "May 23, 1969",
    // "Dec 27, 1975", "13 Feb 1965") — whatever follows the known name counts.
    const md = await fetchBookMeta(
      "googlebooks",
      "https://books.google.com/books?id=93Q_TESTIBAJ",
      async () => `Title: The Windsor Star\n\nMarkdown Content:\n# The Windsor Star May 23, 1969\n`,
    );
    expect(md).toEqual({ title: "The Windsor Star, May 23, 1969 - Google Books", dateRange: "May 23, 1969" });
    const mdAbbrev = await fetchBookMeta(
      "googlebooks",
      "https://books.google.com/books?id=94Q_TESTIBAJ",
      async () => `Title: The Windsor Star\n\nMarkdown Content:\n# The Windsor Star Dec 27, 1975\n`,
    );
    expect(mdAbbrev).toEqual({ title: "The Windsor Star, Dec 27, 1975 - Google Books", dateRange: "Dec 27, 1975" });
    const mdDayFirst = await fetchBookMeta(
      "googlebooks",
      "https://books.google.com/books?id=95Q_TESTIBAJ",
      async () => `Title: The Windsor Star\n\nMarkdown Content:\n# The Windsor Star 13 Feb 1965\n`,
    );
    expect(mdDayFirst).toEqual({ title: "The Windsor Star, 13 Feb 1965 - Google Books", dateRange: "13 Feb 1965" });
    // A dateless heading (a plain book) keeps the volume-id title.
    const mdBook = await fetchBookMeta(
      "googlebooks",
      "https://books.google.com/books?id=96Q_TESTIBAJ",
      async () => `Title: Zgodovina Slovencev\n\nMarkdown Content:\n# Zgodovina Slovencev\n`,
    );
    expect(mdBook).toEqual({ title: "Zgodovina Slovencev - 96Q_TESTIBAJ - Google Books" });

    // A relay that fails to render titles the page with the URL — no name.
    const gbFail = await fetchBookMeta(
      "googlebooks",
      "https://books.google.com/books?id=91Q_TESTIBAJ",
      async () => `Title: https://books.google.com/books?id=91Q_TESTIBAJ\n\nMarkdown Content:`,
    );
    expect(gbFail).toBeUndefined();

    // oEmbed response captured 2026-07-15.
    const yt = await fetchBookMeta(
      "youtube",
      "https://www.youtube.com/watch?v=lD5eGiGwlZt",
      async (url) => {
        expect(url).toContain("youtube.com/oembed?url=");
        return JSON.stringify({ title: "Štefanovo na Kališču, 26.december 2010", author_name: "Marjan Rekar" });
      },
    );
    expect(yt).toEqual({ title: "Štefanovo na Kališču, 26.december 2010 - YouTube", author: "Marjan Rekar" });
  });

  it("parses Wikipedia and Slovenska biografija page titles", async () => {
    // Page titles captured 2026-07-15 — localized Wikipedia suffix, and the
    // biografija heading with life years.
    const wiki = await fetchBookMeta(
      "wikipedia",
      "https://sl.wikipedia.org/wiki/Primo%C5%BE_Trubar",
      async () => `<html><head><title>Primož Trubar - Wikipedija, prosta enciklopedija</title></head></html>`,
    );
    expect(wiki).toEqual({ title: "Primož Trubar - Wikipedia" });

    const sb = await fetchBookMeta(
      "biografija",
      "https://www.slovenska-biografija.si/oseba/sbi729148/",
      async () => `<html><head><title>Trubar, Primož (med 1507 in 1509–1586) - Slovenska biografija</title></head></html>`,
    );
    expect(sb).toEqual({ title: "Trubar, Primož (med 1507 in 1509–1586) - Slovenska biografija" });

    // A missing entry's "page not found" title is not a person's name.
    const gone = await fetchBookMeta(
      "biografija",
      "https://www.slovenska-biografija.si/oseba/sbi132200/",
      async () => `<html><head><title>Stran ne obstaja - Slovenska biografija</title></head></html>`,
    );
    expect(gone).toBeUndefined();

    // Page title captured 2026-07-15 — pipe-separated site suffix.
    const obrazi = await fetchBookMeta(
      "obrazi",
      "https://www.obrazislovenskihpokrajin.si/oseba/primoz-trubar/",
      async () => `<html><head><title>Primož TRUBAR | Obrazi slovenskih pokrajin</title></head></html>`,
    );
    expect(obrazi).toEqual({ title: "Primož TRUBAR - Obrazi slovenskih pokrajin" });
  });

  it("parses the dLib.si details page's metadata table", async () => {
    // Trimmed from the real details page for URN:NBN:SI:DOC-2CEAMMVU
    // (captured 2026-07-15) — server-rendered key/value rows.
    const DLIB_HTML = `<html><head><title>	dLib.si - Dolenjski list</title></head><body>
<div class="col-xs-12 col-sm-8 col-md-9 col-lg-8 metadata">
<div class="row"><div class="col-xs-12 col-sm-3 col-md-2 col-lg-2 key">Jezik</div>
<div class="col-xs-12 col-sm-9 col-md-10 col-lg-10 value">slovenski</div></div>
<div class="row"><div class="col-xs-12 col-sm-3 col-md-2 col-lg-2 key">Vir</div>
<div class="col-xs-12 col-sm-9 col-md-10 col-lg-10 value"><a href="/results/x"><a href="/results/y">Dolenjski list</a></a></div></div>
<div class="row"><div class="col-xs-12 col-sm-3 col-md-2 col-lg-2 key">Leto</div>
<div class="col-xs-12 col-sm-9 col-md-10 col-lg-10 value">08.06.1978</div></div>
<div class="row"><div class="col-xs-12 col-sm-3 col-md-2 col-lg-2 key">Številčenje</div>
<div class="col-xs-12 col-sm-9 col-md-10 col-lg-10 value">letnik 29, <a href="/results/z">številka 23</a></div></div>
<div class="row"><div class="col-xs-12 col-sm-3 col-md-2 col-lg-2 key">Založnik</div>
<div class="col-xs-12 col-sm-9 col-md-10 col-lg-10 value"><a href="/results/p">Dolenjski list</a></div></div>
<div class="row"><div class="col-xs-12 col-sm-3 col-md-2 col-lg-2 key">Izvor</div>
<div class="col-xs-12 col-sm-9 col-md-10 col-lg-10 value">Knjižnica Mirana Jarca Novo mesto</div></div>
</div></body></html>`;
    const meta = await fetchBookMeta("dlib", "https://dlib.si/details/URN:NBN:SI:DOC-2CEAMMVU", async () => DLIB_HTML);
    expect(meta).toEqual({
      title: "Dolenjski list, 08.06.1978, letnik 29, številka 23 - dLib.si",
      periodical: "Dolenjski list",
      publisher: "Dolenjski list",
      agency: "Knjižnica Mirana Jarca Novo mesto",
      dateRange: "08.06.1978",
    });
  });

  it("parses the SIstory record from the __NEXT_DATA__ JSON (client-rendered page)", async () => {
    // The real record page ships an empty <title> and no visible content —
    // everything sits in the Next.js data island (captured 2026-07-15).
    const NEXT_HTML = `<!DOCTYPE html><html lang="slv"><head><title data-next-head=""></title></head>
<body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: {
        pageProps: {
          data: {
            war: "ww2",
            titles: ["Katarina Abdonec"],
            contributorGroups: [{ key: "inz", name: "Inštitut za novejšo zgodovino", verified: true }],
            contributors: [
              { firstName: "INZ", lastName: "" },
              { firstName: "Tadeja", lastName: "Tominšek" },
              { firstName: "Tamara", lastName: "Logar" },
            ],
          },
        },
      },
    })}</script></body></html>`;
    const meta = await fetchBookMeta("sistory", "https://www.sistory.si/ww2/AA11BB22-0000-4948-AA8D-BA678EB4E05D", async () => NEXT_HTML);
    expect(meta).toEqual({
      title: "Katarina Abdonec - WW2 - SIstory.si",
      author: "INZ, Tadeja Tominšek, Tamara Logar",
      periodical: "Smrtne žrtve druge svetovne vojne in zaradi nje v Sloveniji",
      place: "Ljubljana",
      agency: "Inštitut za novejšo zgodovino",
    });
  });

  it("parses the SIstory record page's Citiranje section", async () => {
    const SISTORY_HTML = `<html><head><title>SIstory | Žrtve II. sv. vojne</title></head>
<body><h1>Katarina Abdonec</h1>
<p>identifikator: CE087EAC-BF00-4948-AA8D-BA678EB4E05D</p>
<h2>Citiranje</h2>
<p>INZ, Tadeja Tominšek, Tamara Logar, »Katarina Abdonec«, Smrtne žrtve druge svetovne vojne in
zaradi nje v Sloveniji (Ljubljana: Inštitut za novejšo zgodovino, 2026), pridobljeno 15. 7. 2026,
https://www.sistory.si/ww2/CE087EAC-BF00-4948-AA8D-BA678EB4E05D</p></body></html>`;
    const meta = await fetchBookMeta(
      "sistory",
      "https://www.sistory.si/ww2/CE087EAC-BF00-4948-AA8D-BA678EB4E05D",
      async () => SISTORY_HTML,
    );
    // The Citiranje text parses exactly like a pasted citation — full author
    // list, collection, place + institute — and the record id stays out of
    // the title.
    expect(meta).toEqual({
      title: "Katarina Abdonec - WW2 - SIstory.si",
      author: "INZ, Tadeja Tominšek, Tamara Logar",
      periodical: "Smrtne žrtve druge svetovne vojne in zaradi nje v Sloveniji",
      place: "Ljubljana",
      agency: "Inštitut za novejšo zgodovino",
    });
  });

  it("fetchBookMeta parses per-site and caches by book", async () => {
    let calls = 0;
    const fetchHtml = async () => {
      calls++;
      return GRAVE_MD;
    };
    const meta = await fetchBookMeta("geneanet", "https://en.geneanet.org/cemetery/view/424242", fetchHtml);
    expect(meta).toEqual({
      place: "Žabnica, Slovenia",
      address: "Pokopališče Zgornje Bitnje",
      page: "P02",
      title: "Pokopališče Zgornje Bitnje - Geneanet Cemeteries",
    });
    await fetchBookMeta("geneanet", "https://en.geneanet.org/cemetery/view/424242", fetchHtml);
    expect(calls).toBe(1); // second lookup of the same book served from cache
  });
});

describe("smartCitationTarget — event placement for Add Source", () => {
  const EVENT_STYLE = `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 SOUR @S1@
1 DEAT
2 SOUR @S1@
0 @S1@ SOUR
1 TITL Book
0 TRLR`;
  const RECORD_STYLE = `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 SOUR @S1@
1 SOUR @S1@
1 BIRT
2 SOUR @S1@
0 @S1@ SOUR
1 TITL Book
0 TRLR`;

  it("routes by the source's register/record type in an event-style file", () => {
    const ds = dataset(EVENT_STYLE);
    expect(smartCitationTarget(ds.records, "geneanet", undefined)).toEqual({ eventTag: "BURI", onFam: false });
    expect(smartCitationTarget(ds.records, "billiongraves", undefined)).toEqual({ eventTag: "BURI", onFam: false });
    expect(smartCitationTarget(ds.records, "sistory", undefined)).toEqual({ eventTag: "DEAT", onFam: false });
    expect(smartCitationTarget(ds.records, "matricula", "Krstna knjiga / Taufbuch - 04406 | Vodice")).toEqual({
      eventTag: "BIRT", // the file's baptism habit (BIRT carries the citations)
      onFam: false,
    });
    expect(smartCitationTarget(ds.records, "matricula", "Poročna knjiga - 04406 | Vodice")).toEqual({
      eventTag: "MARR",
      onFam: true,
    });
  });

  it("stays record-level for unclassifiable sources or record-style files", () => {
    const ds = dataset(EVENT_STYLE);
    expect(smartCitationTarget(ds.records, "dlib", "Dolenjski list - dLib.si")).toBeUndefined();
    expect(smartCitationTarget(ds.records, "matricula", undefined)).toBeUndefined(); // no type signal
    const recordStyle = dataset(RECORD_STYLE);
    expect(smartCitationTarget(recordStyle.records, "geneanet", undefined)).toBeUndefined();
  });

  it("prefers events in a citation-less file (the cleanup tool's own default)", () => {
    const ds = dataset("0 HEAD\n1 CHAR UTF-8\n0 @I1@ INDI\n0 TRLR");
    expect(smartCitationTarget(ds.records, "geneanet", undefined)).toEqual({ eventTag: "BURI", onFam: false });
  });
});

describe("Add Source parity (recognizeSourceUrl / applySiteSourceExtras)", () => {
  it("proposes the cleanup tool's fields for a Matricula page URL", () => {
    const rec = recognizeSourceUrl(`${BOOK2}/?pg=05`)!;
    expect(rec.site).toBe("matricula");
    expect(rec.page).toBe("05");
    expect(rec.proposed).toEqual({
      title: "Matricula 04406 | Vodice",
      place: "Vodice",
      agency: "Ljubljana",
      filingNumber: "04406",
    });
  });

  it("titles a Geneanet grave URL by the person filter", () => {
    const rec = recognizeSourceUrl("https://en.geneanet.org/cemetery/view/321/persons/?individu_filter=GRUDNIK%2BAnton")!;
    expect(rec.site).toBe("geneanet");
    expect(rec.bookUrl).toBe("https://en.geneanet.org/cemetery/view/321");
    expect(rec.proposed.title).toBe("GRUDNIK Anton - Geneanet Cemeteries");
  });

  it("returns undefined for unknown URLs", () => {
    expect(recognizeSourceUrl("https://example.org/whatever")).toBeUndefined();
  });

  it("fills PLAC/DATE and creates the site REPO in a repository-layout file", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 PLAC Vodice,Ljubljana,Slovenia
2 SOUR @S9@
0 @S9@ SOUR
1 TITL Some archive book
1 REPO @R9@
0 @R9@ REPO
1 NAME Local archive
1 WWW https://example.org/
0 TRLR`);
    const source = createSourceRecord(ds.records, {
      title: "Matricula 04406 | Vodice",
      agency: "Nadškofijski arhiv Ljubljana",
      filingNumber: "04406",
      url: `${BOOK2}/?pg=05`,
    });
    const repo = applySiteSourceExtras(ds.records, source, "matricula", `${BOOK2}/?pg=05`, {
      place: "Vodice",
      dateRange: "1843-1909",
    });
    expect(repo?.xref).toBeDefined();
    expect(source.children.some((c) => c.tag === "REPO" && c.value === repo!.xref)).toBe(true);
    const text = serializeGedcom(ds.records);
    // Place resolved against the file's own place format, not the bare proposal.
    expect(text).toContain("1 PLAC Vodice,Ljubljana,Slovenia");
    expect(text).toContain("1 DATE 1843-1909");
    expect(text).toContain("1 NAME Nadškofijski arhiv Ljubljana");
    expect(text).toContain("1 WWW https://data.matricula-online.eu/sl/slovenia/ljubljana/");
  });

  it("writes a fetched page date in the file's own date format", () => {
    // A Google Books newspaper heading reports "Apr 12, 1979" — a shape this
    // file (and the GEDCOM parser) doesn't read. It lands in the house style.
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 DATE 26 JUN 1912
1 DEAT
2 DATE 3 FEB 1985
0 TRLR`);
    const url = "https://www.google.com/books/edition/_/abcdef?gbpv=1";
    const source = createSourceRecord(ds.records, { title: "The Windsor Star, Apr 12, 1979 - Google Books", url });
    applySiteSourceExtras(ds.records, source, "googlebooks", url, { dateRange: "Apr 12, 1979" });
    expect(serializeGedcom(ds.records)).toContain("1 DATE 12 APR 1979");
  });

  it("writes a fetched page date in a numeric file's format, ranges untouched", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 DATE 26.6.1912
1 DEAT
2 DATE 3.2.1985
0 TRLR`);
    const url = "https://www.google.com/books/edition/_/abcdef?gbpv=1";
    const source = createSourceRecord(ds.records, { title: "The Windsor Star, Apr 12, 1979 - Google Books", url });
    applySiteSourceExtras(ds.records, source, "googlebooks", url, { dateRange: "Apr 12, 1979" });
    const other = createSourceRecord(ds.records, { title: "Matricula 04406 | Vodice", url: `${BOOK2}/?pg=05` });
    applySiteSourceExtras(ds.records, other, "matricula", `${BOOK2}/?pg=05`, { dateRange: "1843-1909" });
    const text = serializeGedcom(ds.records);
    expect(text).toContain("1 DATE 12.4.1979");
    // A register's year span is the user's shorthand, kept as written.
    expect(text).toContain("1 DATE 1843-1909");
  });

  it("links no REPO when the file's sources don't hang off repositories", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 SOUR @S9@
0 @S9@ SOUR
1 TITL Some book
0 TRLR`);
    const source = createSourceRecord(ds.records, { title: "Matricula 04406 | Vodice", url: `${BOOK2}/?pg=05` });
    expect(applySiteSourceExtras(ds.records, source, "matricula", `${BOOK2}/?pg=05`, { place: "Vodice" })).toBeUndefined();
    expect(source.children.some((c) => c.tag === "REPO")).toBe(false);
    expect(ds.records.some((r) => r.tag === "REPO")).toBe(false);
  });
});

describe("private entries never become sources", () => {
  const HEAD = ["0 HEAD", "1 GEDC", "2 VERS 5.5.1"];

  it("skips a private person's links entirely", () => {
    const report = scan([
      ...HEAD,
      "0 @I1@ INDI",
      "1 _PRIV Y",
      `1 WWW ${BOOK}/?pg=10`,
      "0 TRLR",
    ].join("\n"));
    expect(report.totalOccurrences).toBe(0);
  });

  it("skips a private inline note's link but keeps the person's other links", () => {
    const report = scan([
      ...HEAD,
      "0 @I1@ INDI",
      `1 NOTE see ${BOOK}/?pg=10`,
      "2 PRIV",
      `1 WWW ${BOOK2}/?pg=5`,
      "0 TRLR",
    ].join("\n"));
    expect(report.totalOccurrences).toBe(1);
    expect(report.groups[0].members[0].url).toContain(BOOK2);
  });

  it("skips a pointer to a private media record", () => {
    const report = scan([
      ...HEAD,
      "0 @I1@ INDI",
      "1 OBJE @O1@",
      "0 @O1@ OBJE",
      `1 FILE ${BOOK}/?pg=10`,
      "1 PRIV",
      "0 TRLR",
    ].join("\n"));
    expect(report.totalOccurrences).toBe(0);
  });

  it("control: the same shapes without privacy markers are found", () => {
    const report = scan([
      ...HEAD,
      "0 @I1@ INDI",
      `1 NOTE see ${BOOK}/?pg=10`,
      "1 OBJE @O1@",
      "0 @O1@ OBJE",
      `1 FILE ${BOOK2}/?pg=5`,
      "0 TRLR",
    ].join("\n"));
    expect(report.totalOccurrences).toBe(2);
  });
});

describe("FamilySearch image links", () => {
  // What familysearch.org/ark:/… answers to Accept:
  // application/x-gedcomx-v1+json — trimmed to what the parser reads.
  const ARK_JSON = JSON.stringify({
    description: "sd_c_2040054",
    links: { self: { href: "https://familysearch.org/ark:/61903/3:1:3QSQ-G99F-FHWS", offset: 556, results: 689 } },
    sourceDescriptions: [
      {
        id: "sd_c_2040054",
        resourceType: "http://gedcomx.org/DigitalArtifact",
        citations: [
          {
            value:
              '"Croatia, Church Books, 1516-1994," database with images, <i>FamilySearch</i> ' +
              "(https://familysearch.org/ark:/61903/3:1:3QSQ-G99F-FHWS?cc=2040054 : 16 July 2014), " +
              "Roman Catholic (Rimokatolička crkva) > Pakrac > " +
              "Births (Rođeni) 1892-1899 Marriages (Vjenčani) 1858-1890 > image 556 of 689; " +
              "Arhiva Hrvatske u Zagrebu (Croatia State Archives), Zagreb.\n",
          },
        ],
      },
      { id: "src_2", resourceType: "http://gedcomx.org/Collection", titles: [{ value: "Croatia, Church Books, 1516-1994" }] },
    ],
  });

  const IMAGE_URL =
    "https://www.familysearch.org/ark:/61903/3:1:3QSQ-G99F-FHWS?wc=9R2F-W38%3A391644801&cc=2040054&lang=en&i=555";
  // A link straight to a book, naming neither the collection nor the image.
  const BOOK_ONLY_URL = "https://www.familysearch.org/ark:/61903/3:1:3QSQ-G99C-57VF?view=index&lang=en";
  const RECORD_URL = "https://familysearch.org/ark:/61903/1:1:XNJ8-FPJ";
  const FILM_URL = "https://www.familysearch.org/search/catalog/406380";
  const FILM_ARK_URL = "https://www.familysearch.org/ark:/61903/3:1:3Q9M-CS2T-N985-8?cat=406380&i=137";
  // Distinct arks, so the session-wide book cache can't answer for them.
  const BLOCKED_URL = "https://www.familysearch.org/ark:/61903/3:1:3QS7-899C-5CGR?view=index";
  const BLOCKED_URL_2 = "https://www.familysearch.org/ark:/61903/3:1:3QS7-L996-198J?view=index";

  it("reads collection, book, place, archive and image number from the ark's own citation", () => {
    expect(parseFamilySearchArkJson(ARK_JSON)).toEqual({
      title:
        "Pakrac - Births (Rođeni) 1892-1899 Marriages (Vjenčani) 1858-1890 - Croatia, Church Books, 1516-1994",
      collection: "Croatia, Church Books, 1516-1994",
      book: "Births (Rođeni) 1892-1899 Marriages (Vjenčani) 1858-1890",
      place: "Pakrac",
      agency: "Arhiva Hrvatske u Zagrebu (Croatia State Archives), Zagreb",
      // FamilySearch's own image number, one ahead of the URL's i=555.
      page: "556",
      // A book holding births and marriages covers both spans…
      dateRange: "1858-1899",
      // …and classifies as neither.
      bookType: undefined,
    });
  });

  it("takes the place from a two-step path and classifies a single-register book", () => {
    const json = ARK_JSON.replace(
      "Roman Catholic (Rimokatolička crkva) > Pakrac > Births (Rođeni) 1892-1899 Marriages (Vjenčani) 1858-1890",
      "Pakrac > Poročna knjiga 1858-1890",
    );
    const meta = parseFamilySearchArkJson(json);
    expect(meta?.place).toBe("Pakrac");
    expect(meta?.title).toBe("Pakrac - Poročna knjiga 1858-1890 - Croatia, Church Books, 1516-1994");
    expect(meta?.dateRange).toBe("1858-1890");
    expect(meta?.bookType).toBe("marriage");
  });

  it("reads a link that names neither collection nor image — both come back from the ark", () => {
    // The real answer for BOOK_ONLY_URL, trimmed: no cc and no i= in the link,
    // yet the citation numbers the image and the descriptor names the collection.
    const json = JSON.stringify({
      links: { self: { offset: 98, results: 247 } },
      sourceDescriptions: [
        {
          resourceType: "http://gedcomx.org/DigitalArtifact",
          descriptor: {
            resource: "https://www.familysearch.org/platform/records/collections/2040054?arkName=3:1:3QSQ-G99C-57VF",
          },
          citations: [
            {
              value:
                '"Croatia, Church Books, 1516-1994," database with images, <i>FamilySearch</i> ' +
                "(https://familysearch.org/ark:/61903/3:1:3QSQ-G99C-57VF?cc=2040054 : 6 April 2015), " +
                "Roman Catholic (Rimokatolička crkva) > Ravna Gora > " +
                "Marriages (Vjenčani) 1805-1812 Births (Rođeni) 1815-1843 Marriages (Vjenčani) 1815-1848 > " +
                "image 98 of 247; Arhiva Hrvatske u Zagrebu (Croatia State Archives), Zagreb.\n",
            },
          ],
        },
      ],
    });
    const meta = parseFamilySearchArkJson(json);
    expect(meta?.page).toBe("98");
    expect(meta?.place).toBe("Ravna Gora");
    expect(meta?.dateRange).toBe("1805-1848");
    expect(meta?.collection).toBe("Croatia, Church Books, 1516-1994");
    expect(meta?.collectionId).toBe("2040054");
  });

  it("splits a book holding two registers, and narrows to the one chosen", () => {
    const meta = parseFamilySearchArkJson(ARK_JSON)!;
    const parts = splitFsRegisters(meta.book);
    expect(parts).toEqual(["Births (Rođeni) 1892-1899", "Marriages (Vjenčani) 1858-1890"]);
    const marriages = narrowFsRegister(meta, parts[1]);
    expect(marriages.title).toBe("Pakrac - Marriages (Vjenčani) 1858-1890 - Croatia, Church Books, 1516-1994");
    expect(marriages.dateRange).toBe("1858-1890");
    // The register type is what puts the citation on the marriage.
    expect(marriages.bookType).toBe("marriage");
    expect(smartCitationTarget([], "familysearch", marriages.title, { citations: "event" })).toEqual({
      eventTag: "MARR",
      onFam: true,
    });
    // Everything the register doesn't touch is left alone.
    expect(marriages.place).toBe("Pakrac");
    expect(marriages.page).toBe("556");
  });

  it("offers no choice where there is none to make", () => {
    expect(splitFsRegisters("Poročna knjiga 1858-1890")).toEqual([]);
    expect(splitFsRegisters("Ravna Gora")).toEqual([]);
    expect(splitFsRegisters(undefined)).toEqual([]);
    // Trailing words no register accounts for: don't guess at the split.
    expect(splitFsRegisters("Births 1892-1899 Marriages 1858-1890 and other records")).toEqual([]);
  });

  it("reads a citation copied from a record page — the one thing a sign-in wall leaves", () => {
    const cited = parsePastedFsCitation(
      '"New York, Passenger Arrival Lists (Ellis Island), 1892-1925", FamilySearch ' +
        "(https://www.familysearch.org/ark:/61903/1:1:JFVN-KMV : Fri Jul 10 14:29:38 UTC 2026), " +
        "Entry for Anna Rakar and Martin Sadec, 9 July 1901.",
    );
    expect(cited).toEqual({
      title: "New York, Passenger Arrival Lists (Ellis Island), 1892-1925",
      collection: "New York, Passenger Arrival Lists (Ellis Island), 1892-1925",
      // Which record this is belongs on the citation, not in the source.
      page: "Entry for Anna Rakar and Martin Sadec, 9 July 1901",
      dateRange: "1892-1925",
      place: undefined,
      agency: undefined,
      filingNumber: undefined,
      bookType: undefined,
    });

    // The older shape, with the archive and film the newer one drops.
    const older = parsePastedFsCitation(
      '"Croatia, Church Books, 1516-1994," database with images, FamilySearch ' +
        "(https://familysearch.org/ark:/61903/1:1:JFVN-KMV : 11 March 2018), " +
        "Ana Renko in entry for Josip Renko, 1885; citing Baptism, Ravna Gora, Primorje-Gorski Kotar, Croatia, " +
        "Državni arhiv u Rijeci (State Archives), Rijeka; FHL microfilm 005,498,154.",
    );
    expect(older?.place).toBe("Ravna Gora, Primorje-Gorski Kotar, Croatia");
    expect(older?.agency).toBe("Državni arhiv u Rijeci (State Archives), Rijeka");
    expect(older?.filingNumber).toBe("005498154");
    expect(older?.page).toBe("Ana Renko in entry for Josip Renko, 1885");
    expect(older?.bookType).toBe("baptism");

    // Add Source and the whole-file scan both read it through the recognizer.
    const seen = recognizeSourceUrl(
      "https://www.familysearch.org/ark:/61903/1:1:JFVN-KMV?lang=en",
      '"New York, Passenger Arrival Lists (Ellis Island), 1892-1925", FamilySearch ' +
        "(https://www.familysearch.org/ark:/61903/1:1:JFVN-KMV : Fri Jul 10 14:29:38 UTC 2026), " +
        "Entry for Anna Rakar and Martin Sadec, 9 July 1901.",
    );
    expect(seen?.page).toBe("Entry for Anna Rakar and Martin Sadec, 9 July 1901");
    expect(seen?.proposed.title).toBe("New York, Passenger Arrival Lists (Ellis Island), 1892-1925");
    expect(seen?.proposed.dateRange).toBe("1892-1925");

    // A bare link still falls back to the ARK id, and other sites are not touched.
    expect(recognizeSourceUrl("https://www.familysearch.org/ark:/61903/1:1:JFVN-KMV?lang=en")?.page).toBe(
      "1:1:JFVN-KMV",
    );
    expect(parsePastedFsCitation("Krstna knjiga | 03869, Matricula Online")).toBeUndefined();
  });

  it("reads an image citation with no browse path — holder and Image Group Number", () => {
    // The current "Copy citation" wording on an image page: no " > " path, no
    // "citing" chain — the holder after the semicolon, the film number on its
    // own line as "Image Group Number".
    const citation =
      '"Chicago, Cook, Illinois, United States records," images, FamilySearch ' +
      "(https://www.familysearch.org/ark:/61903/3:1:3QHJ-5QHW-FSYM-6?view=explore : Aug 17, 2026), " +
      "image 23 of 35; National Archives and Records Administration.\n" +
      "Image Group Number: 108918058";
    const cited = parsePastedFsCitation(citation);
    expect(cited?.title).toBe("Chicago, Cook, Illinois, United States records");
    expect(cited?.collection).toBe("Chicago, Cook, Illinois, United States records");
    // Which image this is belongs on the citation, not in the source.
    expect(cited?.page).toBe("23");
    expect(cited?.agency).toBe("National Archives and Records Administration");
    expect(cited?.filingNumber).toBe("108918058");
    expect(cited?.place).toBeUndefined();

    // Through the recognizer (the Add Source dialog's path): the citation's
    // details land in the proposal, and the generic parse's leftovers are
    // flagged as already claimed.
    const seen = recognizeSourceUrl("https://www.familysearch.org/ark:/61903/3:1:3QHJ-5QHW-FSYM-6", citation);
    expect(seen?.site).toBe("familysearch");
    expect(seen?.proposed.title).toBe("Chicago, Cook, Illinois, United States records");
    expect(seen?.proposed.agency).toBe("National Archives and Records Administration");
    expect(seen?.proposed.filingNumber).toBe("108918058");
    expect(seen?.page).toBe("23");
    expect(seen?.collection).toBe("Chicago, Cook, Illinois, United States records");
    expect(seen?.cited).toBe(true);
    // A bare image link claims nothing beyond the URL.
    expect(recognizeSourceUrl("https://www.familysearch.org/ark:/61903/3:1:3QHJ-5QHW-FSYM-6")?.cited).toBe(false);
  });

  it("reads nothing from an image with no citation (a catalog film), and nothing from junk", () => {
    const bare = JSON.stringify({
      sourceDescriptions: [{ id: "sd_da_1", resourceType: "http://gedcomx.org/DigitalArtifact" }],
    });
    expect(parseFamilySearchArkJson(bare)).toBeUndefined();
    expect(parseFamilySearchArkJson("<html>not json</html>")).toBeUndefined();
  });

  it("fetches a collection image directly, asking for GedcomX — never through a relay", async () => {
    const relayed: string[] = [];
    const asked: { url: string; accept: string }[] = [];
    const meta = await fetchBookMeta(
      "familysearch",
      IMAGE_URL,
      async (url) => {
        relayed.push(url);
        return "<html><title>FamilySearch.org</title></html>";
      },
      async (url, accept) => {
        asked.push({ url, accept });
        return { status: 200, text: ARK_JSON };
      },
    );
    expect(relayed).toEqual([]);
    // Two direct asks per image: the ark's GedcomX, then its film (DGS) name.
    expect(asked[0]).toEqual({ url: IMAGE_URL, accept: "application/x-gedcomx-v1+json" });
    expect(asked[1]?.url).toMatch(/\/das\/v2\/3:1:[^/]+\/name\?namespace=dgs$/);
    expect(asked).toHaveLength(2);
    expect(meta?.place).toBe("Pakrac");
  });

  it("takes the source's filing number from the image's film (DGS) name", async () => {
    const meta = await fetchBookMeta(
      "familysearch",
      "https://www.familysearch.org/ark:/61903/3:1:TEST-DGS1?view=index",
      async () => undefined,
      async (url) =>
        url.includes("namespace=dgs")
          ? { status: 200, text: "dgs:005482250.005482250_00127" }
          : { status: 200, text: ARK_JSON },
    );
    expect(meta?.filingNumber).toBe("005482250");
    // …and a book folded out of such pages keeps the film as its id.
    expect(meta?.place).toBe("Pakrac");
  });

  it("writes the image link the reader put in a record page's place, in the media the file holds", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Anna /Rakar/
1 IMMI
2 OBJE @O1@
0 @O1@ OBJE
1 FILE ${RECORD_URL}
0 TRLR`);
    const report = findReshapableLinks(ds);
    const group = report.groups[0];
    expect(group.bookUrl).toBe(RECORD_URL);
    // What the editor saves once the traded image is looked up: the page's
    // fields, and the link on every member the trade covers.
    const enrichment = new Map([
      [group.id, { title: "Croatia, Church Books, 1516-1994", filingNumber: "005482250" }],
    ]);
    const traded = {
      ...group,
      members: group.members.map((m) => ({ ...m, swapUrl: IMAGE_URL, page: undefined })),
    };
    const { records, counts } = reshapeSources(ds.records, [traded], enrichment);
    const text = serializeGedcom(records);
    // The media record the file already had now names the image…
    expect(text).toContain("1 FILE https://www.familysearch.org/ark:/61903/3:1:3QSQ-G99F-FHWS?i=555&cc=2040054");
    expect(text).not.toContain(RECORD_URL);
    expect(counts.linksSwapped).toBe(1);
    expect(counts.mediaCreated).toBe(0);
    // …and the citation's page is the image's own number (FamilySearch counts
    // one ahead of the link's i=555), not the record ark that left with it.
    expect(text).toContain("3 PAGE 556");
    expect(text).toContain("1 TITL Croatia, Church Books, 1516-1994");
    expect(text).not.toContain("1:1:XNJ8-FPJ");
  });

  it("keeps each traded link when the pages it belongs to are folded into one book", () => {
    const second = "https://familysearch.org/ark:/61903/1:1:XNJ8-FPK";
    const secondImage = "https://www.familysearch.org/ark:/61903/3:1:3QSQ-G99F-FHWT?i=556&cc=2040054";
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 IMMI
2 WWW ${RECORD_URL}
0 @I2@ INDI
1 IMMI
2 WWW ${second}
0 TRLR`);
    const report = findReshapableLinks(ds);
    expect(report.groups).toHaveLength(2);
    // Both traded pages come back naming one book — which is what folds them.
    const book = { collection: "Croatia, Church Books, 1516-1994", book: "Births (Rodeni) 1892-1899", place: "Pakrac" };
    const enrichment = new Map(
      report.groups.map((g) => [g.id, { ...book, title: "Pakrac - Births (Rodeni) 1892-1899" }]),
    );
    const swapFor = new Map([
      [linkKey(RECORD_URL), IMAGE_URL],
      [linkKey(second), secondImage],
    ]);
    const folded = mergeFsBooks(report, enrichment);
    expect(folded.report.groups).toHaveLength(1);
    const selected = folded.report.groups.map((g) => ({
      ...g,
      members: g.members.map((m) => ({ ...m, swapUrl: swapFor.get(linkKey(m.url)), page: undefined })),
    }));
    const { records, counts } = reshapeSources(ds.records, selected, folded.enrichment, {
      mergeGroups: folded.keyOf,
    });
    const text = serializeGedcom(records);
    // One source for the book, one page image per traded link — neither page
    // lost to the other.
    expect(counts.sourcesCreated).toBe(1);
    expect(counts.linksSwapped).toBe(0); // no media records existed to re-point
    expect(text).toContain("1 FILE https://www.familysearch.org/ark:/61903/3:1:3QSQ-G99F-FHWS?i=555&cc=2040054");
    expect(text).toContain("1 FILE https://www.familysearch.org/ark:/61903/3:1:3QSQ-G99F-FHWT?i=556&cc=2040054");
    expect(text).not.toContain(RECORD_URL);
    expect(text).not.toContain(second);
    expect(text).toContain("3 PAGE 556");
    expect(text).toContain("3 PAGE 557");
  });

  it("attaches to the file's own repository for that country", () => {
    const ds = dataset([
      "0 HEAD",
      "1 GEDC",
      "2 VERS 5.5.1",
      "0 @R1@ REPO",
      "1 NAME FamilySearch.org - Slovenia",
      "0 @R2@ REPO",
      "1 NAME FamilySearch.org - Croatia",
      "0 @R3@ REPO",
      "1 NAME Matricula Online - Nadškofijski arhiv Ljubljana",
      "1 WWW https://data.matricula-online.eu/sl/slovenia/ljubljana/",
      "0 TRLR",
    ].join("\n"));
    // Neither FamilySearch repository has a WWW: only the country in its name
    // tells them apart, and the collection title states it.
    expect(
      proposedSiteRepo(ds.records, "familysearch", IMAGE_URL, undefined, {
        title: "Croatia, Church Books, 1516-1994",
      })?.xref,
    ).toBe("@R2@");
    // The place the records cover says it outright, whatever the title reads.
    expect(
      proposedSiteRepo(ds.records, "familysearch", IMAGE_URL, undefined, {
        title: "Zbirka",
        place: "Ravna Gora, Primorje-Gorski Kotar, Croatia",
      })?.xref,
    ).toBe("@R2@");
    // A country no repository holds must not fall back to another country's —
    // a new one is proposed instead…
    expect(
      proposedSiteRepo(ds.records, "familysearch", BOOK_ONLY_URL, undefined, {
        title: "Illinois, Cook County Deaths, 1871-1998",
      }),
    ).toEqual({ createName: "FamilySearch.org - United States, Illinois" });
    // …though a *generic* site repository still serves every country.
    const withWww = dataset([
      "0 HEAD",
      "1 GEDC",
      "2 VERS 5.5.1",
      "0 @R1@ REPO",
      "1 NAME FamilySearch",
      "1 WWW https://www.familysearch.org/",
      "0 TRLR",
    ].join("\n"));
    expect(
      proposedSiteRepo(withWww.records, "familysearch", BOOK_ONLY_URL, undefined, {
        title: "Illinois, Cook County Deaths, 1871-1998",
      })?.xref,
    ).toBe("@R1@");
    // A repository kept for one collection names a country inside a title,
    // which is not the country's own record: the country's is proposed.
    const perCollection = dataset([
      "0 HEAD",
      "1 GEDC",
      "2 VERS 5.5.1",
      "0 @R1@ REPO",
      "1 NAME FamilySearch.org - Croatia Church Books 1516-1994",
      "0 TRLR",
    ].join("\n"));
    expect(
      proposedSiteRepo(perCollection.records, "familysearch", IMAGE_URL, undefined, {
        title: "Croatia, Church Books, 1516-1994",
      }),
    ).toEqual({ createName: "FamilySearch.org - Croatia" });
    // Matricula's archive still wins over a bare familysearch.org repository.
    expect(proposedSiteRepo(ds.records, "matricula", BOOK, "Nadškofijski arhiv Ljubljana")?.xref).toBe("@R3@");
  });

  it("files a bare browse link where the collection's other pages already hang", () => {
    // Two links out of Croatia, Church Books (cc=2040054). Nothing in either
    // says so — no film, no citation, no lookup — but the file has answered
    // this before, and its answer is the collection id on a page it holds.
    const ds = dataset([
      "0 HEAD",
      "1 GEDC",
      "2 VERS 5.5.1",
      "0 @R1@ REPO", "1 NAME FamilySearch.org - Croatia", "1 WWW https://www.familysearch.org/",
      "0 @R2@ REPO", "1 NAME FamilySearch.org - United States, Illinois",
      "0 @S1@ SOUR", "1 TITL Births (Rođeni) 1857-1884, Ravna Gora", "1 REPO @R1@", "1 OBJE @O1@",
      "0 @O1@ OBJE", "1 FILE https://www.familysearch.org/ark:/61903/3:1:939V-5NSX-83?i=12&cc=2040054",
      "0 TRLR",
    ].join("\n"));
    const link = familySearchPageUrl(
      "https://www.familysearch.org/ark:/61903/3:1:939V-5NS6-DN?lang=en&i=33&cc=2040054",
    );
    // The stored form keeps what identifies the page and its collection.
    expect(link).toBe("https://www.familysearch.org/ark:/61903/3:1:939V-5NS6-DN?i=33&cc=2040054");
    expect(proposedSiteRepo(ds.records, "familysearch", link, undefined, {})?.xref).toBe("@R1@");

    // A collection the file has never cited is not guessed at: the site's own
    // record is proposed rather than one of the places it happens to keep.
    const unknown = familySearchPageUrl("https://www.familysearch.org/ark:/61903/3:1:ABCD-1?i=4&cc=9999999");
    expect(proposedSiteRepo(ds.records, "familysearch", unknown, undefined, {})).toEqual({
      createName: "FamilySearch.org",
    });
  });

  it("reuses the state's own repository, and never a collection that opens with a state", () => {
    const states = dataset([
      "0 HEAD",
      "1 GEDC",
      "2 VERS 5.5.1",
      "0 @R1@ REPO",
      "1 NAME FamilySearch.org - United States, Illinois",
      "0 @R2@ REPO",
      "1 NAME FamilySearch.org - Illinois, Cook County Deaths, 1871-1998",
      "0 TRLR",
    ].join("\n"));
    expect(
      proposedSiteRepo(states.records, "familysearch", BOOK_ONLY_URL, undefined, {
        title: "Illinois, Cook County Marriages, 1871-1969",
      })?.xref,
    ).toBe("@R1@");
    // Another state has no record of its own here, and the collection kept
    // under @R2@ is not one — so Indiana's is proposed.
    expect(
      proposedSiteRepo(states.records, "familysearch", BOOK_ONLY_URL, undefined, {
        title: "Indiana, Marriages, 1811-2019",
      }),
    ).toEqual({ createName: "FamilySearch.org - United States, Indiana" });
  });

  it("names a repository it has to create after the country of its records", () => {
    const empty = dataset(["0 HEAD", "1 GEDC", "2 VERS 5.5.1", "0 TRLR"].join("\n"));
    // A link naming no country at all keeps the site's own bare record.
    expect(proposedSiteRepo(empty.records, "familysearch", IMAGE_URL, undefined)?.createName).toBe("FamilySearch.org");
    expect(
      proposedSiteRepo(empty.records, "familysearch", IMAGE_URL, undefined, {
        title: "Croatia, Church Books, 1516-1994",
      })?.createName,
    ).toBe("FamilySearch.org - Croatia");
    // American records are published state by state, so a place naming the
    // state is filed under it rather than under the country as a whole…
    expect(
      proposedSiteRepo(empty.records, "familysearch", IMAGE_URL, undefined, {
        title: "Chicago, Cook, Illinois, United States records",
        place: "Chicago, Cook, Illinois",
      })?.createName,
    ).toBe("FamilySearch.org - United States, Illinois");
    // …while a collection covering the whole country keeps the country.
    expect(
      proposedSiteRepo(empty.records, "familysearch", IMAGE_URL, undefined, {
        title: "United States, Census, 1930",
      })?.createName,
    ).toBe("FamilySearch.org - United States");
    // …and where the file writes the country itself, that wording is kept.
    expect(
      proposedSiteRepo(empty.records, "familysearch", IMAGE_URL, undefined, {
        place: "Ravna Gora, Primorje-Gorski Kotar, Hrvaška",
      })?.createName,
    ).toBe("FamilySearch.org - Hrvaška");
    const created = createSiteRepo(empty.records, "familysearch", BOOK_ONLY_URL, undefined, {
      title: "Croatia, Church Books, 1516-1994",
      id: "2040054",
    });
    expect(created?.children.find((c) => c.tag === "NAME")?.value).toBe("FamilySearch.org - Croatia");
    // A country's repository spans collections, so it carries the site itself.
    expect(created?.children.find((c) => c.tag === "WWW")?.value).toBe("https://www.familysearch.org/");
  });

  it("folds the pages of one book into a single source, each citing its own page", () => {
    // Three people, three single-image links: two pages of one book, one of
    // another. Nothing in the links says so — the lookups do.
    const ds = dataset([
      "0 HEAD",
      "1 CHAR UTF-8",
      "0 @I1@ INDI",
      "1 WWW https://www.familysearch.org/ark:/61903/3:1:AAA?view=index&lang=en",
      "0 @I2@ INDI",
      "1 WWW https://www.familysearch.org/ark:/61903/3:1:BBB?view=index&lang=en",
      "0 @I3@ INDI",
      "1 WWW https://www.familysearch.org/ark:/61903/3:1:CCC?view=index&lang=en",
      "0 TRLR",
    ].join("\n"));
    const report = findReshapableLinks(ds);
    expect(report.groups).toHaveLength(3); // one per image, before any lookup
    const book = { collection: "Croatia, Church Books, 1516-1994", place: "Ravna Gora", book: "Marriages (Vjenčani) 1805-1812" };
    const enrichment: ReshapeEnrichment = new Map([
      [report.groups[0].id, { ...book, title: "Ravna Gora - Marriages (Vjenčani) 1805-1812", dateRange: "1805-1812", bookType: "marriage" as const, page: "12" }],
      [report.groups[1].id, { ...book, title: "Ravna Gora - Marriages (Vjenčani) 1805-1812", dateRange: "1805-1812", bookType: "marriage" as const, page: "47" }],
      [report.groups[2].id, { collection: book.collection, place: "Dubovac (Karlovac)", book: "Births (Rođeni) 1891-1896", title: "Dubovac (Karlovac) - Births (Rođeni) 1891-1896", page: "3" }],
    ]);

    const folded = mergeFsBooks(report, enrichment);
    // Two pages of one book become one row; the lone page keeps its own.
    expect(folded.report.groups).toHaveLength(2);
    const merged = folded.report.groups[0];
    expect(merged.members.map((m) => m.page)).toEqual(["12", "47"]);
    expect(merged.pages).toEqual(["12", "47"]);
    expect(merged.bookType).toBe("marriage");
    // A book has no single image's ark for a filing number.
    expect(merged.proposed.filingNumber).toBeUndefined();

    const { records, counts } = reshapeSources(ds.records, folded.report.groups, folded.enrichment, {
      mergeGroups: folded.keyOf,
    });
    const text = serializeGedcom(records);
    expect(counts.sourcesCreated).toBe(2); // one per book, not one per image
    // Both people cite the same source, each at its own page.
    expect(text).toMatch(/0 @I1@ INDI\n1 SOUR @S1@\n2 PAGE 12/);
    expect(text).toMatch(/0 @I2@ INDI\n1 SOUR @S1@\n2 PAGE 47/);
    expect(text).toMatch(/0 @I3@ INDI\n1 SOUR @S2@\n2 PAGE 3/);
    expect(text).toContain("1 TITL Ravna Gora - Marriages (Vjenčani) 1805-1812");
    expect(text).toContain("1 DATE 1805-1812");
    // One page image per image link, each carrying the book's name alone: a
    // FamilySearch book is numbered twice over (the film's images, the book's
    // own pages) and nothing says which a number belongs to, so the media
    // title claims none. The citation still says which image it came from.
    expect(text).not.toContain("1 TITL #12 -");
    expect(text.match(/1 TITL Ravna Gora - Marriages \(Vjenčani\) 1805-1812/g)).toHaveLength(3);
  });

  it("reads a published microfilm's own citation, publisher and all", () => {
    // A collection whose images are a filmed publication rather than an
    // archive's own book: one browse step, and a "citing …" tail in the
    // bibliographic shape.
    const json = JSON.stringify({
      sourceDescriptions: [
        {
          resourceType: "http://gedcomx.org/DigitalArtifact",
          citations: [
            {
              value:
                '"New York, Passenger Arrival Lists (Ellis Island), 1892-1925," database with images, ' +
                "<i>FamilySearch</i> (https://familysearch.org/ark:/61903/3:1:3Q9M-C9T4-LSL3-L?cc=1368704 : 26 January 2018), " +
                "Roll 210, vol 343-344, 5 Jul 1901-7 Jul 1901 > image 682 of 724; citing NARA microfilm publication " +
                "T715 and M237 (Washington D.C.: National Archives and Records Administration, n.d.).",
            },
          ],
        },
      ],
    });
    const meta = parseFamilySearchArkJson(json);
    expect(meta?.title).toBe(
      "Roll 210, vol 343-344, 5 Jul 1901-7 Jul 1901 - New York, Passenger Arrival Lists (Ellis Island), 1892-1925",
    );
    expect(meta?.page).toBe("682");
    expect(meta?.dateRange).toBe("1901");
    // "citing" is not part of the archive's name, and a publication's
    // publisher and city are their own fields.
    expect(meta?.agency).toBe("NARA microfilm publication T715 and M237");
    expect(meta?.publisher).toBe("National Archives and Records Administration");
    expect(meta?.place).toBe("Washington D.C.");
  });

  it("treats every form of one image link as the same page", () => {
    const ark = "https://www.familysearch.org/ark:/61903/3:1:3QSQ-G99C-5C1Q";
    const forms = [
      `${ark}?view=explore&lang=en&groupId=M99F-832`,
      `${ark}?lang=en`,
      `${ark}?wc=9R29-92W%3A391644801&cc=2040054&lang=en&i=143`,
      ark,
    ];
    expect(new Set(forms.map(linkKey)).size).toBe(1);
    // What gets written keeps the ark and nothing else…
    expect(canonicalFamilySearchUrl(forms[0])).toBe(ark);
    // …except the film a catalog image belongs to, which names it.
    expect(canonicalFamilySearchUrl(`${ark}?cat=406380&i=137`)).toBe(`${ark}?cat=406380`);
    // Two different images stay two, and other sites are untouched.
    expect(linkKey(`${ark}?lang=en`)).not.toBe(linkKey("https://www.familysearch.org/ark:/61903/3:1:AAA"));
    expect(canonicalFamilySearchUrl(`${BOOK}/?pg=10`)).toBe(`${BOOK}/?pg=10`);

    // So a link the file already cites is recognized however it was written.
    const ds = dataset([
      "0 HEAD",
      "1 CHAR UTF-8",
      "0 @I1@ INDI",
      `1 WWW ${forms[0]}`,
      "0 @S9@ SOUR",
      "1 TITL Ravna Gora",
      "1 OBJE @O9@",
      "0 @O9@ OBJE",
      `1 FILE ${forms[1]}`,
      "0 TRLR",
    ].join("\n"));
    expect(findReshapableLinks(ds).groups[0].existingSourceXref).toBe("@S9@");
  });

  it("shortens the links already stored, but only when asked", () => {
    const long =
      "https://www.familysearch.org/ark:/61903/3:1:3QSQ-G99C-5C1Q?view=explore&lang=en&groupId=M99F-832";
    const file = [
      "0 HEAD",
      "1 CHAR UTF-8",
      "0 @I1@ INDI",
      "1 OBJE @O9@",
      "0 @O9@ OBJE",
      `1 FILE ${long}`,
      "0 TRLR",
    ].join("\n");

    const kept = dataset(file);
    const asIs = reshapeSources(kept.records, findReshapableLinks(kept).groups, undefined, {});
    expect(serializeGedcom(asIs.records)).toContain(long); // the file's own text stands
    expect(asIs.counts.linksTidied).toBe(0);

    const ds = dataset(file);
    const tidied = reshapeSources(ds.records, findReshapableLinks(ds).groups, undefined, { tidyLinks: true });
    const text = serializeGedcom(tidied.records);
    expect(text).toContain("1 FILE https://www.familysearch.org/ark:/61903/3:1:3QSQ-G99C-5C1Q\n");
    expect(text).not.toContain("groupId");
    expect(tidied.counts.linksTidied).toBe(1);
  });

  it("adds a book's new pages to the source the file already keeps for it", () => {
    // Two pages of one book; the file already cites the first from a source of
    // its own. The second must join that record, not start a second one.
    const ds = dataset([
      "0 HEAD",
      "1 CHAR UTF-8",
      "0 @I1@ INDI",
      "1 WWW https://www.familysearch.org/ark:/61903/3:1:AAA?view=index&lang=en",
      "0 @I2@ INDI",
      "1 WWW https://www.familysearch.org/ark:/61903/3:1:BBB?view=index&lang=en",
      "0 @S9@ SOUR",
      "1 TITL Marriages, Ravna Gora",
      "1 OBJE @O9@",
      "0 @O9@ OBJE",
      "1 FILE https://www.familysearch.org/ark:/61903/3:1:AAA?view=index&lang=en",
      "0 TRLR",
    ].join("\n"));
    const report = findReshapableLinks(ds);
    expect(report.groups.map((g) => g.existingSourceXref)).toEqual(["@S9@", undefined]);
    const meta = { collection: "C", place: "Ravna Gora", book: "Marriages 1805-1812", page: "1" };
    const enrichment: ReshapeEnrichment = new Map(report.groups.map((g) => [g.id, meta]));
    const folded = mergeFsBooks(report, enrichment);
    expect(folded.report.groups).toHaveLength(1);
    expect(folded.report.groups[0].existingSourceXref).toBe("@S9@");
    expect(folded.report.groups[0].existingSourceTitle).toBe("Marriages, Ravna Gora");
    expect(folded.report.groups[0].members).toHaveLength(2);
    // …and the apply agrees: no second source, whichever page it meets first.
    const { counts } = reshapeSources(ds.records, folded.report.groups, folded.enrichment, {
      mergeGroups: folded.keyOf,
    });
    expect(counts.sourcesCreated).toBe(0);
    expect(counts.sourcesReused).toBe(1);

    // One page alone is no book to fold, and with no lookups there is nothing
    // to fold by — the report comes back as it was.
    expect(mergeFsBooks(report, new Map()).report).toBe(report);
  });

  it("tries a blocked link once more, but takes a 401 for the answer it is", async () => {
    // A fresh module instance: its lookup pacing starts idle, so the only
    // timer in play is the retry's own.
    vi.resetModules();
    const fresh = await import("./sourceReshape");
    vi.useFakeTimers();
    try {
      const asked: number[] = [];
      // The edge's block page on the first ask, the real answer on the second.
      const flaky = async () => {
        asked.push(asked.length);
        return asked.length === 1 ? { status: 403 } : { status: 200, text: ARK_JSON };
      };
      const pending = fresh.fetchBookMeta("familysearch", BLOCKED_URL, async () => undefined, flaky);
      await vi.advanceTimersByTimeAsync(10_000);
      expect((await pending)?.place).toBe("Pakrac");
      // Block, retry that lands the JSON, then the film-name ask.
      expect(asked).toHaveLength(3);

      // A sign-in refusal is final: asking again would get the same 401.
      let signInAsks = 0;
      const signIn = async () => {
        signInAsks++;
        return { status: 401 };
      };
      const denied = fresh.fetchBookMeta("familysearch", BLOCKED_URL_2, async () => undefined, signIn);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await denied).toBeUndefined();
      expect(signInAsks).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks nothing for a record page or a catalog film — those need a login", async () => {
    const asked: string[] = [];
    const relay = async () => "<html><title>FamilySearch.org</title></html>";
    const ask = async (url: string) => {
      asked.push(url);
      return { status: 200, text: ARK_JSON };
    };
    expect(await fetchBookMeta("familysearch", RECORD_URL, relay, ask)).toBeUndefined();
    expect(await fetchBookMeta("familysearch", FILM_URL, relay, ask)).toBeUndefined();
    expect(await fetchBookMeta("familysearch", FILM_ARK_URL, relay, ask)).toBeUndefined();
    expect(asked).toEqual([]);
    // …and the panel's fetch button doesn't count them either. A link that
    // names no collection is still asked: FamilySearch resolves it itself.
    expect(isFetchableSite("familysearch", IMAGE_URL)).toBe(true);
    expect(isFetchableSite("familysearch", BOOK_ONLY_URL)).toBe(true);
    expect(isFetchableSite("familysearch", RECORD_URL)).toBe(false);
    expect(isFetchableSite("familysearch", FILM_URL)).toBe(false);
    expect(isFetchableSite("familysearch", FILM_ARK_URL)).toBe(false);
    expect(isFetchableSite("familysearch")).toBe(false);
  });
});
