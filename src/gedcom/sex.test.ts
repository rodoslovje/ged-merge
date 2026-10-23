import { describe, expect, it } from "vitest";
import { buildDataset } from "./builder";
import { parseGedcom } from "./parser";
import { serializeDataset } from "./serialize";
import { firstChild } from "./node";
import { setSex } from "./edit";
import { isBinarySex, readSex } from "./sex";
import { isSameSexCouple } from "./couple";
import { migrateVersion } from "../normalize/migrate";
import { sexConflicts } from "../match/scoreIndividual";

function load(version: string, body: string) {
  const text = `0 HEAD\n1 GEDC\n2 VERS ${version}\n${body}0 TRLR\n`;
  return { text, ds: buildDataset(parseGedcom(new TextEncoder().encode(text).buffer)) };
}

describe("SEX X", () => {
  it("reads X as its own value in a 7.0 file", () => {
    const { ds } = load("7.0", "0 @I1@ INDI\n1 SEX X\n");
    expect(ds.individuals.get("@I1@")!.sex).toBe("X");
  });

  it("reads the 5.5.1 stand-in (SEX U + _SEX X) as X, and a bare U as unknown", () => {
    const { ds } = load("5.5.1", "0 @I1@ INDI\n1 SEX U\n2 _SEX X\n0 @I2@ INDI\n1 SEX U\n");
    expect(ds.individuals.get("@I1@")!.sex).toBe("X");
    expect(ds.individuals.get("@I2@")!.sex).toBe("U");
  });

  it("saves an untouched file byte for byte", () => {
    for (const [v, body] of [["7.0", "0 @I1@ INDI\n1 SEX X\n"], ["5.5.1", "0 @I1@ INDI\n1 SEX U\n2 _SEX X\n"]] as const) {
      const { text, ds } = load(v, body);
      expect(serializeDataset(ds).replace(/\r\n/g, "\n")).toBe(text);
    }
  });

  it("writes X as the letter in 7.0 and as the stand-in in 5.5.1", () => {
    const { ds: ds7 } = load("7.0", "0 @I1@ INDI\n1 SEX M\n");
    const p7 = ds7.individuals.get("@I1@")!;
    setSex(p7, "X", "7.0");
    expect(firstChild(p7.raw, "SEX")!.value).toBe("X");
    expect(firstChild(p7.raw, "SEX")!.children).toEqual([]);

    const { ds: ds5 } = load("5.5.1", "0 @I1@ INDI\n1 SEX M\n");
    const p5 = ds5.individuals.get("@I1@")!;
    setSex(p5, "X", "5.5.1");
    const sex = firstChild(p5.raw, "SEX")!;
    expect(sex.value).toBe("U");
    expect(readSex(sex)).toBe("X");
    // Back to female: the stand-in goes with it.
    setSex(p5, "F", "5.5.1");
    expect(firstChild(p5.raw, "SEX")!.value).toBe("F");
    expect(firstChild(p5.raw, "SEX")!.children).toEqual([]);
  });

  it("round-trips through the 5.5.1 ⇄ 7.0 migration", () => {
    const { ds } = load("7.0", "0 @I1@ INDI\n1 SEX X\n");
    migrateVersion(ds.records, "7.0", "5.5.1", () => {});
    const down = firstChild(ds.records.find((r) => r.xref === "@I1@")!, "SEX")!;
    expect(down.value).toBe("U");
    expect(readSex(down)).toBe("X");
    migrateVersion(ds.records, "5.5.1", "7.0", () => {});
    const up = firstChild(ds.records.find((r) => r.xref === "@I1@")!, "SEX")!;
    expect(up.value).toBe("X");
    expect(up.children).toEqual([]);
  });

  it("never conflicts in matching or makes a same-sex couple", () => {
    const { ds } = load("7.0", "0 @I1@ INDI\n1 SEX X\n0 @I2@ INDI\n1 SEX M\n0 @I3@ INDI\n1 SEX X\n");
    const [x, m, x2] = ["@I1@", "@I2@", "@I3@"].map((id) => ds.individuals.get(id)!);
    expect(sexConflicts(x, m)).toBe(false);
    expect(isSameSexCouple(x, x2)).toBe(false);
    expect(isBinarySex("X")).toBe(false);
    expect(isBinarySex("F")).toBe(true);
  });
});
