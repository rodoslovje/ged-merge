import { describe, expect, it } from "vitest";
import { buildDataset } from "./builder";
import { parseGedcom } from "./parser";
import { captureBaseline, recordFingerprint } from "./fingerprint";
import type { GedNode } from "./types";

const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;
const dataset = (text: string) => buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));

const PERSON = "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 1850\n2 PLAC Kranj\n";

function record(text: string): GedNode {
  return dataset(wrap(text)).records.find((r) => r.xref === "@I1@")!;
}

describe("recordFingerprint", () => {
  it("is stable for the same record parsed twice", () => {
    expect(recordFingerprint(record(PERSON))).toBe(recordFingerprint(record(PERSON)));
  });

  it("moves when a value changes", () => {
    expect(recordFingerprint(record(PERSON))).not.toBe(
      recordFingerprint(record(PERSON.replace("Kranj", "Kranj, Slovenia"))),
    );
  });

  it("moves when a line is added or removed", () => {
    expect(recordFingerprint(record(PERSON))).not.toBe(
      recordFingerprint(record(PERSON + "1 SEX M\n")),
    );
  });

  // The place a line hangs from is as much of the record as its text: a date
  // that slid from BIRT to DEAT says something else entirely.
  it("moves when a line moves to another parent", () => {
    const under = record("0 @I1@ INDI\n1 BIRT\n2 DATE 1850\n1 DEAT\n");
    const beside = record("0 @I1@ INDI\n1 BIRT\n1 DEAT\n2 DATE 1850\n");
    expect(recordFingerprint(under)).not.toBe(recordFingerprint(beside));
  });

  // Both are runtime-only annotations the serializer never writes, so a record
  // carrying one still reaches the file exactly as it arrived.
  it("ignores annotations that are never serialized", () => {
    const plain = record(PERSON);
    const annotated = record(PERSON);
    annotated.children[1].children[1].reshapedFrom = "Kranj (Slovenija)";
    annotated.children[1].auditStamp = "changed";
    expect(recordFingerprint(annotated)).toBe(recordFingerprint(plain));
  });
});

describe("captureBaseline", () => {
  const ds = dataset(wrap(
    PERSON +
    "0 @I2@ INDI\n1 NAME Ana /Kos/\n" +
    "0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n" +
    "0 @S1@ SOUR\n1 TITL Krstna knjiga\n",
  ));
  const baseline = captureBaseline(
    ds,
    (id) => (id === "@I1@" ? "Janez Novak" : "Ana Kos"),
    () => "Janez Novak + Ana Kos",
  );

  it("covers every record that carries an xref, by kind", () => {
    expect([...baseline.keys()].sort()).toEqual(["@F1@", "@I1@", "@I2@", "@S1@"]);
    expect(baseline.get("@I1@")!.kind).toBe("individual");
    expect(baseline.get("@F1@")!.kind).toBe("family");
    expect(baseline.get("@S1@")!.kind).toBe("record");
  });

  // A record deleted before the save is gone from the dataset by the time the
  // report is written; this label is the only name left to report it by.
  it("keeps the label of persons and families", () => {
    expect(baseline.get("@I1@")!.label).toBe("Janez Novak");
    expect(baseline.get("@F1@")!.label).toBe("Janez Novak + Ana Kos");
    expect(baseline.get("@S1@")!.label).toBeUndefined();
  });
});
