import { describe, expect, it } from "vitest";
import { FS_EXID_TYPE } from "./exid";
import {
  GEDMERGE_TAGS, ownTag, producerSlug, SEEN_IN, STANDARD_FORMS, TERMS_ORIGIN, TERMS_VENDORS, termsEntries, termsUri,
} from "./extensionTerms";
import { namedVendorTags, vendorTagInfo } from "./vendorTags";
import { parseGedcom } from "./parser";
import { serializeGedcom } from "./serialize";
import { migrateVersion } from "../normalize/migrate";

const page = (vendor: string, tag: string) => `${TERMS_ORIGIN}/terms/${vendor}/${tag}`;

describe("termsEntries — one documented page per tag and program", () => {
  it("documents every tag the vendor-tag registry names, under each program it names", () => {
    const entries = termsEntries();
    const has = (vendor: string, tag: string) => entries.some((e) => e.vendor === vendor && e.tag === tag);
    for (const tag of namedVendorTags()) {
      expect(entries.some((e) => e.tag === tag), tag).toBe(true);
    }
    expect(has("myheritage", "_UPD")).toBe(true);
    expect(has("brotherskeeper", "_MILT")).toBe(true);
    expect(has("ftm", "_MILT")).toBe(true);
    expect(has("macfamilytree", "_FID")).toBe(true);
    expect(has("familysearch", "_FID")).toBe(true);
    expect(has("common", "_MARNM")).toBe(true);
    expect(has("rootsmagic", "_MARNM")).toBe(true);
    expect(has("ftm", "_FA7")).toBe(true);
    expect(has("gedmerge", "_SUBN")).toBe(true);
    // No program the registry does not name gets a page for a program's tag.
    expect(has("myheritage", "_MILT")).toBe(false);
  });

  it("lists each program and tag once", () => {
    const keys = termsEntries().map((e) => `${e.vendor}/${e.tag}`);
    expect(new Set(keys).size).toBe(keys.length);
    const slugs = TERMS_VENDORS.map((v) => v.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const e of termsEntries()) expect(slugs).toContain(e.vendor);
  });

  it("says where each tag appears and what its standard form is", () => {
    const upd = termsEntries().find((e) => e.vendor === "myheritage" && e.tag === "_UPD")!;
    expect(upd.seenIn).toEqual(["INDI", "FAM", "SOUR"]);
    const marnm = termsEntries().find((e) => e.vendor === "common" && e.tag === "_MARNM")!;
    expect(marnm.standard).toEqual({ form: "a NAME of its own with TYPE MARRIED", converted: true });
    const subn = termsEntries().find((e) => e.vendor === "gedmerge" && e.tag === "_SUBN")!;
    expect(subn.context).toMatch(/level 0/);
    expect(subn.meaning.sl).toBeTruthy();
    expect(STANDARD_FORMS._FID.form).toBe(`EXID with TYPE ${FS_EXID_TYPE}`);
  });

  it("keeps the sightings for tags the registry knows only", () => {
    const known = new Set(namedVendorTags());
    expect(Object.keys(SEEN_IN).filter((tag) => !known.has(tag))).toEqual([]);
  });

  it("documents every extension tag the app's own conversions write", () => {
    const v7 =
      "0 HEAD\n1 GEDC\n2 VERS 7.0\n0 @I1@ INDI\n1 UID 1\n1 CREA\n2 DATE 1 JAN 2020\n1 NO MARR\n1 SEX X\n" +
      "1 EXID GPZG-CXL\n2 TYPE https://www.familysearch.org/tree/person/\n" +
      "1 BIRT\n2 SDATE 1900\n1 NOTE <b>a</b>\n2 MIME text/html\n2 LANG en\n2 TRAN b\n3 LANG sl\n0 TRLR\n";
    const down = parseGedcom(new TextEncoder().encode(v7).buffer).records;
    migrateVersion(down, "7.0", "5.5.1", () => {});
    // …and the 7.0 conversion's submission record (see save/outputFile.ts).
    // A source's 5.5-EL fields are written in the standard's forms instead
    // (`settleSourceFields`), so they need no page.
    const written = [serializeGedcom(down), "0 @S1@ _SUBN"].join("\n");
    const tags = new Set([...written.matchAll(/^\d+ (?:@[^@]+@ )?(_[A-Z_]+)/gm)].map((m) => m[1]));
    expect([...tags].sort()).toEqual(["_CREA", "_FSFTID", "_LANG", "_MIME", "_NO", "_SDATE", "_SEX", "_SUBN", "_TRAN", "_UID"]);
    for (const tag of tags) expect(ownTag(tag), tag).toBeDefined();
    expect(GEDMERGE_TAGS).toHaveLength(tags.size);
  });
});

describe("termsUri — which page a declared tag points to", () => {
  it("is the file producer's page where the producer writes the tag", () => {
    expect(termsUri("_UPD", "MYHERITAGE")).toBe(page("myheritage", "_UPD"));
    expect(termsUri("_MILT", "BROSKEEP")).toBe(page("brotherskeeper", "_MILT"));
    expect(termsUri("_MILT", "FTM")).toBe(page("ftm", "_MILT"));
    expect(termsUri("_FID", "SyniumFamilyTree")).toBe(page("macfamilytree", "_FID"));
    expect(termsUri("_MARNM", "MYHERITAGE")).toBe(page("myheritage", "_MARNM"));
    expect(termsUri("_UID", "GEDMERGE")).toBe(page("gedmerge", "_UID"));
  });

  it("falls back to the program the registry names, or to the shared page", () => {
    expect(termsUri("_UPD", "Gramps")).toBe(page("myheritage", "_UPD"));
    expect(termsUri("_UPD", undefined)).toBe(page("myheritage", "_UPD"));
    expect(termsUri("_MILT", "GEDMERGE")).toBe(page("brotherskeeper", "_MILT"));
    expect(termsUri("_MARNM", "Reunion")).toBe(page("common", "_MARNM"));
    expect(termsUri("_MARNM", undefined)).toBe(page("common", "_MARNM"));
    expect(termsUri("_SUBN", "MYHERITAGE")).toBe(page("gedmerge", "_SUBN"));
    expect(termsUri("_CREA", "MYHERITAGE")).toBe(page("ancestry", "_CREA"));
  });

  it("points a tag no table knows under unknown/, in the file's spelling", () => {
    expect(termsUri("_myTag", "MYHERITAGE")).toBe("https://gedmerge.com/terms/unknown/#_myTag");
    expect(termsUri("_FA99", "FTM")).toBe("https://gedmerge.com/terms/unknown/#_FA99");
    // A known tag in another case is the same tag.
    expect(termsUri("_uid", undefined)).toBe(page("common", "_UID"));
  });

  it("recognizes producers by their HEAD.SOUR id", () => {
    expect(producerSlug(" myheritage ")).toBe("myheritage");
    expect(producerSlug("Ancestry.com Family Trees")).toBe("ancestry");
    expect(producerSlug("FAMILY_HISTORIAN")).toBe("familyhistorian");
    expect(producerSlug("Geneanet")).toBeUndefined();
    expect(producerSlug(undefined)).toBeUndefined();
    expect(vendorTagInfo("_FA7")?.software).toBe("Family Tree Maker");
  });
});
