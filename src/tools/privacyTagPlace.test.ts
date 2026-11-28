import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { privacyPlaceTest } from "../gedcom/private";
import { serializeGedcom } from "../gedcom/serialize";
import { applyRecordPatches } from "../ui/historyTypes";
import { fixConformance } from "./fixConformance";
import { recordsWithTag } from "./recordRewrite";
import { validateStructure } from "./structure";

/**
 * `_PRIV` says what the standard's `RESN` says — but only on a line the
 * version lets carry `RESN`: a person, a family, their events. On a note
 * there is nothing standard to write, so the health check counts the two
 * kinds of place apart, and each row opens and removes its own lines only.
 */
function dataset(vers: "5.5.1" | "7.0") {
  const head = vers === "7.0"
    ? "0 HEAD\n1 GEDC\n2 VERS 7.0\n"
    : "0 HEAD\n1 SOUR TEST\n1 SUBM @U1@\n1 GEDC\n2 VERS 5.5.1\n2 FORM LINEAGE-LINKED\n1 CHAR UTF-8\n0 @U1@ SUBM\n1 NAME Test\n";
  return buildDataset(parseGedcom(new TextEncoder().encode(`${head}0 @I1@ INDI
1 NAME Ana /Novak/
1 _PRIV Y
1 BIRT
2 DATE 1 JAN 1900
2 _PRIV Y
1 NOTE A private remark
2 _PRIV Y
0 @I2@ INDI
1 NAME Jan /Kos/
1 NOTE First
2 _PRIV Y
1 NOTE Second
2 _PRIV Y
0 TRLR`).buffer));
}

describe("a privacy extension counted by where it stands", () => {
  for (const vers of ["5.5.1", "7.0"] as const) {
    it(`${vers}: one finding where the version has RESN, another where it has nothing`, () => {
      const ds = dataset(vers);
      const found = validateStructure(ds).issues.filter((i) => i.category === "customTag" && i.sample === "_PRIV");
      const standard = found.find((i) => i.tagPlace === "standard")!;
      const extension = found.find((i) => i.tagPlace === "extension")!;
      expect(found).toHaveLength(2);
      // On the person and the birth: RESN says the same.
      expect(standard).toMatchObject({
        severity: "warning",
        messageKey: "tools.validate.struct.issue.customTagStandard",
        recordId: "@I1@",
      });
      expect(standard.messageVars).toMatchObject({ count: 2, form: vers === "7.0" ? "RESN PRIVACY" : "RESN privacy" });
      // On a note: an extension the version has nothing for — an inventory line.
      expect(extension).toMatchObject({ severity: "info", messageKey: "tools.validate.struct.issue.customTagKnown" });
      expect(extension.messageVars).toMatchObject({ count: 3 });
      expect(extension.messageVars?.form).toBeUndefined();

      // Each row opens its own records.
      const under = (place: "standard" | "extension") => privacyPlaceTest(place, vers);
      expect(recordsWithTag(ds.records, "_PRIV", undefined, under("standard"))).toEqual([{ id: "@I1@", count: 2 }]);
      expect(recordsWithTag(ds.records, "_PRIV", undefined, under("extension"))).toEqual([
        { id: "@I1@", count: 1 },
        { id: "@I2@", count: 2 },
      ]);
    });

    it(`${vers}: removing the tag from one row leaves the other row's lines`, () => {
      const ds = dataset(vers);
      const before = serializeGedcom(ds.records);
      const patches = fixConformance(ds, "customTags", { value: "_PRIV", place: "extension" });
      expect(patches.map((p) => p.id)).toEqual(["@I1@", "@I2@"]);
      const left = validateStructure(ds).issues.filter((i) => i.category === "customTag" && i.sample === "_PRIV");
      expect(left.map((i) => [i.tagPlace, i.messageVars?.count])).toEqual([["standard", 2]]);
      applyRecordPatches(ds, patches, "undo");
      expect(serializeGedcom(ds.records)).toBe(before);

      // Without a place, as for any other extension: every line goes.
      fixConformance(ds, "customTags", { value: "_PRIV" });
      expect(recordsWithTag(ds.records, "_PRIV")).toEqual([]);
    });
  }

  it("an extension whose standard form holds everywhere is one finding, as before", () => {
    const ds = buildDataset(parseGedcom(new TextEncoder().encode(`0 HEAD
1 GEDC
2 VERS 7.0
0 @I1@ INDI
1 _UID 1234
1 NOTE x
2 _UID 5678
0 TRLR`).buffer));
    const found = validateStructure(ds).issues.filter((i) => i.category === "customTag" && i.sample === "_UID");
    expect(found.map((i) => [i.tagPlace, i.messageVars?.count])).toEqual([[undefined, 2]]);
  });
});
