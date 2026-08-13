import { describe, expect, it } from "vitest";
import { customEventLabel, customEventTooltip, eventDisplayLabel, vendorEventTooltip } from "./eventTags";

/** Minimal i18n stub: a couple of event names plus the tooltip templates. */
const t = (key: string, opts?: Record<string, unknown>) => {
  const table: Record<string, string> = {
    "event.BURI": "Burial",
    "event._FNRL": "Funeral",
    "event.MARR": "Marriage",
  };
  if (key === "event.vendorTooltip") return `Non-standard tag ${opts?.tag}`;
  if (key === "event.vendorTooltip.known")
    return `Non-standard tag ${opts?.tag} (${opts?.software}): ${opts?.meaning}`;
  if (key === "event.vendorTypeTooltip")
    return `Custom event of type ${opts?.type} (${opts?.software}): ${opts?.meaning}`;
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

describe("customEventLabel", () => {
  it("names a program's namespaced type and leaves the user's own alone", () => {
    expect(customEventLabel("MYHERITAGE:REL_PARTNERS", t, "en")).toBe("Partners (MyHeritage)");
    expect(customEventLabel("MYHERITAGE:REL_PARTNERS", t, "sl")).toBe("Partnerja (MyHeritage)");
    expect(customEventLabel("MYHERITAGE:REL_UNKNOWN", t, "en")).toBe("Relationship unstated (MyHeritage)");
    // MyHeritage's last-updated stamp, written as an event on the person.
    expect(customEventLabel("_UPD", t, "en")).toBe("Last updated (MyHeritage)");
    // A type the user wrote is its own label, verbatim and untrimmed of meaning.
    expect(customEventLabel("Civil Partnership", t, "en")).toBe("Civil Partnership");
    expect(customEventLabel("  Twin  ", t, "en")).toBe("Twin");
    // No type at all leaves the caller's generic "Event" label standing.
    expect(customEventLabel(undefined, t, "en")).toBe("");
  });

  it("matches the type however the file cased it", () => {
    expect(customEventLabel("myheritage:rel_partners", t, "en")).toBe("Partners (MyHeritage)");
  });

  it("names a standard tag used as the type, keeping the raw value in view", () => {
    // MyHeritage writes a person's marriage as `1 EVEN` + `2 TYPE MARR`.
    expect(customEventLabel("MARR", t, "en")).toBe("Marriage (MARR)");
    // EVEN/FACT as their own type say nothing the generic label doesn't.
    expect(customEventLabel("EVEN", t, "en")).toBe("EVEN");
    // A word that is not a tag stays exactly as the file wrote it.
    expect(customEventLabel("Marriage", t, "en")).toBe("Marriage");
  });
});

describe("customEventTooltip", () => {
  it("keeps the raw value visible for a known type, and stays quiet otherwise", () => {
    expect(customEventTooltip("MYHERITAGE:REL_PARTNERS", t, "en")).toBe(
      "Custom event of type MYHERITAGE:REL_PARTNERS (MyHeritage): the couple is recorded as partners, not as married",
    );
    expect(customEventTooltip("MYHERITAGE:REL_PARTNERS", t, "sl")).toContain("partnerja");
    expect(customEventTooltip("Civil Partnership", t, "en")).toBeUndefined();
    expect(customEventTooltip(undefined, t, "en")).toBeUndefined();
  });
});
