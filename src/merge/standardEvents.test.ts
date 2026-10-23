import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import { decisionKey, type CandidateDecision } from "../review/types";
import { individualFieldRows } from "../review/fields";
import { mergeDecisions } from "./merge";
import { addEventNode, setEventFieldAtIndex } from "../gedcom/edit";
import { todayGedcom } from "../gedcom/chanCrea";
import { buildTimeline } from "../chart/timeline";

/** The standard GEDCOM events the app lifts as first-class ones: read into the
 *  typed model, compared in the review, imported by the merge, and written
 *  back byte for byte when nothing touched them. */

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}
const tr = (key: string) => key;
const NO_MATCHES = { individuals: [], families: [] };
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;

function confirmed(mainId: string, compareId: string, fields: Record<string, "main" | "incoming" | "both"> = {}): Map<string, CandidateDecision> {
  return new Map([[decisionKey("individual", mainId, compareId), { status: "confirmed", fields }]]);
}

describe("individual events: ORDN, CHRA, BLES, BARM, BASM", () => {
  const TAGS = ["ORDN", "CHRA", "BLES", "BARM", "BASM"];
  const body = TAGS.map((tag, i) => `1 ${tag}\n2 DATE ${1900 + i}\n2 PLAC Kranj\n`).join("");
  const text = wrap(`0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1880\n${body}`);

  it("lifts each into the person's events", () => {
    const indi = dataset(text).individuals.get("@I1@")!;
    for (const [i, tag] of TAGS.entries()) {
      const ev = indi.events.find((e) => e.tag === tag);
      expect(ev?.date?.year).toBe(1900 + i);
      expect(ev?.place?.raw).toBe("Kranj");
    }
  });

  it("writes an untouched file back byte for byte", () => {
    expect(serializeGedcom(dataset(text).records)).toBe(text);
  });

  it("compares them in the review under their own names", () => {
    const main = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 ORDN\n2 DATE 1905\n"));
    const compare = dataset(wrap("0 @P1@ INDI\n1 NAME Janez /Novak/\n1 ORDN\n2 DATE 1906\n2 PLAC Ljubljana\n"));
    const rows = individualFieldRows(tr, main.individuals.get("@I1@"), compare.individuals.get("@P1@"));
    expect(rows.find((r) => r.key === "ORDN.header")?.label).toBe("event.ORDN");
    expect(rows.find((r) => r.key === "ORDN.date")).toMatchObject({ main: "1905", incoming: "1906" });
    expect(rows.find((r) => r.key === "ORDN.place")).toMatchObject({ incoming: "Ljubljana" });
  });

  it("imports an incoming ORDN the main lacks", () => {
    const main = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1880\n"));
    const compare = dataset(wrap("0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1880\n1 ORDN\n2 DATE 29 JUN 1905\n2 PLAC Ljubljana\n"));
    const { records } = mergeDecisions(main, compare, confirmed("@I1@", "@P1@"), NO_MATCHES, tr);
    expect(serializeGedcom(records)).toContain("1 BIRT\n2 DATE 1880\n1 ORDN\n2 DATE 29 JUN 1905\n2 PLAC Ljubljana\n");
  });

  it("imports a bar mitzvah and an adult christening alongside each other", () => {
    const main = dataset(wrap("0 @I1@ INDI\n1 NAME Ana /Kos/\n1 SEX F\n1 BIRT\n2 DATE 1880\n"));
    const compare = dataset(wrap("0 @P1@ INDI\n1 NAME Ana /Kos/\n1 SEX F\n1 BIRT\n2 DATE 1880\n1 BASM\n2 DATE 1893\n1 CHRA\n2 DATE 1920\n"));
    const { records } = mergeDecisions(main, compare, confirmed("@I1@", "@P1@"), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("1 BASM\n2 DATE 1893\n");
    expect(out).toContain("1 CHRA\n2 DATE 1920\n");
  });
});

describe("family events: ANUL, DIVF, MARC, MARS, RESI, CENS, NCHI", () => {
  const people =
    "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @F1@\n" +
    "0 @I2@ INDI\n1 NAME Marija /Kos/\n1 SEX F\n1 FAMS @F1@\n";
  const famBody =
    "1 MARC\n2 DATE 1899\n1 MARS\n2 DATE 1899\n2 AGNC Notar Kranj\n1 RESI Glavni trg 3\n2 DATE 1901\n" +
    "1 RESI\n2 DATE 1911\n2 PLAC Ljubljana\n1 CENS\n2 DATE 1910\n1 NCHI 4\n1 DIVF\n2 DATE 1920\n1 ANUL\n2 DATE 1921\n";
  const text = wrap(`${people}0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n1 MARR\n2 DATE 1900\n${famBody}`);
  const comparePeople =
    "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @G1@\n" +
    "0 @P2@ INDI\n1 NAME Marija /Kos/\n1 SEX F\n1 FAMS @G1@\n";

  it("lifts each into the family's events, the repeated residence included", () => {
    const fam = dataset(text).families.get("@F1@")!;
    expect(fam.events.map((e) => e.tag)).toEqual(["MARR", "MARC", "MARS", "RESI", "RESI", "CENS", "NCHI", "DIVF", "ANUL"]);
    expect(fam.events.find((e) => e.tag === "NCHI")?.value).toBe("4");
    expect(fam.events.find((e) => e.tag === "MARS")?.agency).toBe("Notar Kranj");
    expect(fam.events.filter((e) => e.tag === "RESI").map((e) => e.date?.year)).toEqual([1901, 1911]);
  });

  it("writes an untouched file back byte for byte", () => {
    expect(serializeGedcom(dataset(text).records)).toBe(text);
  });

  it("imports the incoming family's annulment, residence and child count, leaving its second residence alone", () => {
    const main = dataset(wrap(`${people}0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n1 MARR\n2 DATE 1900\n`));
    const compare = dataset(wrap(`${comparePeople}0 @G1@ FAM\n1 HUSB @P1@\n1 WIFE @P2@\n1 MARR\n2 DATE 1900\n${famBody}`));
    const matches = { individuals: [{ mainId: "@I1@", compareId: "@P1@" }, { mainId: "@I2@", compareId: "@P2@" }] } as never;
    const { records } = mergeDecisions(main, compare, confirmed("@I1@", "@P1@"), matches, tr);
    const out = serializeGedcom(records);
    const fam = out.slice(out.indexOf("0 @F1@ FAM"), out.indexOf("0 TRLR"));
    expect(fam).toContain("1 ANUL\n2 DATE 1921\n");
    expect(fam).toContain("1 DIVF\n2 DATE 1920\n");
    expect(fam).toContain("1 MARS\n2 DATE 1899\n2 AGNC Notar Kranj\n");
    expect(fam).toContain("1 NCHI 4\n");
    expect(fam).toContain("1 RESI Glavni trg 3\n2 DATE 1901\n");
    expect(fam).toContain("1 CENS\n2 DATE 1910\n");
    // One row per tag: the family's second residence is not offered.
    expect(fam).not.toContain("1911");
  });

  it("compares a family's events in the review under the couple's own names", () => {
    const main = dataset(wrap(`${people}0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n1 RESI\n2 DATE 1901\n`));
    const compare = dataset(wrap(`${comparePeople}0 @G1@ FAM\n1 HUSB @P1@\n1 WIFE @P2@\n1 RESI\n2 DATE 1902\n1 ANUL\n2 DATE 1921\n`));
    const rows = individualFieldRows(tr, main.individuals.get("@I1@"), compare.individuals.get("@P1@"), main, compare);
    const header = (tag: string) => rows.find((r) => r.isEventHeader && r.key.endsWith(`.${tag}.header`));
    expect(header("RESI")?.label).toBe("event.fam.RESI");
    expect(header("ANUL")?.label).toBe("event.ANUL");
    expect(rows.find((r) => r.key.endsWith(".RESI.date"))).toMatchObject({ main: "1901", incoming: "1902" });
  });
});

describe("LDS ordinances: BAPL, CONL, ENDL, SLGC, SLGS", () => {
  const indiBody =
    "1 BAPL\n2 DATE 12 MAR 1950\n2 TEMP SLAKE\n2 STAT COMPLETED\n3 DATE 14 MAR 1950\n" +
    "1 CONL\n2 DATE 13 MAR 1950\n2 TEMP SLAKE\n" +
    "1 ENDL\n2 STAT SUBMITTED\n3 DATE 1 JAN 2001\n" +
    "1 SLGC\n2 DATE 1960\n2 TEMP LOGAN\n2 FAMC @F1@\n";
  const text = wrap(
    `0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1900\n${indiBody}1 FAMC @F1@\n` +
    "0 @I2@ INDI\n1 NAME Peter /Novak/\n1 SEX M\n1 FAMS @F1@\n" +
    "0 @I3@ INDI\n1 NAME Ana /Kos/\n1 SEX F\n1 FAMS @F1@\n" +
    "0 @F1@ FAM\n1 HUSB @I2@\n1 WIFE @I3@\n1 CHIL @I1@\n1 SLGS\n2 DATE 1955\n2 TEMP SLAKE\n2 STAT COMPLETED\n3 DATE 1955\n",
  );

  it("lifts the temple, the status with its date, and the family a sealing to parents seals to", () => {
    const ds = dataset(text);
    const indi = ds.individuals.get("@I1@")!;
    expect(indi.events.find((e) => e.tag === "BAPL")).toMatchObject({ temple: "SLAKE", status: "COMPLETED", statusDate: "14 MAR 1950" });
    expect(indi.events.find((e) => e.tag === "CONL")?.temple).toBe("SLAKE");
    expect(indi.events.find((e) => e.tag === "ENDL")).toMatchObject({ status: "SUBMITTED", statusDate: "1 JAN 2001" });
    expect(indi.events.find((e) => e.tag === "SLGC")).toMatchObject({ temple: "LOGAN", family: "@F1@" });
    expect(ds.families.get("@F1@")!.events.find((e) => e.tag === "SLGS")).toMatchObject({ temple: "SLAKE", status: "COMPLETED" });
  });

  it("writes an untouched file back byte for byte", () => {
    expect(serializeGedcom(dataset(text).records)).toBe(text);
  });

  it("edits the temple, and dates a changed status today while an unchanged one keeps its date", () => {
    const ds = dataset(text);
    const indi = ds.individuals.get("@I1@")!;
    const bapl = indi.events.findIndex((e) => e.tag === "BAPL");
    setEventFieldAtIndex(indi, bapl, { temple: "LOGAN", status: "COMPLETED" });
    expect(serializeGedcom(ds.records)).toContain("1 BAPL\n2 DATE 12 MAR 1950\n2 TEMP LOGAN\n2 STAT COMPLETED\n3 DATE 14 MAR 1950\n");
    const endl = indi.events.findIndex((e) => e.tag === "ENDL");
    setEventFieldAtIndex(indi, endl, { status: "COMPLETED" });
    expect(serializeGedcom(ds.records)).toContain(`1 ENDL\n2 STAT COMPLETED\n3 DATE ${todayGedcom()}\n`);
    setEventFieldAtIndex(indi, endl, { status: "" });
    expect(serializeGedcom(ds.records)).not.toContain("1 ENDL");
  });

  it("a new sealing to parents names the person's birth family", () => {
    const ds = dataset(text);
    const indi = ds.individuals.get("@I1@")!;
    addEventNode(indi, "SLGC");
    const sealings = indi.raw.children.filter((c) => c.tag === "SLGC");
    expect(sealings[1].children.map((c) => `${c.tag} ${c.value}`)).toEqual(["FAMC @F1@"]);
  });

  it("compares the temple and the status in the review", () => {
    const main = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 BAPL\n2 DATE 1950\n2 TEMP SLAKE\n"));
    const compare = dataset(wrap("0 @P1@ INDI\n1 NAME Janez /Novak/\n1 BAPL\n2 DATE 1950\n2 TEMP LOGAN\n2 STAT COMPLETED\n3 DATE 1951\n"));
    const rows = individualFieldRows(tr, main.individuals.get("@I1@"), compare.individuals.get("@P1@"));
    expect(rows.find((r) => r.key === "BAPL.header")?.label).toBe("event.BAPL");
    expect(rows.find((r) => r.key === "BAPL.temple")).toMatchObject({ main: "SLAKE", incoming: "LOGAN", state: "conflict" });
    expect(rows.find((r) => r.key === "BAPL.status")).toMatchObject({ incoming: "COMPLETED" });
  });

  it("imports an incoming ordinance with its temple and its dated status, sealing to the main's own family", () => {
    const main = dataset(wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1900\n1 FAMC @F7@\n" +
      "0 @F7@ FAM\n1 CHIL @I1@\n",
    ));
    const compare = dataset(wrap(
      "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1900\n" +
      "1 BAPL\n2 DATE 1950\n2 TEMP SLAKE\n2 STAT COMPLETED\n3 DATE 1951\n1 SLGC\n2 DATE 1960\n2 TEMP LOGAN\n2 FAMC @G1@\n",
    ));
    const { records } = mergeDecisions(main, compare, confirmed("@I1@", "@P1@"), NO_MATCHES, tr);
    const out = serializeGedcom(records);
    expect(out).toContain("1 BAPL\n2 DATE 1950\n2 TEMP SLAKE\n2 STAT COMPLETED\n3 DATE 1951\n");
    expect(out).toContain("1 SLGC\n2 DATE 1960\n2 TEMP LOGAN\n2 FAMC @F7@\n");
    expect(out).not.toContain("@G1@");
  });

  it("imports a family's sealing to spouse with its temple and status", () => {
    const people = (p: string, f: string) =>
      `0 @${p}1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @${f}@\n0 @${p}2@ INDI\n1 NAME Marija /Kos/\n1 SEX F\n1 FAMS @${f}@\n`;
    const main = dataset(wrap(`${people("I", "F1")}0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n`));
    const compare = dataset(wrap(`${people("P", "G1")}0 @G1@ FAM\n1 HUSB @P1@\n1 WIFE @P2@\n1 SLGS\n2 DATE 1955\n2 TEMP SLAKE\n2 STAT COMPLETED\n3 DATE 1956\n`));
    const matches = { individuals: [{ mainId: "@I1@", compareId: "@P1@" }, { mainId: "@I2@", compareId: "@P2@" }] } as never;
    const { records } = mergeDecisions(main, compare, confirmed("@I1@", "@P1@"), matches, tr);
    expect(serializeGedcom(records)).toContain("1 SLGS\n2 DATE 1955\n2 TEMP SLAKE\n2 STAT COMPLETED\n3 DATE 1956\n");
  });

  it("stays off the timeline: a proxy ordinance's date is not a point in the life", () => {
    const ds = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 1800\n1 DEAT\n2 DATE 1860\n1 ENDL\n2 DATE 1990\n"));
    const data = buildTimeline(tr, ds, "@I1@", () => "Janez", 2026)!;
    expect(data.rows[0].marks.some((m) => m.year === 1990)).toBe(false);
    expect(data.maxYear).toBe(1860);
  });
});
