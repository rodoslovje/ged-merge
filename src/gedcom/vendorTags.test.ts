import { describe, expect, it } from "vitest";
import { VENDOR_PRIVACY_TAGS, vendorTagInfo } from "./vendorTags";

describe("vendorTagInfo", () => {
  it("classifies well-known vendor tags with software and category", () => {
    expect(vendorTagInfo("_UID")?.category).toBe("identity");
    expect(vendorTagInfo("_MARNM")?.category).toBe("name");
    expect(vendorTagInfo("_INTE")).toMatchObject({ software: "Brother's Keeper", category: "event" });
    expect(vendorTagInfo("_UPD")).toMatchObject({ software: "MyHeritage", category: "internal" });
    expect(vendorTagInfo("_FREL")?.category).toBe("familyStatus");
    expect(vendorTagInfo("_PRIM")?.category).toBe("media");
    expect(vendorTagInfo("_ITALIC")?.category).toBe("citation");
  });

  it("provides both language variants of the meaning", () => {
    const info = vendorTagInfo("_FARN");
    expect(info?.meaning.en).toBeTruthy();
    expect(info?.meaning.sl).toBeTruthy();
  });

  it("resolves numbered/prefixed tag families", () => {
    expect(vendorTagInfo("__FLAG_3")).toEqual(vendorTagInfo("_FLGS"));
    expect(vendorTagInfo("_COLOR2")).toEqual(vendorTagInfo("_COLOR"));
    expect(vendorTagInfo("_LIST6")).toEqual(vendorTagInfo("_LIST"));
    expect(vendorTagInfo("_FA13")?.software).toBe("Family Tree Maker");
    expect(vendorTagInfo("_SENDOM")?.software).toBe("PAF");
    expect(vendorTagInfo("_STE")?.software).toBe("MacFamilyTree");
  });

  it("returns undefined for tags it does not know", () => {
    expect(vendorTagInfo("_TOTALLY_MADE_UP")).toBeUndefined();
    expect(vendorTagInfo("BIRT")).toBeUndefined();
  });

  it("classifies account traces as privacy and exports them as the scrub set", () => {
    for (const tag of ["_PUBLISH", "_USERNAME", "_USER", "_ENCR", "_WT_USER"]) {
      expect(vendorTagInfo(tag)?.category).toBe("privacy");
      expect(VENDOR_PRIVACY_TAGS.has(tag)).toBe(true);
    }
  });
});
