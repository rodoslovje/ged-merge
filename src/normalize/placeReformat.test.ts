import { describe, expect, it } from "vitest";
import { reformatPlace } from "./placeReformat";
import type { PlaceHierarchy, PlaceTargetFormat } from "./types";

const RENKO: PlaceTargetFormat = { layout: "structured-addr", separator: "," };

describe("reformatPlace → structured-addr", () => {
  it("splits a packed street place into PLAC and ADDR, keeping facility in parens in ADDR", () => {
    const r = reformatPlace("Kranj (Slovenija), Kidričeva 38/a (porodnišnica)", undefined, RENKO);
    expect(r.plac).toBe("Kranj,Slovenija");
    expect(r.addr).toBe("Kidričeva 38/a (porodnišnica)");
    expect(r.agency).toBeUndefined();
  });

  it("moves a parish into AGNC and a house number into ADDR", () => {
    const r = reformatPlace(
      "Podčetrtek (Slovenija), Podčetrtek 52 - župnija Šmarje pri Jelšah",
      undefined,
      RENKO,
    );
    expect(r.plac).toBe("Podčetrtek,Slovenija");
    expect(r.addr).toBe("Podčetrtek 52");
    expect(r.agency).toBe("župnija Šmarje pri Jelšah");
  });

  it("turns an address-only place into PLAC + ADDR", () => {
    const r = reformatPlace("Zgornje Bitnje 52", undefined, RENKO);
    expect(r.plac).toBe("Zgornje Bitnje");
    expect(r.addr).toBe("Zgornje Bitnje 52");
    expect(r.agency).toBeUndefined();
  });

  it("preserves an already-structured PLAC + ADDR (with house name)", () => {
    const r = reformatPlace("Srednje Bitnje,Kranj,Slovenia", "Srednje Bitnje 18 (pd Adam)", RENKO);
    expect(r.plac).toBe("Srednje Bitnje,Kranj,Slovenia");
    expect(r.addr).toBe("Srednje Bitnje 18 (pd Adam)");
    expect(r.agency).toBeUndefined();
  });

  it("combines a street ADDR with a parish AGNC", () => {
    const r = reformatPlace("Kranj (Slovenija), Tatjane Odrove 4 - župnija Kranj", undefined, RENKO);
    expect(r.plac).toBe("Kranj,Slovenija");
    expect(r.addr).toBe("Tatjane Odrove 4");
    expect(r.agency).toBe("župnija Kranj");
  });

  it("honours the main's ', ' separator", () => {
    const r = reformatPlace("Jesenice (Slovenija)", undefined, {
      layout: "structured-addr",
      separator: ", ",
    });
    expect(r.plac).toBe("Jesenice, Slovenija");
    expect(r.addr).toBeUndefined();
  });
});

const KOVACIC: PlaceTargetFormat = { layout: "packed-plac", separator: "," };

describe("reformatPlace → packed-plac (the reverse direction)", () => {
  it("packs a structured PLAC + ADDR into one PLAC, dropping the middle level", () => {
    const r = reformatPlace("Srednje Bitnje,Kranj,Slovenia", "Srednje Bitnje 18 (pd Adam)", KOVACIC);
    // "Kranj" (municipality) is dropped; country goes in parens; ADDR folds in.
    expect(r.plac).toBe("Srednje Bitnje (Slovenia), Srednje Bitnje 18 (pd Adam)");
    expect(r.addr).toBeUndefined();
    expect(r.agency).toBeUndefined();
  });

  it("packs an address-only place", () => {
    const r = reformatPlace("Zgornje Bitnje 52", undefined, KOVACIC);
    expect(r.plac).toBe("Zgornje Bitnje, Zgornje Bitnje 52");
    expect(r.addr).toBeUndefined();
  });

  it("is idempotent on an already-packed place (parish + facility)", () => {
    const raw = "Jesenice (Slovenija), Cesta revolucije 2/b - župnija Jesenice";
    expect(reformatPlace(raw, undefined, KOVACIC).plac).toBe(raw);
    const fac = "Kranj (Slovenija), Kidričeva 38/a (porodnišnica)";
    expect(reformatPlace(fac, undefined, KOVACIC).plac).toBe(fac);
  });
});

describe("reformatPlace → ADDR locality differs from PLAC locality", () => {
  it("uses the ADDR's own locality as prefix when it differs from the PLAC locality", () => {
    // PLAC="Kranj,Kranj,Slovenia", ADDR="Gorenja Sava 20"
    // The house number belongs to "Gorenja Sava", not to "Kranj".
    const r = reformatPlace("Kranj,Kranj,Slovenia", "Gorenja Sava 20", KOVACIC);
    expect(r.plac).toContain("Gorenja Sava 20");
    expect(r.plac).not.toContain("Kranj 20");
  });

  it("still uses PLAC locality when ADDR locality matches it", () => {
    const r = reformatPlace("Srednje Bitnje,Kranj,Slovenia", "Srednje Bitnje 18 (pd Adam)", KOVACIC);
    expect(r.plac).toContain("Srednje Bitnje 18 (pd Adam)");
  });
});

describe("reformatPlace → country name normalization", () => {
  const countryPreferred = new Map([["slovenia", "Slovenija"], ["austria", "Avstrija"]]);
  const KOVACIC_SL: PlaceTargetFormat = { layout: "packed-plac", separator: ",", countryPreferred };
  const RENKO_SL: PlaceTargetFormat = { layout: "structured-addr", separator: ",", countryPreferred };

  it("rewrites English country to main's Slovenian form in packed-plac output", () => {
    const r = reformatPlace("Kranj (Slovenia), Kidričeva 38/a", undefined, KOVACIC_SL);
    expect(r.plac).toContain("(Slovenija)");
    expect(r.plac).not.toContain("(Slovenia)");
  });

  it("rewrites English country in structured-addr output", () => {
    const r = reformatPlace("Kranj,Slovenia", undefined, RENKO_SL);
    expect(r.plac).toBe("Kranj,Slovenija");
  });

  it("is a no-op when incoming country already matches main form", () => {
    const r = reformatPlace("Kranj (Slovenija)", undefined, KOVACIC_SL);
    expect(r.plac).toContain("(Slovenija)");
  });

  it("leaves unknown country names unchanged", () => {
    const r = reformatPlace("New York (USA)", undefined, KOVACIC_SL);
    expect(r.plac).toContain("(USA)");
  });
});

describe("reformatPlace → main-learned hierarchy fills in missing detail", () => {
  const hierarchy: PlaceHierarchy = {
    parentOf: new Map([
      ["kranj", ["Kranj", "Slovenia"]],
      ["stražišče", ["Kranj", "Slovenia"]],
    ]),
    localityOfStreet: new Map([["hafnarjeva pot", "Stražišče"]]),
  };
  const RENKO_H: PlaceTargetFormat = { layout: "structured-addr", separator: ",", hierarchy };

  it("inserts a missing municipality level the main always writes for this locality", () => {
    const r = reformatPlace("Kranj,Slovenia", undefined, RENKO_H);
    expect(r.plac).toBe("Kranj,Kranj,Slovenia");
  });

  it("resolves a more specific locality from the street and backfills its municipality", () => {
    const r = reformatPlace("Kranj,Slovenia", "Hafnarjeva pot 21/a", RENKO_H);
    expect(r.plac).toBe("Stražišče,Kranj,Slovenia");
    expect(r.addr).toBe("Hafnarjeva pot 21/a");
  });

  it("leaves the locality alone when the street isn't recognized", () => {
    const r = reformatPlace("Kranj,Slovenia", "Neznana ulica 5", RENKO_H);
    expect(r.plac).toBe("Kranj,Kranj,Slovenia");
  });

  it("does not sharpen a generic locality from a parish (parishes span many villages)", () => {
    // A parish is no longer a sharpening hint: "župnija Šmartin" might cover
    // several hamlets, so a generic "Kranj,Slovenia" with only a parish and no
    // recognizable street must stay generic rather than be pinned to one village.
    const r = reformatPlace("Kranj (Slovenija) - župnija Šmartin", undefined, RENKO_H);
    expect(r.plac).toBe("Kranj,Kranj,Slovenia");
    expect(r.agency).toBe("župnija Šmartin");
  });

  it("is a no-op when no hierarchy is supplied", () => {
    const r = reformatPlace("Kranj,Slovenia", "Hafnarjeva pot 21/a", {
      layout: "structured-addr",
      separator: ",",
    });
    expect(r.plac).toBe("Kranj,Slovenia");
  });
});

describe("reformatPlace idempotence (re-normalizing its own output)", () => {
  /** Apply reformatPlace to its own output; both passes must agree. */
  const fixedPoint = (plac: string | undefined, addr: string | undefined, fmt: PlaceTargetFormat) => {
    const r1 = reformatPlace(plac, addr, fmt);
    const r2 = reformatPlace(r1.plac, r1.addr, fmt);
    expect(r2.plac).toBe(r1.plac);
    expect(r2.addr).toBe(r1.addr);
    return r1;
  };

  it("keeps a bare house-number ADDR segment as the house number (Mauko '26 (Kapela)')", () => {
    // "26" alone used to parse as a locality, so the second pass dropped it.
    const r = fixedPoint("Hrašenski Vrh, Sv. Jurij ob Ščavnici", "26 (Kapela)", {
      layout: "structured-addr",
      separator: ", ",
    });
    expect(r.addr).toBe("Hrašenski Vrh 26 (Kapela)");
  });

  it("reads a bare number between PLAC segments as the house number", () => {
    const r = fixedPoint("Hrašenski Vrh, 26, Kapela", undefined, {
      layout: "structured-addr",
      separator: ", ",
    });
    expect(r.plac).toBe("Hrašenski Vrh");
    expect(r.addr).toBe("Hrašenski Vrh 26 (Kapela)");
  });

  it("parenthesizes a packed facility that would re-parse as a jurisdiction (Kovačič 'Šlapanov (Češka)')", () => {
    // "Češka" is not in the country list, so it lands in facility; the old
    // ", Češka" output read back as a jurisdiction level and was dropped.
    const r = fixedPoint("Šlapanov (Češka), Bohemia", undefined, KOVACIC);
    expect(r.plac).toBe("Šlapanov (Češka)");
  });

  it("still writes a facility-word detail in the packed ', facility' style", () => {
    const r = fixedPoint("Kranj (Slovenija), porodnišnica", undefined, KOVACIC);
    expect(r.plac).toBe("Kranj (Slovenija), porodnišnica");
  });

  it("keeps an ADDR with substance beyond its facility verbatim (Bandelj 'Hrastje 26 Mrva (Moravče)')", () => {
    // The old `!a.facility` guard dropped everything but the facility.
    const r = fixedPoint(
      "Hrastje, Vojvodina Kranjska, Avstro-Ogrska",
      "Hrastje 26 Mrva (Moravče)",
      { layout: "structured-addr", separator: ", " },
    );
    expect(r.addr).toBe("Hrastje 26 Mrva (Moravče)");
  });

  it("emits a facility-only place without a leading space", () => {
    const r = fixedPoint("(Kozjansko)", undefined, KOVACIC);
    expect(r.plac).toBe("(Kozjansko)");
  });

  it("moves a parish-only ADDR into AGNC without keeping a duplicate ADDR", () => {
    const r = fixedPoint("Trst, Avstrijsko primorje", "Župnija Sv. Antona", {
      layout: "structured-addr",
      separator: ", ",
    });
    expect(r.addr).toBeUndefined();
    expect(r.agency).toBe("župnija Sv. Antona");
  });
});

describe("reformatPlace → other layouts pass through", () => {
  it("does not reshape when the main layout is plain-structured", () => {
    const r = reformatPlace("Kranj (Slovenija), Kidričeva 38/a", undefined, {
      layout: "plain-structured",
      separator: ",",
    });
    expect(r.plac).toBe("Kranj (Slovenija), Kidričeva 38/a");
    expect(r.addr).toBeUndefined();
    expect(r.agency).toBeUndefined();
  });
});
