import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import type { WorkerResponse } from "../worker/messages";
import { loadedFileFromParsed } from "./loadedFile";

type ParsedMessage = Extract<WorkerResponse, { type: "parsed" }>;

const dataset = buildDataset(
  parseGedcom(
    new TextEncoder().encode("0 HEAD\n1 GEDC\n2 VERS 5.5.1\n0 @I1@ INDI\n1 NAME A /B/\n0 TRLR\n").buffer,
  ),
);

const parsed = (over: Partial<ParsedMessage> = {}): ParsedMessage => ({
  type: "parsed",
  role: "main",
  fileName: "rodovnik.ged",
  dataset,
  ...over,
});

describe("loadedFileFromParsed", () => {
  it("always carries the file name and dataset", () => {
    const file = loadedFileFromParsed(parsed());
    expect(file.fileName).toBe("rodovnik.ged");
    expect(file.dataset).toBe(dataset);
  });

  it("carries every detection the message reported", () => {
    const file = loadedFileFromParsed(
      parsed({
        placeLayout: "structured-addr",
        dateFormat: "DD.MM.YYYY",
        datePlaceholder: "_",
        sourceLayout: "repository",
        pageMediaStyle: "source",
        nameLayout: "tags",
        unknownNameStyle: "NN",
        marriedNameTag: true,
        coordUsage: { withCoord: 3, total: 10 },
      }),
    );

    expect(file).toMatchObject({
      placeLayout: "structured-addr",
      dateFormat: "DD.MM.YYYY",
      datePlaceholder: "_",
      sourceLayout: "repository",
      pageMediaStyle: "source",
      nameLayout: "tags",
      unknownNameStyle: "NN",
      marriedNameTag: true,
      coordUsage: { withCoord: 3, total: 10 },
    });
  });

  it("omits absent detections entirely, rather than setting them undefined", () => {
    // The UI tests these for presence; an explicit undefined key would make
    // `"dateFormat" in file` true and read as "detected nothing".
    const file = loadedFileFromParsed(parsed());

    expect("dateFormat" in file).toBe(false);
    expect("placeLayout" in file).toBe(false);
    expect("coordUsage" in file).toBe(false);
    expect(Object.keys(file).sort()).toEqual(["dataset", "fileName"]);
  });

  it("omits a falsy detection, which the worker uses for 'none'", () => {
    const file = loadedFileFromParsed(parsed({ marriedNameTag: false, unknownNameStyle: "" }));
    expect("marriedNameTag" in file).toBe(false);
    expect("unknownNameStyle" in file).toBe(false);
  });

  it("keeps a zero-coordinate usage report, which is meaningful", () => {
    const file = loadedFileFromParsed(parsed({ coordUsage: { withCoord: 0, total: 42 } }));
    expect(file.coordUsage).toEqual({ withCoord: 0, total: 42 });
  });

  it("builds a fresh object each time, sharing no state between slots", () => {
    const a = loadedFileFromParsed(parsed({ dateFormat: "DD.MM.YYYY" }));
    const b = loadedFileFromParsed(parsed({ role: "compare" }));
    expect(a).not.toBe(b);
    expect("dateFormat" in b).toBe(false);
  });
});
