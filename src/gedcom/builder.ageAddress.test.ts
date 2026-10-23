import { describe, expect, it } from "vitest";
import { parseGedcom } from "./parser";
import { buildDataset } from "./builder";
import { serializeDataset } from "./serialize";

function load(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

const AGE_ADDRESS_FILE = [
  "0 HEAD",
  "1 GEDC",
  "2 VERS 5.5.1",
  "1 CHAR UTF-8",
  "0 @I1@ INDI",
  "1 NAME Janez /Novak/",
  "1 DEAT",
  "2 DATE 3 MAR 1890",
  "2 PLAC Kranj",
  "2 AGE 62y 3m",
  "1 RESI",
  "2 ADDR Dunajska 5",
  "3 ADR1 Dunajska 5",
  "3 CITY Ljubljana",
  "3 STAE Kranjska",
  "3 POST 1000",
  "3 CTRY Slovenija",
  "2 PHON +386 1 234 5678",
  "2 EMAI janez@example.org",
  "1 CENS",
  "2 ADDR",
  "3 ADR1 Glavni trg 3",
  "3 CITY Kranj",
  "1 FAMS @F1@",
  "0 @I2@ INDI",
  "1 NAME Marija /Kovač/",
  "1 FAMS @F1@",
  "0 @F1@ FAM",
  "1 HUSB @I1@",
  "1 WIFE @I2@",
  "1 MARR",
  "2 DATE 1855",
  "2 HUSB",
  "3 AGE 27y",
  "2 WIFE",
  "3 AGE <20y",
  "0 TRLR",
  "",
].join("\r\n");

describe("builder: stated ages and structured addresses", () => {
  const ds = load(AGE_ADDRESS_FILE);
  const janez = ds.individuals.get("@I1@")!;

  it("reads an individual event's AGE", () => {
    expect(janez.events.find((e) => e.tag === "DEAT")?.age).toBe("62y 3m");
  });

  it("reads each spouse's AGE under a family event", () => {
    const marr = ds.families.get("@F1@")!.events.find((e) => e.tag === "MARR")!;
    expect(marr.husbandAge).toBe("27y");
    expect(marr.wifeAge).toBe("<20y");
  });

  it("reads an ADDR's labelled lines and the contact lines beside it", () => {
    const resi = janez.events.find((e) => e.tag === "RESI")!;
    expect(resi.address?.raw).toBe("Dunajska 5");
    expect(resi.addressLine).toBe("Dunajska 5");
    expect(resi.addressParts).toEqual({ ADR1: "Dunajska 5", CITY: "Ljubljana", STAE: "Kranjska", POST: "1000", CTRY: "Slovenija" });
    expect(resi.phone).toBe("+386 1 234 5678");
    expect(resi.email).toBe("janez@example.org");
  });

  it("joins the lines into the address when the ADDR has no text of its own", () => {
    const cens = janez.events.find((e) => e.tag === "CENS")!;
    expect(cens.address?.raw).toBe("Glavni trg 3, Kranj");
    expect(cens.addressLine).toBeUndefined();
    expect(cens.addressParts).toEqual({ ADR1: "Glavni trg 3", CITY: "Kranj" });
  });

  it("leaves a line-only ADDR without parts", () => {
    const lineOnly = AGE_ADDRESS_FILE.replace(/\r\n3 ADR1 Dunajska 5[\s\S]*?3 CTRY Slovenija/, "");
    const resi = load(lineOnly).individuals.get("@I1@")!.events.find((e) => e.tag === "RESI")!;
    expect(resi.address?.raw).toBe("Dunajska 5");
    expect(resi.addressParts).toBeUndefined();
  });

  it("saves an untouched file byte for byte", () => {
    expect(serializeDataset(ds)).toBe(AGE_ADDRESS_FILE);
  });
});
