import { describe, expect, it } from "vitest";
import { applyFormatOverrides, dateProfileFromPattern, sanitizeFormatOverrides } from "./formatOverrides";
import type { DateFormatProfile, MainProfile } from "./types";

const DETECTED_DATE: DateFormatProfile = {
  monthTokens: ["", "JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AVG", "SEP", "OKT", "NOV", "DEC"],
  padDay: false,
  qualifierTokens: { about: "OK.", before: "PRED", after: "PO", calculated: "IZR", estimated: "OC." } as never,
};

function profile(): MainProfile {
  return {
    version: "7.0",
    date: DETECTED_DATE,
    place: { layout: "structured-addr" } as MainProfile["place"],
    linkLangs: { matricula: "sl", geneanet: undefined },
    placeFmt: { layout: "structured-addr", separator: "," },
    nameVariants: {
      married: { form: "record", type: "married" },
      birth: { form: "none" },
      aka: { form: "none" },
      nick: { form: "record", type: "nick" },
    },
    unknownName: { form: "token", token: "NN" },
  };
}

describe("dateProfileFromPattern", () => {
  it("parses numeric patterns in all orders", () => {
    const dmy = dateProfileFromPattern("DD.MM.YYYY", DETECTED_DATE)!;
    expect(dmy.numeric).toMatchObject({ order: "DMY", separator: ".", padDay: true, padMonth: true });
    const short = dateProfileFromPattern("D.M.YYYY", DETECTED_DATE)!;
    expect(short.numeric).toMatchObject({ order: "DMY", padDay: false, padMonth: false });
    const mdy = dateProfileFromPattern("MM/DD/YYYY", DETECTED_DATE)!;
    expect(mdy.numeric).toMatchObject({ order: "MDY", separator: "/" });
    const ymd = dateProfileFromPattern("YYYY-MM-DD", DETECTED_DATE)!;
    expect(ymd.numeric).toMatchObject({ order: "YMD", separator: "-" });
    // The detected file's qualifier spellings survive an overridden layout.
    expect(dmy.qualifierTokens).toBe(DETECTED_DATE.qualifierTokens);
  });

  it("parses month-word patterns with casing", () => {
    const upper = dateProfileFromPattern("D MMM YYYY", DETECTED_DATE)!;
    expect(upper.numeric).toBeUndefined();
    expect(upper.monthTokens[1]).toBe("JAN");
    expect(upper.padDay).toBe(false);
    const title = dateProfileFromPattern("DD Mmm YYYY", DETECTED_DATE)!;
    expect(title.monthTokens[2]).toBe("Feb");
    expect(title.padDay).toBe(true);
  });

  it("applies a placeholder override and rejects junk", () => {
    const withPh = dateProfileFromPattern("DD.MM.YYYY", DETECTED_DATE, "_")!;
    expect(withPh.numeric?.placeholder).toBe("_");
    const none = dateProfileFromPattern("DD.MM.YYYY", DETECTED_DATE, "none")!;
    expect(none.numeric?.placeholder).toBeUndefined();
    expect(dateProfileFromPattern("garbage", DETECTED_DATE)).toBeUndefined();
  });
});

describe("applyFormatOverrides", () => {
  it("passes the profile through untouched without overrides", () => {
    const p = profile();
    expect(applyFormatOverrides(p, undefined)).toBe(p);
    expect(applyFormatOverrides(p, {})).toEqual(p);
  });

  it("overrides each dimension independently", () => {
    const p = profile();
    const out = applyFormatOverrides(p, {
      date: "DD.MM.YYYY",
      place: "packed-plac",
      names: "tags",
      unknownName: "blank",
      matriculaLang: "de",
      geneanetLang: "fr",
    });
    expect(out.date.numeric?.order).toBe("DMY");
    expect(out.place.layout).toBe("packed-plac");
    expect(out.placeFmt.layout).toBe("packed-plac");
    // Every variant flips to inline tags, keeping defaults for the ones the
    // file never used and never inventing per-variant tags it did use.
    expect(out.nameVariants.married).toEqual({ form: "tag", tag: "_MARNM" });
    expect(out.nameVariants.nick).toEqual({ form: "tag", tag: "NICK" });
    expect(out.unknownName).toEqual({ form: "blank" });
    expect(out.linkLangs).toMatchObject({ matricula: "de", geneanet: "fr" });
    // The input profile is not mutated.
    expect(p.place.layout).toBe("structured-addr");
    expect(p.nameVariants.married.form).toBe("record");
  });

  it("keeps detected TYPE spellings when overriding to records", () => {
    const p = profile();
    const out = applyFormatOverrides(p, { names: "records" });
    expect(out.nameVariants.married).toEqual({ form: "record", type: "married" });
    expect(out.nameVariants.birth).toEqual({ form: "record", type: "birth" }); // default for unused variant
  });

  it("overrides the place separator, alone and beside a layout override", () => {
    const spaced = applyFormatOverrides(profile(), { placeSeparator: "comma-space" });
    expect(spaced.placeFmt).toMatchObject({ layout: "structured-addr", separator: ", " });
    const both = applyFormatOverrides(profile(), { place: "packed-plac", placeSeparator: "comma-space" });
    expect(both.placeFmt).toMatchObject({ layout: "packed-plac", separator: ", " });
    // The detected "," survives when only the layout is overridden.
    expect(applyFormatOverrides(profile(), { place: "packed-plac" }).placeFmt.separator).toBe(",");
  });

  it("overrides the unknown-name token", () => {
    const out = applyFormatOverrides(profile(), { unknownName: "N.N." });
    expect(out.unknownName).toEqual({ form: "token", token: "N.N." });
  });
});

describe("sanitizeFormatOverrides", () => {
  it("keeps valid fields and drops junk", () => {
    expect(
      sanitizeFormatOverrides({
        date: "DD.MM.YYYY",
        place: "packed-plac",
        names: "sideways",
        placeSeparator: "semicolon",
        citations: "event",
        pageMedia: "banana",
        baptism: "BAPM",
        doubledLinks: "keep",
        unknownName: "  ",
        extra: 42,
      }),
    ).toEqual({ date: "DD.MM.YYYY", place: "packed-plac", citations: "event", baptism: "BAPM", doubledLinks: "keep" });
    expect(sanitizeFormatOverrides(null)).toEqual({});
    expect(sanitizeFormatOverrides("x")).toEqual({});
  });
});
