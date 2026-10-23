import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import { decisionKey, type CandidateDecision } from "../review/types";
import { individualFieldRows } from "../review/fields";
import { mergeDecisions } from "./merge";

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
