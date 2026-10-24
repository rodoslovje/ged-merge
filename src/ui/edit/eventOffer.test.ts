import { describe, expect, it } from "vitest";
import { offeredEventGroups, offersEventTag, type EventOffer } from "./editConstants";

const own = (tags: string[] = []): EventOffer => ({ version: "5.5.1", strict: false, dialectTags: new Set(tags) });
const strict70: EventOffer = { version: "7.0", strict: true, dialectTags: new Set(["NOBI"]) };

describe("offersEventTag — what the event menus offer", () => {
  it("offers a standard tag where the version has it", () => {
    expect(offersEventTag("OCCU", "INDI", strict70)).toBe(true);
    expect(offersEventTag("MARR", "FAM", own())).toBe(true);
    expect(offersEventTag("MARR", "INDI", own())).toBe(false);
  });

  it("offers an underscore extension always — the menu marks it", () => {
    expect(offersEventTag("_MILT", "INDI", strict70)).toBe(true);
  });

  it("offers a vendor tag written without the underscore only where the file's own format already uses it", () => {
    expect(offersEventTag("NOBI", "INDI", own(["NOBI"]))).toBe(true);
    expect(offersEventTag("NOBI", "INDI", own())).toBe(false);
    expect(offersEventTag("NOBI", "INDI", strict70)).toBe(false);
    expect(offersEventTag("SEPA", "FAM", own())).toBe(false);
  });

  it("drops a group that is left with nothing to offer", () => {
    const tags = offeredEventGroups(strict70).flatMap((g) => g.tags);
    expect(tags).toContain("BAPM");
    expect(tags).not.toContain("RACE");
    expect(tags).not.toContain("LATR");
    expect(tags).toContain("_FNRL");
  });
});
