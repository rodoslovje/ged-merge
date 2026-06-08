import { describe, expect, it } from "vitest";
import { reformatPlace, type PlaceTargetFormat } from "./placeReformat";

const RENKO: PlaceTargetFormat = { layout: "structured-addr", separator: "," };

describe("reformatPlace → structured-addr", () => {
  it("splits a packed street place into PLAC, ADDR, and a facility NOTE", () => {
    const r = reformatPlace("Kranj (Slovenija), Kidričeva 38/a (porodnišnica)", undefined, RENKO);
    expect(r.plac).toBe("Kranj,Slovenija");
    expect(r.addr).toBe("Kidričeva 38/a");
    expect(r.note).toBe("porodnišnica");
  });

  it("moves a parish into a NOTE and a house number into ADDR", () => {
    const r = reformatPlace(
      "Podčetrtek (Slovenija), Podčetrtek 52 - župnija Šmarje pri Jelšah",
      undefined,
      RENKO,
    );
    expect(r.plac).toBe("Podčetrtek,Slovenija");
    expect(r.addr).toBe("Podčetrtek 52");
    expect(r.note).toBe("župnija Šmarje pri Jelšah");
  });

  it("turns an address-only place into PLAC + ADDR", () => {
    const r = reformatPlace("Zgornje Bitnje 52", undefined, RENKO);
    expect(r.plac).toBe("Zgornje Bitnje");
    expect(r.addr).toBe("Zgornje Bitnje 52");
    expect(r.note).toBeUndefined();
  });

  it("preserves an already-structured PLAC + ADDR (with house name)", () => {
    const r = reformatPlace("Srednje Bitnje,Kranj,Slovenia", "Srednje Bitnje 18 (pd Adam)", RENKO);
    expect(r.plac).toBe("Srednje Bitnje,Kranj,Slovenia");
    expect(r.addr).toBe("Srednje Bitnje 18 (pd Adam)");
    expect(r.note).toBeUndefined();
  });

  it("combines a street ADDR with a parish + facility NOTE", () => {
    const r = reformatPlace("Kranj (Slovenija), Tatjane Odrove 4 - župnija Kranj", undefined, RENKO);
    expect(r.plac).toBe("Kranj,Slovenija");
    expect(r.addr).toBe("Tatjane Odrove 4");
    expect(r.note).toBe("župnija Kranj");
  });

  it("honours the master's ', ' separator", () => {
    const r = reformatPlace("Jesenice (Slovenija)", undefined, {
      layout: "structured-addr",
      separator: ", ",
    });
    expect(r.plac).toBe("Jesenice, Slovenija");
    expect(r.addr).toBeUndefined();
  });
});

describe("reformatPlace → other layouts pass through", () => {
  it("does not reshape when the master is not structured-addr", () => {
    const r = reformatPlace("Kranj (Slovenija), Kidričeva 38/a", undefined, {
      layout: "packed-plac",
      separator: ",",
    });
    expect(r.plac).toBe("Kranj (Slovenija), Kidričeva 38/a");
    expect(r.addr).toBeUndefined();
    expect(r.note).toBeUndefined();
  });
});
