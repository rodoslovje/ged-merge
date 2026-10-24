import { describe, expect, it } from "vitest";
import { parseGedcom } from "../gedcom/parser";
import type { GedNode } from "../gedcom/types";
import { diffRecord, recordsByXref } from "./recordDiff";

/** One record, parsed from the lines a file would carry it on. */
function record(text: string): GedNode {
  const records = parseGedcom(new TextEncoder().encode(text).buffer).records;
  return records[0];
}

/** The diff as a reader sees it: one string per line, changed lines marked. */
function shown(before: GedNode | undefined, after: GedNode | undefined): string[] {
  return diffRecord(before, after).lines.map((l) =>
    l.kind === "add" ? `+ ${l.text}` : l.kind === "del" ? `- ${l.text}` : l.kind === "gap" ? "…" : `  ${l.text}`,
  );
}

const PERSON =
  "0 @I1@ INDI\n" +
  "1 NAME Janez /Novak/\n" +
  "1 SEX M\n" +
  "1 BIRT\n" +
  "2 DATE 12 MAR 1880\n" +
  "2 PLAC Kranj\n" +
  "1 DEAT\n" +
  "2 DATE 1945\n" +
  "1 FAMS @F1@\n";

describe("diffRecord", () => {
  it("says nothing about a record that leaves as it came", () => {
    const diff = diffRecord(record(PERSON), record(PERSON));
    expect(diff.lines).toEqual([]);
    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(0);
  });

  it("shows a changed line under the tags that own it, not under its neighbours", () => {
    const after = record(PERSON.replace("2 DATE 12 MAR 1880", "2 DATE 12 MAR 1881"));
    expect(shown(record(PERSON), after)).toEqual([
      "  0 @I1@ INDI",
      "  1 NAME Janez /Novak/",
      "  1 BIRT",
      "- 2 DATE 12 MAR 1880",
      "+ 2 DATE 12 MAR 1881",
    ]);
  });

  it("keeps the name line however far from it the change is", () => {
    // The record's own line is an id: without the name, the lines say whose
    // date this is only if the reader trusts the card they are sitting in.
    const after = record(PERSON.replace("2 DATE 1945", "2 DATE 3 JUN 1945"));
    expect(shown(record(PERSON), after).slice(0, 2)).toEqual([
      "  0 @I1@ INDI",
      "  1 NAME Janez /Novak/",
    ]);
  });

  it("does not repeat a name that is itself the change", () => {
    const after = record(PERSON.replace("1 NAME Janez /Novak/", "1 NAME Janez /Novach/"));
    expect(shown(record(PERSON), after)).toEqual([
      "  0 @I1@ INDI",
      "- 1 NAME Janez /Novak/",
      "+ 1 NAME Janez /Novach/",
    ]);
  });

  it("does not mark a gap between the name and the first change", () => {
    // The record line and the name caption the block; the sex line they step
    // over is not a place the reader was reading from.
    const after = record(PERSON.replace("2 PLAC Kranj", "2 PLAC Kranj, Slovenija"));
    expect(shown(record(PERSON), after)).not.toContain("…");
  });

  it("counts what the file gains and loses", () => {
    const after = record(PERSON.replace("2 PLAC Kranj\n", "2 PLAC Kranj\n2 SOUR @S1@\n"));
    const diff = diffRecord(record(PERSON), after);
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(0);
    expect(diff.lines.filter((l) => l.kind === "add").map((l) => l.text)).toEqual(["2 SOUR @S1@"]);
  });

  it("heads each hunk with its own event, and gaps the untouched lines between", () => {
    const after = record(
      PERSON.replace("2 DATE 12 MAR 1880", "2 DATE 12 MAR 1881").replace("2 DATE 1945", "2 DATE 3 JUN 1945"),
    );
    // The birth place between the two changes is stepped over — and said to be,
    // since the reader is being moved out of one event and into another.
    expect(shown(record(PERSON), after)).toEqual([
      "  0 @I1@ INDI",
      "  1 NAME Janez /Novak/",
      "  1 BIRT",
      "- 2 DATE 12 MAR 1880",
      "+ 2 DATE 12 MAR 1881",
      "…",
      "  1 DEAT",
      "- 2 DATE 1945",
      "+ 2 DATE 3 JUN 1945",
    ]);
  });

  it("does not gap where nothing was stepped over", () => {
    const after = record(
      PERSON.replace("2 PLAC Kranj", "2 PLAC Kranj, Slovenija").replace("2 DATE 1945", "2 DATE 3 JUN 1945"),
    );
    expect(shown(record(PERSON), after)).toEqual([
      "  0 @I1@ INDI",
      "  1 NAME Janez /Novak/",
      "  1 BIRT",
      "- 2 PLAC Kranj",
      "+ 2 PLAC Kranj, Slovenija",
      "  1 DEAT",
      "- 2 DATE 1945",
      "+ 2 DATE 3 JUN 1945",
    ]);
  });

  it("shows a whole added block as additions, its own head included", () => {
    const after = record(PERSON.replace("1 FAMS @F1@\n", "1 BURI\n2 DATE 5 JUN 1945\n2 PLAC Kranj\n1 FAMS @F1@\n"));
    expect(shown(record(PERSON), after)).toEqual([
      "  0 @I1@ INDI",
      "  1 NAME Janez /Novak/",
      "+ 1 BURI",
      "+ 2 DATE 5 JUN 1945",
      "+ 2 PLAC Kranj",
    ]);
  });

  it("reads a new record as all additions and a dropped one as all removals", () => {
    const person = record(PERSON);
    const added = diffRecord(undefined, person);
    expect(added.lines.every((l) => l.kind === "add")).toBe(true);
    expect(added.added).toBe(9);
    expect(added.removed).toBe(0);

    const dropped = diffRecord(person, undefined);
    expect(dropped.lines.every((l) => l.kind === "del")).toBe(true);
    expect(dropped.removed).toBe(9);
  });

  it("keeps a moved line's own context when the same tag repeats", () => {
    const before = record("0 @I1@ INDI\n1 RESI\n2 DATE 1880\n1 RESI\n2 DATE 1890\n");
    const after = record("0 @I1@ INDI\n1 RESI\n2 DATE 1880\n1 RESI\n2 DATE 1891\n");
    expect(shown(before, after)).toEqual([
      "  0 @I1@ INDI",
      "  1 RESI",
      "- 2 DATE 1890",
      "+ 2 DATE 1891",
    ]);
  });

  it("re-emits a folded value on the lines it arrived on, so wrapping alone is not a change", () => {
    const long = `0 @I1@ INDI\n1 NOTE ${"a".repeat(200)}\n2 CONC ${"b".repeat(100)}\n`;
    expect(diffRecord(record(long), record(long), { maxLineLength: 253 }).lines).toEqual([]);
  });

  it("closes the block above before striking out the next tag", () => {
    // An event's place written as its line value, moved into a NOTE at the end
    // of each event: the BIRT's NOTE must not land under the struck-out DEAT.
    const before = record(
      "0 @I1@ INDI\n1 NAME Alojz /Homan/\n1 SEX M\n" +
      "1 BIRT Karlovec 19\n2 DATE 5 MAY 1905\n2 CHAN\n3 DATE 2 SEP 2025\n4 TIME 10:21:13\n" +
      "1 DEAT Karlovec 19\n2 DATE 30 NOV 1907\n2 CHAN\n3 DATE 2 SEP 2025\n4 TIME 10:21:23\n" +
      "1 FAMC @F1@\n",
    );
    const after = record(
      "0 @I1@ INDI\n1 NAME Alojz /Homan/\n1 SEX M\n" +
      "1 BIRT\n2 DATE 5 MAY 1905\n2 CHAN\n3 DATE 2 SEP 2025\n4 TIME 10:21:13\n2 NOTE Karlovec 19\n" +
      "1 DEAT\n2 DATE 30 NOV 1907\n2 CHAN\n3 DATE 2 SEP 2025\n4 TIME 10:21:23\n2 NOTE Karlovec 19\n" +
      "1 FAMC @F1@\n",
    );
    expect(shown(before, after)).toEqual([
      "  0 @I1@ INDI",
      "  1 NAME Alojz /Homan/",
      "- 1 BIRT Karlovec 19",
      "+ 1 BIRT",
      "+ 2 NOTE Karlovec 19",
      "- 1 DEAT Karlovec 19",
      "+ 1 DEAT",
      "+ 2 NOTE Karlovec 19",
    ]);
  });

  it("indexes a forest by xref", () => {
    const records = parseGedcom(
      new TextEncoder().encode("0 HEAD\n0 @I1@ INDI\n0 @F1@ FAM\n0 TRLR\n").buffer,
    ).records;
    expect([...recordsByXref(records).keys()]).toEqual(["@I1@", "@F1@"]);
  });
});
