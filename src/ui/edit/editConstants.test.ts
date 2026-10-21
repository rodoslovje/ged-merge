import { describe, expect, it } from "vitest";
import { isNonStandardTag } from "../../gedcom/eventTags";
import { INDIVIDUAL_EVENT_GROUPS } from "./editConstants";

describe("INDIVIDUAL_EVENT_GROUPS", () => {
  it("lists every non-standard tag after the standard ones in its group", () => {
    for (const group of INDIVIDUAL_EVENT_GROUPS) {
      const flags = group.tags.map(isNonStandardTag);
      const firstVendor = flags.indexOf(true);
      if (firstVendor >= 0) expect(flags.slice(firstVendor), group.labelKey).not.toContain(false);
    }
  });
});
