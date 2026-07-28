import { describe, expect, it } from "vitest";
import { buildDataset } from "./builder";
import { addIndividual } from "./edit";
import { newGedcomText } from "./newFile";
import { parseGedcom } from "./parser";
import { serializeGedcom } from "./serialize";

/**
 * The empty-file skeleton is fed straight into the ordinary load path, so the
 * contract that matters is: it parses, it yields a usable (if empty) dataset,
 * and the first person added to it lands in a file that round-trips.
 */
describe("newGedcomText", () => {
  const toBuffer = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;
  const dataset = () => buildDataset(parseGedcom(toBuffer(newGedcomText(new Date(2026, 6, 27)))));

  it("parses into an empty but usable dataset", () => {
    const ds = dataset();
    expect(ds.individuals.size).toBe(0);
    expect(ds.families.size).toBe(0);
    expect(ds.records.some((r) => r.tag === "HEAD")).toBe(true);
  });

  it("declares 5.5.1 / UTF-8 so other programs read it", () => {
    const text = newGedcomText(new Date(2026, 6, 27));
    expect(text).toContain("2 VERS 5.5.1");
    expect(text).toContain("1 CHAR UTF-8");
    expect(text).toContain("1 DATE 27 JUL 2026");
    expect(text.trimEnd().endsWith("0 TRLR")).toBe(true);
  });

  it("takes a first person, who survives a save round-trip", () => {
    const ds = dataset();
    const added = addIndividual(ds, "U");
    expect(added.id).toBe("@I1@");

    const reloaded = buildDataset(parseGedcom(toBuffer(serializeGedcom(ds.records))));
    expect([...reloaded.individuals.keys()]).toEqual(["@I1@"]);
  });
});
