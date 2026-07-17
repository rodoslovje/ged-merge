import { describe, expect, it } from "vitest";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import { normalizePrivacyStyle } from "./privacy";

function records(lines: string[]) {
  return parseGedcom(new TextEncoder().encode(lines.join("\n")).buffer).records;
}

describe("normalizePrivacyStyle", () => {
  it("rewrites MyHeritage _PRIV markers into the main's PRIV dialect, records and notes alike", () => {
    const recs = records([
      "0 HEAD",
      "0 @I1@ INDI",
      "1 _PRIV Y",
      "0 @N1@ NOTE secret",
      "1 _PRIV Y",
      "0 TRLR",
    ]);
    const changes = normalizePrivacyStyle(recs, "PRIV");
    const out = serializeGedcom(recs);
    expect(changes).toHaveLength(2);
    expect(out).not.toContain("_PRIV");
    expect(out.match(/^1 PRIV$/gm)).toHaveLength(2);
  });

  it("keeps non-privacy RESN list entries and leaves house-style markers alone", () => {
    const recs = records([
      "0 HEAD",
      "0 @I1@ INDI",
      "1 RESN CONFIDENTIAL, LOCKED",
      "0 @I2@ INDI",
      "1 PRIV",
      "0 @I3@ INDI",
      "1 RESN NONE",
      "0 TRLR",
    ]);
    const changes = normalizePrivacyStyle(recs, "PRIV");
    const out = serializeGedcom(recs);
    expect(changes).toHaveLength(1); // only @I1@ — @I2@ already PRIV, @I3@ not private
    expect(out).toContain("1 RESN LOCKED"); // the non-privacy entry survives
    expect(out).toContain("1 RESN NONE"); // webtrees noise untouched
    expect(out.match(/^1 PRIV$/gm)).toHaveLength(2);
  });
});
