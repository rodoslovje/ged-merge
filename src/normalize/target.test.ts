import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import type { Dataset } from "../gedcom/types";
import {
  MAX_REMEMBERED_TARGETS, detectDialect, proposeTarget, rememberTarget, sanitizeTargetFormats,
  targetFileKey, targetFormatOverrides, writeTarget,
} from "./target";

function load(text: string): Dataset {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer as ArrayBuffer));
}

const head = (vers: string, sour = "") =>
  `0 HEAD\n${sour ? `1 SOUR ${sour}\n` : ""}1 GEDC\n2 VERS ${vers}\n`;

describe("target format", () => {
  it("resolves the file mode to the file's own version, a strict mode to its own", () => {
    expect(writeTarget("file", { version: "7.0" })).toEqual({ mode: "file", version: "7.0", strict: false });
    expect(writeTarget("file", { version: "unknown" })).toEqual({ mode: "file", version: "5.5.1", strict: false });
    expect(writeTarget("7.0", { version: "5.5.1" })).toEqual({ mode: "7.0", version: "7.0", strict: true });
  });

  it("remembers a file by its base name, through the name a save gives it", () => {
    expect(targetFileKey("Rodovnik.ged")).toBe("rodovnik");
    expect(targetFileKey("Rodovnik.gedmerge.ged")).toBe("rodovnik");
    expect(targetFileKey("Rodovnik.gedmerge.gedmerge.GED")).toBe("rodovnik");
  });

  it("keeps the newest choices and moves a re-chosen file to the end", () => {
    let map = {};
    for (let i = 0; i < MAX_REMEMBERED_TARGETS + 5; i++) map = rememberTarget(map, `f${i}`, "7.0");
    expect(Object.keys(map)).toHaveLength(MAX_REMEMBERED_TARGETS);
    expect(map).not.toHaveProperty("f0");
    map = rememberTarget(map, "f10", "file");
    expect(Object.keys(map).at(-1)).toBe("f10");
  });

  it("drops stored entries that are not a mode", () => {
    expect(sanitizeTargetFormats({ a: "7.0", b: "6.0", c: "file", "": "7.0" })).toEqual({ a: "7.0", c: "file" });
    expect(sanitizeTargetFormats("nope")).toEqual({});
  });

  it("finds bare vendor tags and names the program that wrote them", () => {
    const ds = load(`${head("5.5.1", "MacFamilyTree")}0 @I1@ INDI\n1 NOBI\n2 DATE 1900\n1 _MILT\n0 TRLR\n`);
    expect(detectDialect(ds)).toEqual({ software: "MacFamilyTree", bareTags: ["NOBI"] });
    expect(detectDialect(load(`${head("7.0")}0 @I1@ INDI\n1 _MILT\n0 TRLR\n`))).toBeUndefined();
  });

  it("counts event stamps as MacFamilyTree's habit, by its header or its bare tags", () => {
    const stamped = "0 @I1@ INDI\n1 BIRT\n2 DATE 1900\n2 CHAN\n3 DATE 2 SEP 2025\n";
    const byHeader = detectDialect(load(`${head("7.0", "SYNIUMFAMILYTREE")}${stamped}0 TRLR\n`));
    expect(byHeader).toEqual({ software: "MacFamilyTree", bareTags: [], nestedStamps: true });
    expect(proposeTarget({ version: "7.0" }, byHeader, undefined)).toEqual({ mode: "file", software: "MacFamilyTree" });
    // Re-saved by GED Merge: the header no longer says, its NOBI still does.
    const resaved = detectDialect(load(`${head("7.0", "GEDMERGE")}${stamped}1 NOBI\n0 TRLR\n`));
    expect(resaved).toEqual({ software: "MacFamilyTree", bareTags: ["NOBI"], nestedStamps: true });
    // Nobody's habit: the stamps are an error, not a variation.
    expect(detectDialect(load(`${head("7.0", "GEDMERGE")}${stamped}0 TRLR\n`))).toBeUndefined();
  });

  it("proposes the file's own format only when the file has another program's habits", () => {
    const plain = load(`${head("7.0")}0 @I1@ INDI\n1 BIRT\n2 DATE 5 JUN 1880\n0 TRLR\n`);
    expect(proposeTarget(plain, undefined, { date: "D MMM YYYY" })).toEqual({ mode: "7.0" });
    expect(proposeTarget(plain, undefined, { date: "DD.MM.YYYY" })).toEqual({ mode: "file" });
    expect(proposeTarget(plain, undefined, { privacy: "PRIV" })).toEqual({ mode: "file" });
    expect(proposeTarget(plain, undefined, { sourceCoverage: "vendor" })).toEqual({ mode: "file" });
    expect(proposeTarget(plain, { software: "MacFamilyTree", bareTags: ["NOBI"] }, {}))
      .toEqual({ mode: "file", software: "MacFamilyTree" });
    expect(proposeTarget(load(`${head("5.5")}0 TRLR\n`), undefined, {})).toEqual({ mode: "5.5.1" });
  });

  it("puts the standard's forms over the reader's choices in a strict mode only", () => {
    const chosen = { date: "DD.MM.YYYY", datePlaceholder: "_", privacy: "PRIV", names: "tags", place: "packed-plac" } as const;
    expect(targetFormatOverrides(chosen, { strict: false, version: "7.0" })).toEqual({ ...chosen, writeVersion: "7.0" });
    expect(targetFormatOverrides(chosen, { strict: true, version: "7.0" })).toEqual({
      standard: "7.0",
      writeVersion: "7.0",
      date: "D MMM YYYY",
      datePlaceholder: "none",
      privacy: "RESN",
      names: "records",
      sourceCoverage: "standard",
      doubledLinks: "fold",
      // A choice the standard leaves open stays the reader's.
      place: "packed-plac",
    });
    expect(targetFormatOverrides({ date: "DD MMM YYYY" }, { strict: true, version: "5.5.1" }).date).toBe("DD MMM YYYY");
  });
});
