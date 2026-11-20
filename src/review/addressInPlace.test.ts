import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { fieldDiffCounts, individualFieldRows } from "./fields";
import { pendingFieldChoices } from "./types";

const dataset = (text: string) => buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;
const tr = (key: string) => key;

function rowsFor(mainBirth: string, incomingBirth: string) {
  const main = dataset(wrap(`0 @I1@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 1850\n${mainBirth}`));
  const compare = dataset(wrap(`0 @P1@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 1850\n${incomingBirth}`));
  return individualFieldRows(tr, main.individuals.get("@I1@")!, compare.individuals.get("@P1@")!, main, compare);
}

describe("an incoming address written inside the place", () => {
  // The incoming event has no ADDR line: the address row is read out of its
  // PLAC, and the merge has no line to copy for it.
  const rows = rowsFor("", "2 PLAC Kranj, Glavni trg 5\n");
  const addr = rows.find((r) => r.key === "BIRT.addr");

  it("is shown for comparison, marked as part of the place", () => {
    expect(addr).toMatchObject({ incoming: "Glavni trg 5", inPlace: true });
  });

  it("is not counted as new, and is no choice a confirmed decision will write", () => {
    // The place itself is the one new value.
    expect(fieldDiffCounts(rows).newCount).toBe(fieldDiffCounts(rows.filter((r) => r !== addr)).newCount);
    const pending = pendingFieldChoices(rows, { status: "confirmed", fields: {} });
    expect(pending.has("BIRT.addr")).toBe(false);
    expect(pending.get("BIRT.place")).toBe("incoming");
  });

  it("leaves a real incoming ADDR line a choice like any other", () => {
    const real = rowsFor("", "2 PLAC Kranj\n2 ADDR Glavni trg 5\n").find((r) => r.key === "BIRT.addr");
    expect(real).toMatchObject({ incoming: "Glavni trg 5" });
    expect(real?.inPlace).toBeUndefined();
  });
});
