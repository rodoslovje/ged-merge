import { describe, expect, it } from "vitest";
import { eventDisplayLabel, vendorEventTooltip } from "./eventTags";

/** Minimal i18n stub: a couple of event names plus the tooltip templates. */
const t = (key: string, opts?: Record<string, unknown>) => {
  const table: Record<string, string> = {
    "event.BURI": "Burial",
    "event._FNRL": "Funeral",
  };
  if (key === "event.vendorTooltip") return `Non-standard tag ${opts?.tag}`;
  if (key === "event.vendorTooltip.known")
    return `Non-standard tag ${opts?.tag} (${opts?.software}): ${opts?.meaning}`;
  return table[key] ?? (opts?.defaultValue as string) ?? key;
};

describe("eventDisplayLabel", () => {
  it("appends the raw tag for vendor events only", () => {
    expect(eventDisplayLabel("BURI", t)).toBe("Burial");
    expect(eventDisplayLabel("_FNRL", t)).toBe("Funeral (_FNRL)");
    // An unnamed vendor tag falls back to the bare tag, not "tag (tag)".
    expect(eventDisplayLabel("_NOPE", t)).toBe("_NOPE");
  });
});

describe("vendorEventTooltip", () => {
  it("explains vendor tags and stays quiet for standard ones", () => {
    expect(vendorEventTooltip("BURI", t, "en")).toBeUndefined();
    expect(vendorEventTooltip("_FNRL", t, "en")).toBe(
      "Non-standard tag _FNRL (Brother's Keeper): funeral",
    );
    expect(vendorEventTooltip("_FNRL", t, "sl")).toContain("pogreb");
    expect(vendorEventTooltip("_NOPE", t, "en")).toBe("Non-standard tag _NOPE");
  });
});
