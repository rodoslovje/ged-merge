import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import type { ChangeReport } from "../merge/merge";
import type { Individual } from "../gedcom/types";
import { recordLabeller } from "./recordLabel";

const ged = [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Frances //", "2 _MARNM Simonitsch", "1 SEX F",
  "0 @F1@ FAM", "1 WIFE @I1@",
  "0 TRLR", "",
].join("\n");
const ds = buildDataset(parseGedcom(new TextEncoder().encode(ged).buffer));

/** Stands in for the app's `useNameOf`: married surname in parentheses. */
const nameOf = (indi: Individual) =>
  [indi.names[0]?.given, indi.names[0]?.married && `(${indi.names[0].married})`].filter(Boolean).join(" ");

const report = (over: Partial<ChangeReport> = {}): ChangeReport => ({
  changes: [], deferred: [], graftJoins: [], recordsChanged: 0, newPersons: 0, newFamilies: 0,
  recordLabels: { "@I1@": "Frances", "@F1@": "Frances + —", "@S1@": "Krstna knjiga" },
  recordKinds: { "@I1@": "individual", "@F1@": "family", "@S1@": "record" },
  familySpouses: {}, customTags: {},
  ...over,
});

describe("recordLabeller", () => {
  it("names a person from their own record, not from the report's label", () => {
    expect(recordLabeller(report(), ds, nameOf)("@I1@")).toBe("Frances (Simonitsch)");
  });

  it("names a person the merge is adding, who is in no dataset yet", () => {
    const added = ds.individuals.get("@I1@")!;
    const r = report({ recordKinds: { "@I9@": "individual" }, newIndividuals: { "@I9@": added } });
    expect(recordLabeller(r, undefined, nameOf)("@I9@")).toBe("Frances (Simonitsch)");
  });

  it("leaves everything that is not a person to the report's own label", () => {
    const labelOf = recordLabeller(report(), ds, nameOf);
    expect(labelOf("@F1@")).toBe("Frances + —");
    expect(labelOf("@S1@")).toBe("Krstna knjiga");
  });

  it("falls back to the label, then to the id, for a record nothing holds", () => {
    // A record this save removes is gone from the dataset but still reported.
    const r = report({ recordKinds: { "@I7@": "individual" }, recordLabels: { "@I7@": "Zajo Olević" } });
    expect(recordLabeller(r, ds, nameOf)("@I7@")).toBe("Zajo Olević");
    expect(recordLabeller(report({ recordLabels: {} }), ds, nameOf)("@X1@")).toBe("@X1@");
  });
});
