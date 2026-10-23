import { describe, expect, it } from "vitest";
import { REGISTRY_ENTRIES, registryEntry } from "./extensionRegistry";

const uri = (tag: string, ancestors: string[]) => registryEntry(tag, ancestors)?.uri;

describe("registryEntry — FamilySearch GEDCOM registry extension tags", () => {
  it("gives a registered tag its registry URI where the registration places it", () => {
    expect(uri("_DATE", ["SOUR", "REPO"])).toBe("https://github.com/dthaler/gedcom-citations/_DATE");
    expect(uri("_SOUR", ["INDI", "BIRT", "SOUR", "PAGE"])).toBe("https://github.com/dthaler/gedcom-citations/_SOUR");
    expect(uri("_SOUR", ["SOUR"])).toBe("https://github.com/dthaler/gedcom-citations/_SOUR");
    expect(uri("_AGER", ["INDI", "DEAT", "AGE"])).toBe("https://armidalesoftware.com/issue/tags/AGER.htm");
    expect(uri("_CENR", ["INDI", "CENS"])).toBe("https://armidalesoftware.com/issue/tags/CENR.htm");
    expect(uri("_CENR", [])).toBe("https://armidalesoftware.com/issue/tags/record-CENR.htm");
    expect(uri("_SCHD", ["_CENR"])).toBe("https://armidalesoftware.com/issue/tags/SCHD.htm");
    expect(uri("_MSTAT", ["_CENR", "INDI"])).toBe("https://armidalesoftware.com/issue/tags/MSTAT.htm");
  });

  it("gives a same-named tag elsewhere no registry URI", () => {
    // MyHeritage's and Ancestry's media date, under OBJE — not the citation draft's _DATE.
    expect(uri("_DATE", ["INDI", "OBJE"])).toBeUndefined();
    // A repository record is not a repository citation.
    expect(uri("_DATE", ["REPO"])).toBeUndefined();
    // MacFamilyTree's citation source type sits under _QUAL, not PAGE.
    expect(uri("_SOUR", ["INDI", "SOUR", "_QUAL"])).toBeUndefined();
    // A citation's SOUR is no source record.
    expect(uri("_SOUR", ["INDI", "SOUR"])).toBeUndefined();
    // Brother's Keeper's partnership status, under a family.
    expect(uri("_MSTAT", ["FAM"])).toBeUndefined();
    expect(uri("_MSTAT", ["INDI"])).toBeUndefined();
    expect(uri("_CENR", ["FAM", "CENS"])).toBeUndefined();
    expect(uri("_UID", ["INDI"])).toBeUndefined();
  });

  it("reads tags case-insensitively and lists only extension tags", () => {
    expect(uri("_date", ["SOUR", "REPO"])).toBe("https://github.com/dthaler/gedcom-citations/_DATE");
    for (const entry of REGISTRY_ENTRIES) {
      expect(entry.tag).toMatch(/^_[A-Z0-9_]+$/);
      expect(entry.uri).toMatch(/^https:\/\//);
    }
  });
});
