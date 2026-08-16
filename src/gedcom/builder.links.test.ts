import { describe, expect, it } from "vitest";
import { parseGedcom } from "./parser";
import { buildDataset } from "./builder";

function buildFromText(text: string) {
  const buf = new TextEncoder().encode(text);
  const parsed = parseGedcom(buf.buffer);
  return buildDataset(parsed);
}

describe("editableLinks vs harvested links", () => {
  // Regression: the link editors used to edit the full harvest — removing a
  // note-borne URL was a no-op (it reappeared on the next rebuild) and any
  // link edit rewrote the harvested URLs as duplicate WWW lines.
  it("keeps only the node's own link-tag values editable, not note/media URLs", () => {
    const text = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @M1@ OBJE
1 FILE https://example.org/photo.jpg
0 @I1@ INDI
1 NAME Test /Person/
1 WWW https://example.org/profile
1 NOTE See https://example.org/article for details
1 OBJE @M1@
1 BIRT
2 DATE 1 JAN 1900
2 WWW https://example.org/birth-record
2 NOTE Scan at https://example.org/scan
0 TRLR
`;
    const ds = buildFromText(text);
    const indi = ds.individuals.get("@I1@")!;
    expect(indi.links).toEqual([
      "https://example.org/profile",
      "https://example.org/article",
      "https://example.org/photo.jpg",
    ]);
    expect(indi.editableLinks).toEqual(["https://example.org/profile"]);
    const birt = indi.events.find((e) => e.tag === "BIRT")!;
    expect(birt.links).toEqual(["https://example.org/birth-record", "https://example.org/scan"]);
    expect(birt.editableLinks).toEqual(["https://example.org/birth-record"]);
  });

  it("leaves editableLinks absent when every link is harvested", () => {
    const text = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 NAME Test /Person/
1 NOTE Only https://example.org/from-note here
0 TRLR
`;
    const indi = buildFromText(text).individuals.get("@I1@")!;
    expect(indi.links).toEqual(["https://example.org/from-note"]);
    expect(indi.editableLinks).toBeUndefined();
  });
});

describe("EXID type URIs", () => {
  it("does not harvest the vocabulary URI that names the identifier's kind", () => {
    // A 7.0 file (or one this app upgraded from 5.5.1) writes a RIN as an EXID
    // whose TYPE is the registered term for it. That URI is the same on every
    // record carrying a RIN and points at no research — shown as a link it hung
    // a 🔗 on the person and offered itself as a source to merge.
    const text = `0 HEAD
1 GEDC
2 VERS 7.0
0 @I1@ INDI
1 NAME Test /Person/
1 EXID 1234
2 TYPE https://gedcom.io/terms/v7/RIN
1 WWW https://example.org/profile
0 TRLR
`;
    const indi = buildFromText(text).individuals.get("@I1@")!;
    expect(indi.links).toEqual(["https://example.org/profile"]);
  });

  it("still harvests a real link standing elsewhere under the same record", () => {
    const text = `0 HEAD
1 GEDC
2 VERS 7.0
0 @I1@ INDI
1 NAME Test /Person/
1 EXID 1234
2 TYPE https://gedcom.io/terms/v7/RIN
1 NOTE Scan at https://example.org/scan
0 TRLR
`;
    const indi = buildFromText(text).individuals.get("@I1@")!;
    expect(indi.links).toEqual(["https://example.org/scan"]);
  });
});

describe("collectLinks CONC/CONT handling", () => {
  it("reassembles a WWW value wrapped with CONC", () => {
    const text = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 NAME Test /Person/
1 WWW https://stareslike.cerknica.org/2012/12/18/1950-pikovnik-prebivalci-vasi
2 CONC ce/
0 TRLR
`;
    const ds = buildFromText(text);
    const indi = ds.individuals.get("@I1@")!;
    expect(indi.links).toEqual(["https://stareslike.cerknica.org/2012/12/18/1950-pikovnik-prebivalci-vasice/"]);
  });

  it("reassembles a URL embedded in PAGE text and wrapped with CONC", () => {
    const text = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 NAME Test /Person/
1 BIRT
2 SOUR @S1@
3 PAGE URL: https://www.newspapers.com/image/1113377202/?article=8ff19d92-c0c4-4915-becb-58f65785b3ad&focus=0.28180018,0.07831327,0.39671615,0.20754653&
4 CONC xid=3355
0 TRLR
`;
    const ds = buildFromText(text);
    const indi = ds.individuals.get("@I1@")!;
    const links = indi.events[0].links ?? [];
    expect(links).toEqual([
      "https://www.newspapers.com/image/1113377202/?article=8ff19d92-c0c4-4915-becb-58f65785b3ad&focus=0.28180018,0.07831327,0.39671615,0.20754653&xid=3355",
    ]);
  });

  it("reassembles a WWW value that is split mid-token across a CONT line", () => {
    const text = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 NAME Test /Person/
1 WWW https://www.example.com/very/long/path/that/keeps/g
2 CONT oing/forever?x=1
0 TRLR
`;
    const ds = buildFromText(text);
    const indi = ds.individuals.get("@I1@")!;
    expect(indi.links).toEqual(["https://www.example.com/very/long/path/that/keeps/going/forever?x=1"]);
  });

  it("keeps NOTE text with a CONT line break as a real line break, not a URL splice", () => {
    const text = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 NAME Test /Person/
1 NOTE https://data.matricula-online.eu/sl/slovenia/ljubljana/trstenik/02621/?pg=102
2 CONT botra Joh. Studen
0 TRLR
`;
    const ds = buildFromText(text);
    const indi = ds.individuals.get("@I1@")!;
    expect(indi.links).toEqual(["https://data.matricula-online.eu/sl/slovenia/ljubljana/trstenik/02621/?pg=102"]);
  });
});

describe("NOTE text with extracted URLs", () => {
  it("drops an event NOTE that contains only a URL once it's captured as a link", () => {
    const text = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 NAME Test /Person/
1 BURI
2 DATE APR 1995
2 NOTE https://de.geneanet.org/friedhof/view/9833663
0 TRLR
`;
    const ds = buildFromText(text);
    const indi = ds.individuals.get("@I1@")!;
    const buri = indi.events.find((e) => e.tag === "BURI")!;
    expect(buri.links).toEqual(["https://de.geneanet.org/friedhof/view/9833663"]);
    expect(buri.note).toBeUndefined();
    expect(buri.noteWithLinks).toBe("https://de.geneanet.org/friedhof/view/9833663");
  });

  it("clears the HTML wrapper left around a rich-text-pasted link once its URL is stripped", () => {
    const text = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 NAME Test /Person/
1 NOTE <p style="text-align: left;" dir="ltr">rojstvo</p><p style="text-align: left;" dir="ltr"><a href="https://data.matricula-online.eu/de/slovenia/ljubljana/preddvor/04120/?pg=56">https://data.matricula-online.eu/de/slovenia/ljubljana/preddvor/04120/?pg=56</a></p>
0 TRLR
`;
    const ds = buildFromText(text);
    const indi = ds.individuals.get("@I1@")!;
    expect(indi.links).toEqual(["https://data.matricula-online.eu/de/slovenia/ljubljana/preddvor/04120/?pg=56"]);
    expect(indi.notes).toEqual(["rojstvo"]);
  });

  it("strips rich-text HTML markup from a NOTE that has no link at all", () => {
    const text = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 NAME Test /Person/
1 NOTE <p style="text-align: left;" dir="ltr">rojstvo, smrt</p>
0 TRLR
`;
    const ds = buildFromText(text);
    const indi = ds.individuals.get("@I1@")!;
    expect(indi.notes).toEqual(["rojstvo, smrt"]);
    expect(indi.notesWithLinks).toBeUndefined();
  });

  it("strips just the URL from a NOTE that has other surrounding text", () => {
    const text = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 NAME Test /Person/
1 NOTE See https://data.matricula-online.eu/sl/test/?pg=1 for the record.
0 TRLR
`;
    const ds = buildFromText(text);
    const indi = ds.individuals.get("@I1@")!;
    expect(indi.links).toEqual(["https://data.matricula-online.eu/sl/test/?pg=1"]);
    expect(indi.notes).toEqual(["See for the record."]);
    expect(indi.notesWithLinks).toEqual(["See https://data.matricula-online.eu/sl/test/?pg=1 for the record."]);
  });
});

describe("family NOTE URL extraction", () => {
  it("extracts a URL embedded in a family-level NOTE into fam.links", () => {
    const text = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @F1@ FAM
1 NOTE https://data.matricula-online.eu/sl/test/?pg=1
0 TRLR
`;
    const ds = buildFromText(text);
    const fam = ds.families.get("@F1@")!;
    expect(fam.links).toEqual(["https://data.matricula-online.eu/sl/test/?pg=1"]);
  });

  it("does not add fam.links when the family NOTE contains no URL", () => {
    const text = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @F1@ FAM
1 NOTE Just a plain note with no link.
0 TRLR
`;
    const ds = buildFromText(text);
    const fam = ds.families.get("@F1@")!;
    expect(fam.links).toBeUndefined();
  });
});

describe("shared NOTE record resolution", () => {
  it("resolves an individual NOTE pointer to the shared record's text", () => {
    const text = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 NAME George /Washington/
1 NOTE @N1@
0 @N1@ NOTE First President of the United States
0 TRLR
`;
    const ds = buildFromText(text);
    const indi = ds.individuals.get("@I1@")!;
    expect(indi.notes).toEqual(["First President of the United States"]);
  });

  it("resolves a multi-line shared NOTE record folded from CONT lines", () => {
    const text = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 NAME Test /Person/
1 NOTE @N1@
0 @N1@ NOTE First line
1 CONT Second line
0 TRLR
`;
    const ds = buildFromText(text);
    const indi = ds.individuals.get("@I1@")!;
    expect(indi.notes).toEqual(["First line\nSecond line"]);
  });

  it("resolves a family NOTE pointer to the shared record's text", () => {
    const text = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @F1@ FAM
1 NOTE @N2@
0 @N2@ NOTE Married in 1759
0 TRLR
`;
    const ds = buildFromText(text);
    const fam = ds.families.get("@F1@")!;
    expect(fam.notes).toEqual(["Married in 1759"]);
  });

  it("resolves an event NOTE pointer to the shared record's text", () => {
    const text = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 NAME Test /Person/
1 BIRT
2 DATE 1732
2 NOTE @N1@
0 @N1@ NOTE Born at Pope's Creek
0 TRLR
`;
    const ds = buildFromText(text);
    const indi = ds.individuals.get("@I1@")!;
    const birt = indi.events.find((e) => e.tag === "BIRT")!;
    expect(birt.note).toBe("Born at Pope's Creek");
  });

  it("pulls a URL out of a pointer note's resolved text into links", () => {
    const text = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 NAME Test /Person/
1 NOTE @N1@
0 @N1@ NOTE See https://example.com/x for details
0 TRLR
`;
    const ds = buildFromText(text);
    const indi = ds.individuals.get("@I1@")!;
    expect(indi.links).toEqual(["https://example.com/x"]);
    expect(indi.notes).toEqual(["See for details"]);
  });

  it("leaves the raw pointer out of notes when the record is missing", () => {
    const text = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 NAME Test /Person/
1 NOTE @NMISSING@
0 TRLR
`;
    const ds = buildFromText(text);
    const indi = ds.individuals.get("@I1@")!;
    expect(indi.notes).toBeUndefined();
  });
});

describe("EVEN custom event extraction", () => {
  it("extracts a custom EVEN with TYPE, date and place into the events array", () => {
    const text = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 NAME Test /Person/
1 EVEN
2 TYPE Graduation
2 DATE 15 JUN 1985
2 PLAC Ljubljana, Slovenija
0 TRLR
`;
    const ds = buildFromText(text);
    const indi = ds.individuals.get("@I1@")!;
    expect(indi.events).toHaveLength(1);
    const ev = indi.events[0];
    expect(ev.tag).toBe("EVEN");
    expect(ev.type).toBe("Graduation");
    expect(ev.date?.year).toBe(1985);
    expect(ev.place?.raw).toBe("Ljubljana, Slovenija");
  });
});

describe("AGNC and CAUS extraction", () => {
  it("extracts AGNC (agency) from a death event", () => {
    const text = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 NAME Test /Person/
1 DEAT
2 DATE 3 MAR 1950
2 AGNC Splošna bolnišnica Ljubljana
0 TRLR
`;
    const ds = buildFromText(text);
    const indi = ds.individuals.get("@I1@")!;
    const death = indi.events.find((e) => e.tag === "DEAT")!;
    expect(death.agency).toBe("Splošna bolnišnica Ljubljana");
  });

  it("extracts CAUS (cause) from a death event", () => {
    const text = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 NAME Test /Person/
1 DEAT
2 DATE 3 MAR 1950
2 CAUS Tuberculosis
0 TRLR
`;
    const ds = buildFromText(text);
    const indi = ds.individuals.get("@I1@")!;
    const death = indi.events.find((e) => e.tag === "DEAT")!;
    expect(death.cause).toBe("Tuberculosis");
  });

  it("extracts both AGNC and CAUS from the same event", () => {
    const text = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 NAME Test /Person/
1 DEAT
2 AGNC City Hospital
2 CAUS Heart failure
0 TRLR
`;
    const ds = buildFromText(text);
    const indi = ds.individuals.get("@I1@")!;
    const death = indi.events.find((e) => e.tag === "DEAT")!;
    expect(death.agency).toBe("City Hospital");
    expect(death.cause).toBe("Heart failure");
  });
});
