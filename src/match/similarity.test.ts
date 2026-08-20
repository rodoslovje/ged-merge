import { describe, expect, it } from "vitest";
import { localityParts, parsePlace } from "../gedcom/place";
import { parseDate } from "../gedcom/date";
import type { Individual } from "../gedcom/types";
import { SAME_PERSON_GIVEN, comparableName, dateSimilarity, dateCompareKey, givenNameSetSimilarity, givenSimilarity, noGivenNameInCommon, placeSimilarity } from "./similarity";
import { compareKey, isPlaceholderName } from "./text";
import { givenVariantKey } from "./givenVariants";
import { placeCompareKey } from "./place";

describe("parseDate qualifier variants", () => {
  const q = (s: string) => parseDate(s).qualifier;

  it("treats Abt./ABT/About/Circa/~ as 'about'", () => {
    for (const s of ["ABT 1900", "Abt. 1900", "About 1900", "Circa 1900", "ca 1900", "EST 1900", "~1900", "~ 1900"]) {
      expect(parseDate(s)).toMatchObject({ qualifier: "about", year: 1900 });
    }
  });

  it("treats Bef./BEF/Before and Aft./AFT/After", () => {
    expect(q("Bef. 1900")).toBe("before");
    expect(q("BEFORE 1900")).toBe("before");
    expect(q("Aft 1900")).toBe("after");
    expect(q("After 1900")).toBe("after");
  });

  it("handles Between … and … variants", () => {
    expect(parseDate("Between 1900 and 1905")).toMatchObject({
      qualifier: "between",
      year: 1900,
      year2: 1905,
    });
  });
});

describe("comparableName / placeholder names", () => {
  it("detects placeholder tokens and leaves real names alone", () => {
    for (const s of ["Living", "Privat", "NN", "nn", "N.N.", "?", "???", "?Ime?", "?Priimek?", "neznana", "unknown", "__"]) {
      expect(isPlaceholderName(s), s).toBe(true);
    }
    for (const s of ["Janez", "Marija Ana", "O'Brien", "Neža", "de la Cruz"]) {
      expect(isPlaceholderName(s), s).toBe(false);
    }
  });

  it("drops placeholder parts, keeping real ones", () => {
    expect(comparableName({ full: "Marija NN", given: "Marija", surname: "NN" }))
      .toMatchObject({ given: "Marija", surname: undefined });
    expect(comparableName({ full: "Living", given: "Living" })).toBeUndefined();
    const real = { full: "Janez Novak", given: "Janez", surname: "Novak" };
    expect(comparableName(real)).toBe(real); // untouched names pass through by identity
  });
});

describe("cross-language given names", () => {
  // Parish registers are Latin, the tree is Slovenian: spelling alone reads
  // these as different names (Neža/Agnes has no matching characters at all).
  it("counts the Latin and Slovenian forms of one name as the same name", () => {
    for (const [a, b] of [
      ["Neža", "Agnes"],
      ["Jernej", "Bartholomeus"],
      ["Jurij", "Georgius"],
      ["Janez", "Joannes"],
      ["Katarina", "Catharina"],
      ["Jera", "Gertrud"],
      ["Marjeta", "Margaretha"],
      ["Miklavž", "Nicolaus"],
      ["Špela", "Elisabetha"],
      // Short forms of a name belong to it: with the surname dropped between
      // children, a missing one shows one child as two.
      ["Mihael", "Miha"],
      ["Mihael", "Miko"],
      ["Terezija", "Rezka"],
      ["Terezija", "Reza"],
      ["Rudolf", "Rudi"],
      ["Anton", "Tone"],
      ["Alojz", "Lojze"],
      ["Ignacij", "Nace"],
      ["Frančišek", "Franci"],
    ] as const) {
      expect(givenSimilarity(a, b), `${a}/${b}`).toBe(1);
    }
  });

  it("leaves names that merely share a root apart", () => {
    // Calibrated distinct pairs (MATCHING.md) — the table must not join them.
    for (const [a, b] of [
      ["Neža", "Ana"],
      ["Anton", "Jakob"],
      ["Marija", "Terezija"],
      ["Jožef", "Jakob"],
    ] as const) {
      expect(givenSimilarity(a, b), `${a}/${b}`).toBeLessThan(SAME_PERSON_GIVEN);
    }
    // Matej and Matija are spelled alike enough to score high on their own, but
    // they name two different children and get separate rows in the table.
    expect(givenVariantKey("matej")).not.toBe(givenVariantKey("matija"));
  });

  it("still compares token-wise, so a second given name doesn't hide the match", () => {
    expect(givenSimilarity("Joannes Baptista", "Janez")).toBe(1);
    expect(givenSimilarity("Neža", "Agnes Maria")).toBe(1);
  });

  it("lets the cross-file veto see through the language change", () => {
    const indi = (given: string): Individual =>
      ({ id: "@X@", names: [{ given, surname: "Sajovic", full: `${given} Sajovic` }] }) as unknown as Individual;
    expect(noGivenNameInCommon(indi("Neža"), indi("Agnes"))).toBe(false);
    expect(noGivenNameInCommon(indi("Neža"), indi("Ana"))).toBe(true);
  });
});

describe("givenNameSetSimilarity", () => {
  const n = (given?: string, surname?: string) => ({
    given,
    surname,
    full: [given, surname].filter(Boolean).join(" "),
  });

  it("ignores the shared family surname — different children sets score low", () => {
    // Full-name comparison scored these ~0.6+ because every child shares the
    // surname; given-only keeps just the discriminating part.
    const a = [n("Janez", "Novak"), n("Marija", "Novak")];
    const b = [n("Blaž", "Novak"), n("Uršula", "Novak")];
    expect(givenNameSetSimilarity(a, b)!).toBeLessThan(0.6);
  });

  it("scores same given names 1.0 regardless of surnames", () => {
    const a = [n("Janez", "Novak"), n("Marija", "Novak")];
    const b = [n("Janez", "Kovač"), n("Marija", "Kovač")];
    expect(givenNameSetSimilarity(a, b)).toBe(1);
  });

  it("is undefined when a side has no given names to compare", () => {
    expect(givenNameSetSimilarity([n(undefined, "Novak")], [n("Janez", "Novak")])).toBeUndefined();
    expect(givenNameSetSimilarity([], [n("Janez")])).toBeUndefined();
  });
});

describe("dateSimilarity", () => {
  const d = (s: string) => parseDate(s);

  it("reserves 1.0 for identical day-precision dates; coarser agreement scores 0.9", () => {
    expect(dateSimilarity(d("12 JAN 1900"), d("12 JAN 1900"))).toBe(1);
    // Two bare years (or bare months) merely agree on a period — in a dense
    // cluster two same-named people born the same year are routine, so this
    // must stay short of the day-exact 1.0 (which also gates the flat-100
    // perfect identity key).
    expect(dateSimilarity(d("JAN 1900"), d("JAN 1900"))).toBe(0.9);
    expect(dateSimilarity(d("1900"), d("1900"))).toBe(0.9);
  });

  it("keeps a precision mismatch below a perfect match", () => {
    // Same year and consistent, but one side is a full date and the other only
    // the year (or month): a strong match, yet not the same assertion.
    for (const pair of [["12 JAN 1900", "1900"], ["12 JAN 1900", "JAN 1900"], ["JAN 1900", "1900"]] as const) {
      const s = dateSimilarity(d(pair[0]), d(pair[1]))!;
      expect(s).toBeLessThan(1);
      expect(s).toBeGreaterThan(0.7);
    }
  });

  it("keeps an approximate date below a perfect match even on the same year", () => {
    // The year agrees but "about" doesn't assert it exactly, so it can't be 1.0.
    expect(dateSimilarity(d("ABT 1900"), d("ABT 1900"))).toBeLessThan(1);
    expect(dateSimilarity(d("ABT 1845"), d("4 APR 1845"))).toBeLessThan(1);
    expect(dateSimilarity(d("ABT 1845"), d("4 APR 1845"))!).toBeGreaterThan(0.7);
  });

  it("downweights real discrepancies", () => {
    expect(dateSimilarity(d("12 JAN 1900"), d("12 FEB 1900"))).toBeLessThan(0.7);
    expect(dateSimilarity(d("1900"), d("1905"))!).toBeLessThan(1);
    expect(dateSimilarity(d("1900"), d("1990"))).toBe(0);
  });

  describe("bound qualifiers (BEF/AFT/BET..AND/FROM/TO)", () => {
    it("treats a date well inside a 'before' bound as consistent, not a far-apart mismatch", () => {
      // "Bef. 1822" asserts the true date is earlier than 1822 — "1810" satisfies
      // that regardless of the 12-year gap, so this must not be the same as an
      // unrelated 12-years-apart point-vs-point comparison (which would be 0).
      const s = dateSimilarity(d("Bef. 1822"), d("26 FEB 1810"))!;
      expect(s).toBeGreaterThan(0.8);
      expect(s).toBeLessThan(1); // still short of an actual exact-date match
    });

    it("penalizes a date on the wrong side of a 'before' bound", () => {
      // 1830 is after the asserted "before 1822" bound — a genuine conflict.
      expect(dateSimilarity(d("Bef. 1822"), d("1830"))).toBeLessThan(0.5);
    });

    it("treats a date inside an 'after' bound as consistent", () => {
      expect(dateSimilarity(d("Aft. 1900"), d("1950"))!).toBeGreaterThan(0.8);
    });

    it("penalizes a date before an 'after' bound", () => {
      expect(dateSimilarity(d("Aft. 1900"), d("1850"))).toBeLessThan(0.5);
    });

    it("treats a date inside a 'between' range as consistent", () => {
      expect(dateSimilarity(d("Between 1900 and 1905"), d("1903"))!).toBeGreaterThan(0.8);
    });

    it("penalizes a date outside a 'between' range", () => {
      expect(dateSimilarity(d("Between 1900 and 1905"), d("1950"))).toBeLessThan(0.5);
    });

    it("still scores two overlapping bounds as consistent", () => {
      expect(dateSimilarity(d("Bef. 1822"), d("Bef. 1810"))!).toBeGreaterThan(0.8);
    });
  });
});

describe("parsePlace place detail", () => {
  it("extracts a trailing house number from the leading part", () => {
    expect(parsePlace("Šentvid 23").detail).toBe("23");
    expect(parsePlace("Šentvid 72, Vuzenica").detail).toBe("72");
    expect(parsePlace("Vuzenica 12a").detail).toBe("12a");
  });

  it("leaves places without a house number undetailed", () => {
    expect(parsePlace("Šentvid").detail).toBeUndefined();
    expect(parsePlace("Suhi vrh (Št.Janž nad Radljami)").detail).toBeUndefined();
  });

  it("extracts a house number followed by a parenthetical (ADDR style)", () => {
    const addr = parsePlace("Zgornje Bitnje 52 (pd Urbanov Jaka)");
    expect(addr.detail).toBe("52");
    expect(localityParts(addr)).toEqual(["Zgornje Bitnje"]);
  });

  it("strips the house number for locality comparison", () => {
    expect(localityParts(parsePlace("Šentvid 23"))).toEqual(["Šentvid"]);
    expect(localityParts(parsePlace("Šentvid 72, Vuzenica"))).toEqual(["Šentvid", "Vuzenica"]);
  });
});

describe("placeSimilarity with house numbers", () => {
  const p = parsePlace;

  it("scores identical locality + house number highest", () => {
    expect(placeSimilarity(p("Šentvid 23"), p("Šentvid 23"))).toBe(1);
  });

  it("downweights the same village with a different house number", () => {
    const sim = placeSimilarity(p("Šentvid 23"), p("Šentvid 25"))!;
    expect(sim).toBeCloseTo(0.5, 5);
    expect(sim).toBeLessThan(placeSimilarity(p("Šentvid 23"), p("Šentvid 23"))!);
  });

  it("does not penalize when one side lacks the house number", () => {
    expect(placeSimilarity(p("Šentvid 23"), p("Šentvid"))).toBe(1);
  });

  it("keeps different localities low", () => {
    expect(placeSimilarity(p("Maribor 5"), p("Šentvid 5"))!).toBeLessThan(0.75);
  });

  it("ignores country-name spelling and comma spacing in scoring", () => {
    expect(
      placeSimilarity(p("Krasinec,Metlika,Slovenia"), p("Krasinec, Metlika, Slovenija")),
    ).toBe(1);
    expect(placeSimilarity(p("Wien, Österreich"), p("Wien, Austria"))).toBe(1);
  });
});

// ── compareKey ───────────────────────────────────────────────────────────────

describe("compareKey", () => {
  it("folds case and diacritics", () => {
    expect(compareKey("Šentvid")).toBe(compareKey("sentvid"));
  });

  it("strips all whitespace so spacing differences are not conflicts", () => {
    expect(compareKey("Kranj, Slovenija")).toBe(compareKey("Kranj,Slovenija"));
    expect(compareKey("  a  b  ")).toBe(compareKey("ab"));
  });

  it("preserves content differences", () => {
    expect(compareKey("Alice")).not.toBe(compareKey("Bob"));
  });
});

// ── dateCompareKey ───────────────────────────────────────────────────────────

describe("dateCompareKey", () => {
  it("equates semantically identical date spellings", () => {
    expect(dateCompareKey("ABT 1900")).toBe(dateCompareKey("Abt. 1900"));
    expect(dateCompareKey("About 1900")).toBe(dateCompareKey("Circa 1900"));
  });

  it("equates exact date representations that parse identically", () => {
    expect(dateCompareKey("1 JAN 1900")).toBe(dateCompareKey("1 Jan 1900"));
    expect(dateCompareKey("1 JAN 1900")).toBe(dateCompareKey("01 JAN 1900"));
  });

  it("distinguishes different years", () => {
    expect(dateCompareKey("1900")).not.toBe(dateCompareKey("1901"));
  });

  it("distinguishes approximate from exact", () => {
    expect(dateCompareKey("ABT 1900")).not.toBe(dateCompareKey("1900"));
  });

  it("falls back to compareKey for unparseable strings", () => {
    expect(dateCompareKey("unknown date")).toBe(compareKey("unknown date"));
  });
});

// ── placeCompareKey ──────────────────────────────────────────────────────────

describe("placeCompareKey", () => {
  it("equates country-name variants", () => {
    expect(placeCompareKey("Kranj, Slovenija")).toBe(placeCompareKey("Kranj, Slovenia"));
    expect(placeCompareKey("Wien, Österreich")).toBe(placeCompareKey("Wien, Austria"));
  });

  it("deduplicates repeated parts", () => {
    expect(placeCompareKey("Kranj, Kranj, Slovenija")).toBe(placeCompareKey("Kranj, Slovenija"));
  });

  it("is case and diacritic insensitive", () => {
    expect(placeCompareKey("KRANJ, SLOVENIJA")).toBe(placeCompareKey("Kranj, Slovenija"));
  });

  it("preserves differences in distinct places", () => {
    expect(placeCompareKey("Maribor, Slovenija")).not.toBe(placeCompareKey("Kranj, Slovenija"));
  });
});

// ── noGivenNameInCommon ──────────────────────────────────────────────────────

describe("noGivenNameInCommon", () => {
  const person = (given: string, surname: string): Individual =>
    ({ id: "@X@", names: [{ given, surname, full: `${given} ${surname}` }] }) as Individual;

  it("is the evidence that two records are two people", () => {
    // Similar enough in the surname to clear the matcher's gate, but the given
    // names share nothing — so a graft may not fuse them.
    expect(noGivenNameInCommon(person("Marjan", "Gorza"), person("Milan", "Grca"))).toBe(true);
  });

  it("holds a spelling variant to be one name", () => {
    expect(noGivenNameInCommon(person("Joze", "Grca"), person("Jozef", "Grca"))).toBe(false);
  });

  it("looks past the extras each file writes around a shared name", () => {
    // A patronymic particle on one side, an English alias on the other: the
    // averaging rule reads those as disagreement, but they share "Maredudd".
    expect(
      noGivenNameInCommon(person("Maredudd ap", "Tudor"), person("Maredudd (Meredith)", "Tudor")),
    ).toBe(false);
  });

  it("does not let a shared particle stand in for a shared name", () => {
    expect(noGivenNameInCommon(person("Owain ap", "Tudor"), person("Maredudd ap", "Tudor"))).toBe(true);
  });

  it("says nothing when a side has no given name", () => {
    expect(noGivenNameInCommon(person("", "Gorza"), person("Milan", "Grca"))).toBe(false);
  });
});
