import { describe, expect, it } from "vitest";
import { deflateRawSync } from "node:zlib";
import { looksLikeWorkbook, readWorkbook } from "./xlsx";
import { isTableFile, parseCompareTable } from "./compareCsv";

// ── A workbook, built by hand ────────────────────────────────────────────────
// Small enough to write out, which is the point: the fixture states exactly what
// a spreadsheet puts in the file, including the two things that break a naive
// reader — pooled text written in several runs, and a row that skips a column.

interface ZipFile {
  name: string;
  text: string;
  /** Stored rather than deflated, so both branches of the reader are exercised. */
  stored?: boolean;
}

function zip(files: ZipFile[]): ArrayBuffer {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const name = new TextEncoder().encode(file.name);
    const raw = new TextEncoder().encode(file.text);
    const body = file.stored ? raw : new Uint8Array(deflateRawSync(raw));
    const method = file.stored ? 0 : 8;

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, method, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);

    const entry = new Uint8Array(46 + name.length);
    const ev = new DataView(entry.buffer);
    ev.setUint32(0, 0x02014b50, true);
    ev.setUint16(10, method, true);
    ev.setUint32(20, body.length, true);
    ev.setUint32(24, raw.length, true);
    ev.setUint16(28, name.length, true);
    ev.setUint32(42, offset, true);
    entry.set(name, 46);

    chunks.push(local, body);
    central.push(entry);
    offset += local.length + body.length;
  }

  const directory = concat(central);
  const eocd = new Uint8Array(22);
  const dv = new DataView(eocd.buffer);
  dv.setUint32(0, 0x06054b50, true);
  dv.setUint16(8, files.length, true);
  dv.setUint16(10, files.length, true);
  dv.setUint32(12, directory.length, true);
  dv.setUint32(16, offset, true);

  const all = concat([...chunks, directory, eocd]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength) as ArrayBuffer;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A `<row>` of cells, each `[ref, "s"|"inlineStr"|"n", value]`. */
function sheet(rows: string[]): string {
  return `<?xml version="1.0"?><worksheet><sheetData>${rows.join("")}</sheetData></worksheet>`;
}

function shared(...items: string[]): string {
  return `<?xml version="1.0"?><sst>${items.join("")}</sst>`;
}

const WORKBOOK = `<?xml version="1.0"?><workbook><sheets>` +
  `<sheet name="navodila" sheetId="1" r:id="rId1"/>` +
  `<sheet name="K 1837-1890" sheetId="2" r:id="rId2"/>` +
  `</sheets></workbook>`;

const RELS = `<?xml version="1.0"?><Relationships>` +
  `<Relationship Id="rId1" Target="worksheets/sheet9.xml"/>` +
  `<Relationship Id="rId2" Target="worksheets/sheet1.xml"/>` +
  `</Relationships>`;

describe("isTableFile", () => {
  it("tells an incoming table from a GEDCOM", () => {
    for (const name of ["Indeks P Podzemelj.csv", "Indeks K Grahovo.XLSX", "P Duplje.xlsm"]) {
      expect(isTableFile(name), name).toBe(true);
    }
    for (const name of ["tree.ged", "tree.gedcom", "notes.csv.ged", "Indeks.xls"]) {
      expect(isTableFile(name), name).toBe(false);
    }
  });
});

describe("looksLikeWorkbook", () => {
  it("knows a zip container from CSV text", () => {
    expect(looksLikeWorkbook(zip([{ name: "a.xml", text: "<a/>" }]))).toBe(true);
    expect(looksLikeWorkbook(new TextEncoder().encode("Ime;Priimek\n").buffer as ArrayBuffer)).toBe(false);
    expect(looksLikeWorkbook(new ArrayBuffer(0))).toBe(false);
  });
});

describe("readWorkbook: date cells", () => {
  // Styles: 0 General, 1 the built-in date (14), 2 a custom date, 3 a custom
  // format that is no date.
  const STYLES = `<?xml version="1.0"?><styleSheet>` +
    `<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/><numFmt numFmtId="165" formatCode="0.00 &quot;dni&quot;"/></numFmts>` +
    `<cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/></cellXfs>` +
    `</styleSheet>`;
  const ONE = `<?xml version="1.0"?><workbook><sheets><sheet name="K" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const ONE_REL = `<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`;
  const cells = (workbook: string, row: string) =>
    readWorkbook(zip([
      { name: "xl/workbook.xml", text: workbook },
      { name: "xl/_rels/workbook.xml.rels", text: ONE_REL },
      { name: "xl/styles.xml", text: STYLES },
      { name: "xl/worksheets/sheet1.xml", text: sheet([row]) },
    ])).then((sheets) => sheets[0].rows[0]);

  it("reads a number its cell shows as a date as that date", async () => {
    // 1 May 1910 is stored as 3774 — which, unread, imported as the year 3774.
    const row = await cells(ONE,
      `<row><c r="A1" s="1"><v>3774</v></c><c r="B1" s="2"><v>3774</v></c><c r="C1" s="0"><v>3774</v></c><c r="D1" s="3"><v>3774</v></c><c r="E1"><v>12</v></c></row>`);
    expect(row).toEqual(["1910-05-01", "1910-05-01", "3774", "3774", "12"]);
  });

  it("counts from the right day either side of the 29 February 1900 that never was", async () => {
    const row = await cells(ONE,
      `<row><c r="A1" s="1"><v>1</v></c><c r="B1" s="1"><v>59</v></c><c r="C1" s="1"><v>61</v></c><c r="D1" s="1"><v>45000.75</v></c></row>`);
    expect(row).toEqual(["1900-01-01", "1900-02-28", "1900-03-01", "2023-03-15"]);
  });

  it("counts from 1904 where the workbook says so", async () => {
    const mac = `<?xml version="1.0"?><workbook><workbookPr date1904="1"/><sheets><sheet name="K" sheetId="1" r:id="rId1"/></sheets></workbook>`;
    expect(await cells(mac, `<row><c r="A1" s="1"><v>0</v></c><c r="B1" s="1"><v>366</v></c></row>`)).toEqual(["1904-01-01", "1905-01-01"]);
  });
});

describe("readWorkbook", () => {
  it("reads sheets in tab order, not in file-number order", async () => {
    const sheets = await readWorkbook(
      zip([
        { name: "xl/workbook.xml", text: WORKBOOK },
        { name: "xl/_rels/workbook.xml.rels", text: RELS },
        { name: "xl/worksheets/sheet1.xml", text: sheet([`<row><c r="A1" t="inlineStr"><is><t>index</t></is></c></row>`]) },
        { name: "xl/worksheets/sheet9.xml", text: sheet([`<row><c r="A1" t="inlineStr"><is><t>how to</t></is></c></row>`]) },
      ]),
    );
    expect(sheets.map((s) => s.name)).toEqual(["navodila", "K 1837-1890"]);
    // The instructions tab is sheet9.xml and the index is sheet1.xml — reading
    // the relationship table is what keeps each name on its own contents.
    expect(sheets[0].rows[0][0]).toBe("how to");
    expect(sheets[1].rows[0][0]).toBe("index");
  });

  it("joins the runs of one pooled string", async () => {
    // A cell whose text was typed in two fonts is stored as two runs. Counting
    // runs instead of strings would shift every later index by one.
    const sheets = await readWorkbook(
      zip([
        { name: "xl/workbook.xml", text: `<?xml version="1.0"?><workbook><sheets><sheet name="s" r:id="rId1"/></sheets></workbook>` },
        { name: "xl/_rels/workbook.xml.rels", text: `<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>` },
        { name: "xl/sharedStrings.xml", text: shared(`<si><r><t>Marija </t></r><r><t>Ana</t></r></si>`, `<si><t>Kralj</t></si>`) },
        { name: "xl/worksheets/sheet1.xml", text: sheet([`<row><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>`]) },
      ]),
    );
    expect(sheets[0].rows[0]).toEqual(["Marija Ana", "Kralj"]);
  });

  it("puts a skipped column back where it belongs", async () => {
    // A blank cell is simply absent from the file. Read positionally, this row
    // would put the surname in the date's column.
    const sheets = await readWorkbook(
      zip([
        { name: "xl/workbook.xml", text: `<?xml version="1.0"?><workbook><sheets><sheet name="s" r:id="rId1"/></sheets></workbook>` },
        { name: "xl/_rels/workbook.xml.rels", text: `<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>` },
        {
          name: "xl/worksheets/sheet1.xml",
          text: sheet([`<row><c r="A1" t="inlineStr"><is><t>Janez</t></is></c><c r="D1" t="inlineStr"><is><t>Novak</t></is></c></row>`]),
        },
      ]),
    );
    expect(sheets[0].rows[0]).toEqual(["Janez", "", "", "Novak"]);
  });

  it("reads numbers, booleans, empty cells and XML entities", async () => {
    const sheets = await readWorkbook(
      zip([
        { name: "xl/workbook.xml", text: `<?xml version="1.0"?><workbook><sheets><sheet name="s" r:id="rId1"/></sheets></workbook>` },
        { name: "xl/_rels/workbook.xml.rels", text: `<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>` },
        { name: "xl/sharedStrings.xml", text: shared(`<si><t>Kova&#269;i&#269; &amp; sin</t></si>`) },
        {
          name: "xl/worksheets/sheet1.xml",
          text: sheet([
            `<row><c r="A1"><v>1873</v></c><c r="B1" t="b"><v>1</v></c><c r="C1"/>` +
              `<c r="D1" t="s"><v>0</v></c><c r="E1" t="e"><v>#REF!</v></c></row>`,
          ]),
        },
      ]),
    );
    expect(sheets[0].rows[0]).toEqual(["1873", "TRUE", "", "Kovačič & sin", ""]);
  });

  it("keeps a character reference beyond Unicode as written instead of failing", async () => {
    const sheets = await readWorkbook(
      zip([
        { name: "xl/workbook.xml", text: `<?xml version="1.0"?><workbook><sheets><sheet name="s" r:id="rId1"/></sheets></workbook>` },
        { name: "xl/_rels/workbook.xml.rels", text: `<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>` },
        { name: "xl/sharedStrings.xml", text: shared(`<si><t>a&#1114112;b&#x110000;c&#x10FFFF;</t></si>`) },
        { name: "xl/worksheets/sheet1.xml", text: sheet([`<row><c r="A1" t="s"><v>0</v></c></row>`]) },
      ]),
    );
    expect(sheets[0].rows[0]).toEqual(["a&#1114112;b&#x110000;c\u{10FFFF}"]);
  });

  it("returns nothing for a zip that is not a workbook", async () => {
    expect(await readWorkbook(zip([{ name: "readme.txt", text: "hello" }]))).toEqual([]);
  });
});

describe("parseCompareTable", () => {
  const header = [
    "zp. št.", "župnija", "datum rojstva", "datum krsta", "naslov",
    "ime otroka", "ime očeta", "priimek očeta", "ime matere", "priimek matere", "opombe",
  ];
  const row = ["1", "Grahovo", "1837-02-21", "1837-02-24", "Žerovnica 31", "Matija", "Anton", "Šega", "Elizabeta", "Gornik", ""];

  const inline = (cells: string[], n: number): string =>
    `<row>${cells
      .map((v, i) => (v ? `<c r="${String.fromCharCode(65 + i)}${n}" t="inlineStr"><is><t>${v}</t></is></c>` : ""))
      .join("")}</row>`;

  const workbook = (stored: boolean): ArrayBuffer =>
    zip([
      { name: "xl/workbook.xml", text: WORKBOOK, stored },
      { name: "xl/_rels/workbook.xml.rels", text: RELS, stored },
      { name: "xl/worksheets/sheet1.xml", text: sheet([inline(header, 1), inline(row, 2)]), stored },
      // The instructions tab, which must not be mistaken for the index.
      { name: "xl/worksheets/sheet9.xml", text: sheet([inline(["Kako indeksirati"], 1)]), stored },
    ]);

  it("finds the index sheet in a workbook and imports it", async () => {
    const { dataset, pairs } = await parseCompareTable(workbook(false));
    expect(pairs).toBeUndefined(); // the ordinary engine matches it, not the pair path
    const names = [...dataset.individuals.values()].map((i) => `${i.names[0]?.given} ${i.names[0]?.surname}`);
    expect(names).toEqual(["Matija Šega", "Anton Šega", "Elizabeta Gornik"]);
  });

  it("reads a stored (uncompressed) workbook too", async () => {
    const { dataset } = await parseCompareTable(workbook(true));
    expect(dataset.individuals.size).toBe(3);
  });

  it("names the sheets it looked in when none is an index", async () => {
    const notAnIndex = zip([
      { name: "xl/workbook.xml", text: WORKBOOK },
      { name: "xl/_rels/workbook.xml.rels", text: RELS },
      { name: "xl/worksheets/sheet1.xml", text: sheet([inline(["Ime", "Priimek"], 1)]) },
      { name: "xl/worksheets/sheet9.xml", text: sheet([inline(["Kako indeksirati"], 1)]) },
    ]);
    await expect(parseCompareTable(notAnIndex)).rejects.toThrow(/navodila, K 1837-1890/);
  });

  it("still reads CSV text, and decides on the bytes rather than the name", async () => {
    const text = `${header.join(";")}\r\n${row.join(";")}\r\n`;
    const { dataset } = await parseCompareTable(new TextEncoder().encode(text).buffer as ArrayBuffer);
    expect(dataset.individuals.size).toBe(3);
  });
});
