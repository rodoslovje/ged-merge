import { describe, expect, it } from "vitest";
import { buildDataset } from "./builder";
import { addIndividual } from "./edit";
import { newFileBase, newGedcomText } from "./newFile";
import { parseGedcom } from "./parser";
import { serializeGedcom } from "./serialize";
import type { Dataset } from "./types";

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

/** The browser cannot read the account name its user is logged in under, so a
 *  file created from nothing takes its name from the family inside it. */
describe("newFileBase", () => {
  const load = (lines: string[]): Dataset =>
    buildDataset(parseGedcom(new TextEncoder().encode([
      "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8", ...lines, "0 TRLR", "",
    ].join("\n")).buffer as ArrayBuffer));

  it("takes the first person's surname", () => {
    expect(newFileBase(load(["0 @I1@ INDI", "1 NAME Janez /Novak/"]))).toBe("Novak");
  });

  it("prefers the home person over the first in the file", () => {
    const ds = load([
      "0 @I1@ INDI", "1 NAME Janez /Novak/",
      "0 @I2@ INDI", "1 NAME Ana /Stare/",
    ]);
    expect(newFileBase(ds, "@I2@")).toBe("Stare");
    // An id no longer in the file falls back rather than yielding nothing.
    expect(newFileBase(ds, "@I9@")).toBe("Novak");
  });

  it("declines an empty file, a given name only, and a placeholder surname", () => {
    expect(newFileBase(load([]))).toBeNull();
    expect(newFileBase(load(["0 @I1@ INDI", "1 NAME Janez"]))).toBeNull();
    expect(newFileBase(load(["0 @I1@ INDI", "1 NAME Janez /?/"]))).toBeNull();
    expect(newFileBase(load(["0 @I1@ INDI", "1 NAME Janez /Neznano/"]))).toBeNull();
  });

  it("makes the surname safe to write to disk", () => {
    // Separators would break the `{base}.{date}.gedmerge.ged` convention, and
    // a slash would read as a path.
    expect(newFileBase(load(["0 @I1@ INDI", "1 NAME A /St. Clair/"]))).toBe("St-Clair");
    expect(newFileBase(load(["0 @I1@ INDI", "1 NAME A /van der Berg/"]))).toBe("van-der-Berg");
    // Nothing is left dangling at either end.
    expect(newFileBase(load(["0 @I1@ INDI", "1 NAME A /Novak\\/"]))).toBe("Novak");
    // Letters outside ASCII are ordinary in a surname and stay as written.
    expect(newFileBase(load(["0 @I1@ INDI", "1 NAME A /Šuštaršič/"]))).toBe("Šuštaršič");
  });
});
