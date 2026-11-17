import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { firstChild } from "../gedcom/node";
import { individualFieldRows } from "../review/fields";
import type { FieldChoice } from "../review/types";
import { validateConformance } from "../tools/conformance/conformance";
import { copyHitRows, hitSourceFields } from "./copyFromHit";
import { hitsForComparison, indexPersonUrl, rankHits, type IndexHit } from "./indexSearch";

const tr = (key: string) => key;
const parse = (text: string) => buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));

const main = (version: "5.5.1" | "7.0") => `0 HEAD
1 GEDC
2 VERS ${version}
${version === "5.5.1" ? "2 FORM LINEAGE-LINKED\n1 CHAR UTF-8\n" : ""}1 SOUR test
0 @I1@ INDI
1 NAME Janez /Penko/
1 SEX M
1 BIRT
2 DATE 4 MAY 1862
2 PLAC Petelinje
0 @S1@ SOUR
1 TITL Janez Penko - Bandelj - Slovenski rodoslovni indeks
0 TRLR
`;

const PENKO: IndexHit = {
  id: 1,
  ext_id: "@I19364@",
  contributor: "Bandelj",
  name: "Janez",
  surname: "Penko",
  sex: "m",
  date_of_birth: "4 MAY 1862",
  place_of_birth: "Petelinje",
  date_of_death: "5 APR 1927",
  place_of_death: "Petelinje",
};

/** The comparison's rows for the hit, and the person and hit they compare. */
function compared(text: string) {
  const ds = parse(text);
  const person = ds.individuals.get("@I1@")!;
  const ranked = rankHits(person, ds, [PENKO]);
  const hits = hitsForComparison(ranked.ds, ds);
  const hit = hits.individuals.get(ranked.ranked[0].id)!;
  return { ds, person, hits, hit, rows: individualFieldRows(tr, person, hit, ds, hits) };
}

describe("copyHitRows", () => {
  it("adds the ticked death and cites the hit on it alone", () => {
    const { ds, person, hits, hit, rows } = compared(main("5.5.1"));
    const fields: Record<string, FieldChoice> = {};
    for (const r of rows) if (r.key.startsWith("DEAT.") && r.state === "incoming-only") fields[r.key] = "incoming";
    expect(Object.keys(fields).length).toBeGreaterThan(0);

    copyHitRows(ds, person, hit, hits, fields, tr, { sourceXref: "@S1@", quay: "1" });
    const deat = firstChild(person.raw, "DEAT")!;
    expect(firstChild(deat, "DATE")?.value).toBe("5 APR 1927");
    expect(firstChild(deat, "SOUR")?.value).toBe("@S1@");
    expect(firstChild(firstChild(deat, "SOUR")!, "QUAY")?.value).toBe("1");
    // The birth agreed and was not touched: no citation added to it.
    expect(firstChild(firstChild(person.raw, "BIRT")!, "SOUR")).toBeUndefined();
  });

  it("changes nothing and cites nothing when no row is ticked", () => {
    const { ds, person, hits, hit } = compared(main("5.5.1"));
    const before = JSON.stringify(person.raw);
    copyHitRows(ds, person, hit, hits, {}, tr, { sourceXref: "@S1@" });
    expect(JSON.stringify(person.raw)).toBe(before);
  });

  for (const version of ["5.5.1", "7.0"] as const) {
    it(`writes valid ${version} lines`, () => {
      const { ds, person, hits, hit, rows } = compared(main(version));
      const fields: Record<string, FieldChoice> = {};
      for (const r of rows) if ((r.state === "incoming-only" || r.state === "conflict") && !r.isGroupHeader) fields[r.key] = "incoming";
      copyHitRows(ds, person, hit, hits, fields, tr, { sourceXref: "@S1@", quay: "1" });
      expect(validateConformance(ds)).toEqual([]);
    });
  }
});

describe("hitSourceFields", () => {
  it("proposes the index's own source for a hit, the society as agency", () => {
    const f = hitSourceFields(indexPersonUrl(PENKO));
    expect(f.site).toBe("indeks");
    expect(f.title).toBe("Janez Penko - Bandelj - Slovenski rodoslovni indeks");
    expect(f.author).toBe("Bandelj");
    expect(f.agency).toBe("Slovensko rodoslovno društvo");
  });
});
