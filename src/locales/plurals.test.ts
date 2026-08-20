import { describe, expect, it } from "vitest";
import i18next from "i18next";
import { en } from "./en";
import { sl } from "./sl";

/**
 * Slovenian agrees with the number in four forms, selected on the last two
 * digits: 1 → nominative singular, 2 → dual, 3–4 → nominative plural, 0 and
 * 5–99 → genitive plural. Getting it wrong reads as broken Slovenian ("3
 * zapisov"), so the forms are pinned here rather than trusted to a review.
 */

/** A real i18next over the app's locale maps — the plural selection under test
 *  is i18next's own (Intl.PluralRules), so a stub would prove nothing. */
function makeT(lng: "en" | "sl") {
  const inst = i18next.createInstance();
  void inst.init({
    lng,
    initAsync: false,
    resources: { en: { translation: en }, sl: { translation: sl } },
    interpolation: { escapeValue: false },
  });
  return inst;
}
const inst = { sl: makeT("sl"), en: makeT("en") };
const t = (key: string, count: number, lng: "sl" | "en") =>
  inst[lng].t(key, { count, families: "…", events: 9, date: "…" }) as string;

describe("Slovenian plural forms", () => {
  it("declines the duplicate-cluster counts", () => {
    expect(t("tools.duplicates.cluster.records", 1, "sl")).toBe("1 zapis");
    expect(t("tools.duplicates.cluster.records", 2, "sl")).toBe("2 zapisa");
    expect(t("tools.duplicates.cluster.records", 3, "sl")).toBe("3 zapisi");
    expect(t("tools.duplicates.cluster.records", 4, "sl")).toBe("4 zapisi");
    expect(t("tools.duplicates.cluster.records", 5, "sl")).toBe("5 zapisov");
    expect(t("tools.duplicates.cluster.records", 101, "sl")).toBe("101 zapis");
    expect(t("tools.duplicates.cluster.records", 102, "sl")).toBe("102 zapisa");
  });

  it("declines feminine and neuter nouns too", () => {
    expect(t("tools.places.coord.spots", 1, "sl")).toBe("1 točka");
    expect(t("tools.places.coord.spots", 2, "sl")).toBe("2 točki");
    expect(t("tools.places.coord.spots", 3, "sl")).toBe("3 točke");
    expect(t("tools.places.coord.spots", 5, "sl")).toBe("5 točk");

    expect(t("preview.stat.newFields", 1, "sl")).toBe("1 novo polje");
    expect(t("preview.stat.newFields", 2, "sl")).toBe("2 novi polji");
    expect(t("preview.stat.newFields", 3, "sl")).toBe("3 nova polja");
    expect(t("preview.stat.newFields", 5, "sl")).toBe("5 novih polj");
  });

  it("keeps the case the sentence needs, not just the nominative", () => {
    // Locative after "v": singular "zapisu", plural "zapisih" for every count.
    expect(t("tools.sources.referencedBy", 1, "sl")).toBe("Navedeno v 1 zapisu");
    expect(t("tools.sources.referencedBy", 2, "sl")).toBe("Navedeno v 2 zapisih");
    expect(t("tools.sources.referencedBy", 5, "sl")).toBe("Navedeno v 5 zapisih");
    // Accusative after "v": 1 zapis, 2 zapisa, 3 zapise, 5 zapisov.
    expect(t("tools.geocode.addr.applied", 1, "sl")).toBe("Zapisano v 1 zapis.");
    expect(t("tools.geocode.addr.applied", 3, "sl")).toBe("Zapisano v 3 zapise.");
    expect(t("tools.geocode.addr.applied", 5, "sl")).toBe("Zapisano v 5 zapisov.");
  });

  it("agrees the verb as well as the noun", () => {
    expect(t("tools.validate.coordConflict.hint", 1, "sl")).toContain("kombinacija kraja in naslova nosi");
    expect(t("tools.validate.coordConflict.hint", 2, "sl")).toContain("kombinaciji kraja in naslova nosita");
    expect(t("tools.validate.coordConflict.hint", 3, "sl")).toContain("kombinacije kraja in naslova nosijo");
    expect(t("tools.validate.coordConflict.hint", 5, "sl")).toContain("kombinacij kraja in naslova nosi");
  });

  it("agrees the ticked relatives of a duplicate merge", () => {
    // The confirmation names the relatives merged along with the pair; with one
    // ticked the plural sentence ("Sorodniki … bodo združeni") reads as broken.
    expect(t("tools.duplicates.mergeConfirmAlso", 1, "sl")).toContain("Sorodnik, ki ste ga označili");
    expect(t("tools.duplicates.mergeConfirmAlso", 2, "sl")).toContain("Sorodnika, ki ste ju označili");
    expect(t("tools.duplicates.mergeConfirmAlso", 3, "sl")).toContain("Sorodniki, ki ste jih označili");
    expect(t("tools.duplicates.mergeConfirmAlsoAfter", 1, "sl")).toContain("Otrok, ki ste ga označili");
    expect(t("tools.duplicates.mergeConfirmAlsoAfter", 2, "sl")).toContain("Otroka, ki ste ju označili");
    expect(t("tools.duplicates.mergeConfirmAlsoAfter", 5, "sl")).toContain("Otroci, ki ste jih označili");
  });

  it("still reads correctly in English", () => {
    expect(t("tools.duplicates.cluster.records", 1, "en")).toBe("1 record");
    expect(t("tools.duplicates.cluster.records", 2, "en")).toBe("2 records");
    expect(t("tools.geocode.morePeople", 1, "en")).toBe("…and 1 more person.");
    expect(t("tools.geocode.morePeople", 4, "en")).toBe("…and 4 more people.");
  });
});

describe("Slovenian gendered health-check findings", () => {
  const g = (key: string, context?: "M" | "F") =>
    inst.sl.t(key, { context, age: 104, max: 99, fam: "@F1@", count: 1 }) as string;

  it("agrees the finding with the record's sex", () => {
    expect(g("tools.validate.issue.ageAtDeath", "M")).toBe("Umrl pri starosti 104 (nad 99)");
    expect(g("tools.validate.issue.ageAtDeath", "F")).toBe("Umrla pri starosti 104 (nad 99)");
    expect(g("tools.validate.issue.ageAtMarriage", "F")).toContain("Poročena");
    expect(g("tools.validate.issue.livingTooOld", "F")).toContain("bi imela");
    expect(g("tools.validate.issue.orphan", "F")).toBe("Ni povezana z nobeno družino");
    expect(g("tools.validate.issue.famsMissing", "M")).toBe("Naveden kot zakonec v neobstoječi družini @F1@");
    expect(g("tools.validate.issue.pedigreeLoop", "F")).toContain("Je svoja lastna prednica");
  });

  it("keeps the neutral form when the sex is unrecorded", () => {
    expect(g("tools.validate.issue.ageAtDeath")).toContain("Umrl(a)");
    expect(g("tools.validate.issue.orphan")).toContain("povezan(a)");
  });

  it("leaves a finding with no gendered form alone, context or not", () => {
    // i18next falls back to the base key — including through a plural, so the
    // count still picks the right form.
    expect(g("tools.validate.issue.missingSex", "F")).toBe("Spol ni zabeležen");
    expect(inst.sl.t("tools.validate.issue.island", { context: "F", count: 2 })).toContain("Ena od 2 oseb");
  });
});

describe("locale files", () => {
  /** Every plural key must carry the full set its language needs. */
  it("defines all four Slovenian forms wherever any is defined", () => {
    const bases = new Set(
      Object.keys(sl)
        .filter((k) => /_(one|two|few|other)$/.test(k))
        .map((k) => k.replace(/_(one|two|few|other)$/, "")),
    );
    const missing = [...bases].filter((b) =>
      ["one", "two", "few", "other"].some((s) => !(`${b}_${s}` in sl)),
    );
    expect(missing).toEqual([]);
  });

  it("defines both English forms wherever any is defined", () => {
    const bases = new Set(
      Object.keys(en)
        .filter((k) => /_(one|other)$/.test(k))
        .map((k) => k.replace(/_(one|other)$/, "")),
    );
    const missing = [...bases].filter((b) => !(`${b}_one` in en) || !(`${b}_other` in en));
    expect(missing).toEqual([]);
  });

  it("has no leftover base key shadowing a pluralized one", () => {
    for (const [name, pack] of [["sl", sl], ["en", en]] as const) {
      const bases = new Set(
        Object.keys(pack)
          .filter((k) => /_(one|two|few|other)$/.test(k))
          .map((k) => k.replace(/_(one|two|few|other)$/, "")),
      );
      const shadowed = [...bases].filter((b) => b in pack);
      expect(shadowed, `${name} has base keys beside plural forms`).toEqual([]);
    }
  });

  it("pluralizes the same keys in both languages", () => {
    const bases = (pack: Record<string, string>) =>
      new Set(
        Object.keys(pack)
          .filter((k) => /_(one|two|few|other)$/.test(k))
          .map((k) => k.replace(/_(one|two|few|other)$/, "")),
      );
    const slBases = bases(sl);
    const enBases = bases(en);
    // A count that agrees in one language agrees in the other; only the number
    // of forms differs (Slovenian four, English two).
    expect([...slBases].filter((b) => !enBases.has(b))).toEqual([]);
    expect([...enBases].filter((b) => !slBases.has(b))).toEqual([]);
  });
});
