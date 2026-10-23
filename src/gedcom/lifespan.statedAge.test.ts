import { describe, expect, it } from "vitest";
import { birthFromStatedAges, estimateBirthYearFromNetwork } from "./lifespan";
import { buildDataset } from "./builder";
import { parseGedcom } from "./parser";
import { applyBatchAction, previewBirthEstimateDates } from "../tools/batch";
import { serializeGedcom } from "./serialize";

const dataset = (body: string) =>
  buildDataset(parseGedcom(new TextEncoder().encode(`0 HEAD\n1 GEDC\n2 VERS 5.5.1\n${body}0 TRLR\n`).buffer));

describe("birthFromStatedAges", () => {
  it("places a birth from the age at a dated death", () => {
    const ds = dataset("0 @I1@ INDI\n1 NAME A /B/\n1 DEAT\n2 DATE 3 MAR 1890\n2 AGE 62y\n");
    const b = birthFromStatedAges(ds.individuals.get("@I1@")!, ds)!;
    expect(b.from).toBeGreaterThan(1827.1);
    expect(b.to).toBeLessThan(1828.3);
    expect(b.year).toBe(1827);
  });

  it("intersects several ages, a spouse's age at a marriage among them", () => {
    const ds = dataset(
      "0 @I1@ INDI\n1 NAME A /B/\n1 SEX M\n1 FAMS @F1@\n1 DEAT\n2 DATE 1890\n2 AGE 62y\n" +
        "0 @F1@ FAM\n1 HUSB @I1@\n1 MARR\n2 DATE 1855\n2 HUSB\n3 AGE 27y\n",
    );
    // Death: born 1827–1829; marriage: born 1827–1829 — both say 1827–1828.
    const b = birthFromStatedAges(ds.individuals.get("@I1@")!, ds)!;
    expect(b.from).toBe(1827);
    expect(b.to).toBe(1829);
    expect(b.year).toBe(1828);
  });

  it("keeps the narrowest range when the records contradict each other", () => {
    const ds = dataset(
      "0 @I1@ INDI\n1 NAME A /B/\n1 DEAT\n2 DATE 15 JUN 1890\n2 AGE 62y\n1 CENS\n2 DATE 1850\n2 AGE 40y\n",
    );
    expect(birthFromStatedAges(ds.individuals.get("@I1@")!, ds)!.year).toBe(1827);
  });

  it("ignores ages at undated or bounded-date events, and an unreadable age", () => {
    const ds = dataset(
      "0 @I1@ INDI\n1 NAME A /B/\n1 DEAT\n2 AGE 62y\n1 CENS\n2 DATE BEF 1850\n2 AGE 40y\n1 RESI\n2 DATE 1860\n2 AGE about forty\n",
    );
    expect(birthFromStatedAges(ds.individuals.get("@I1@")!, ds)).toBeUndefined();
  });

  it("is what the network estimate gives first", () => {
    const ds = dataset("0 @I1@ INDI\n1 NAME A /B/\n1 BURI\n2 DATE 1700\n2 AGE INFANT\n");
    expect(estimateBirthYearFromNetwork(ds.individuals.get("@I1@")!, ds)).toBe(1700);
  });
});

describe("the estimate-birth batch prefers a stated age", () => {
  const body =
    "0 @I1@ INDI\n1 NAME Father /B/\n1 BIRT\n2 DATE 1790\n1 FAMS @F1@\n" +
    "0 @I2@ INDI\n1 NAME Child /B/\n1 FAMC @F1@\n1 DEAT\n2 DATE 1880\n2 AGE 72y\n" +
    "0 @I3@ INDI\n1 NAME Other /B/\n1 FAMC @F1@\n" +
    "0 @F1@ FAM\n1 HUSB @I1@\n1 CHIL @I2@\n1 CHIL @I3@\n";

  it("calculates from the age rather than the father's generation, and says so with CAL", () => {
    const ds = dataset(body);
    const dates = previewBirthEstimateDates(ds, ["@I2@", "@I3@"]);
    expect(dates.get("@I2@")).toBe("CAL 1808");
    expect(dates.get("@I3@")).toMatch(/^ABT \d{4}$/);
    applyBatchAction(ds, ["@I2@"], { kind: "estimateBirth" });
    expect(serializeGedcom(ds.records)).toContain("1 BIRT\n2 DATE CAL 1808\n");
  });
});
