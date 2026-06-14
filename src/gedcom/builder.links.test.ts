import { describe, expect, it } from "vitest";
import { parseGedcom } from "./parser";
import { buildDataset } from "./builder";

function buildFromText(text: string) {
  const buf = new TextEncoder().encode(text);
  const parsed = parseGedcom(buf.buffer);
  return buildDataset(parsed);
}

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
