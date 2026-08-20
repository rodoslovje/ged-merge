import { describe, expect, it } from "vitest";
import i18next from "i18next";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { parseDate } from "../gedcom/date";
import { displayName, primaryName } from "../match/relatives";
import type { Individual } from "../gedcom/types";
import { en } from "../locales/en";
import { sl } from "../locales/sl";
import type { Translate } from "../locales/i18n";
import { buildDescendants } from "./descendants";
import { buildAhnentafel } from "./ahnentafel";
import type { ReportData, ReportEntry } from "./model";
import { sourceLabel } from "./model";
import { childGroups, planEntry } from "./narrative";
import { narrativeEntry, narrativeLangFor, narrativeParagraph } from "./narrativeText";
import { narrativeEn } from "./lang/en";
import { narrativeSl } from "./lang/sl";
import { reportToText } from "./text";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

const nameOf = (indi: Individual) => displayName(primaryName(indi));
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;
const NOW = 2000;

/** A real i18next t over the app's locale maps, so the tests exercise the
 *  actual templates (context fallback, interpolation) end to end. */
function makeT(lng: "en" | "sl"): Translate {
  const inst = i18next.createInstance();
  void inst.init({
    lng,
    initAsync: false,
    resources: { en: { translation: en }, sl: { translation: sl } },
    interpolation: { escapeValue: false },
  });
  return inst.t.bind(inst) as Translate;
}
const tEn = makeT("en");
const tSl = makeT("sl");

// Franc (M): birth + baptism, one marriage with two children, an occupation,
// death + burial — the full statement lineup in one person.
const FAMILY = wrap(
  "0 @I1@ INDI\n1 NAME Franc /Novak/\n1 SEX M\n1 BIRT\n2 DATE 5 MAY 1848\n2 PLAC Škofja Loka\n" +
    "1 BAPM\n2 DATE 7 MAY 1848\n1 OCCU kmet\n2 DATE 1880\n1 DEAT\n2 DATE 3 JAN 1912\n2 PLAC Ljubljana\n" +
    "1 BURI\n2 DATE 5 JAN 1912\n1 FAMS @F1@\n" +
    "0 @I2@ INDI\n1 NAME Marija /Oblak/\n1 SEX F\n1 BIRT\n2 DATE 1846\n1 DEAT\n2 DATE 1900\n1 FAMS @F1@\n" +
    "0 @I3@ INDI\n1 NAME Ana /Novak/\n1 SEX F\n1 BIRT\n2 DATE 1867\n1 DEAT\n2 DATE 1940\n1 FAMC @F1@\n" +
    "0 @I4@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1870\n1 DEAT\n2 DATE 1941\n1 FAMC @F1@\n" +
    "0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n1 CHIL @I3@\n1 CHIL @I4@\n1 MARR\n2 DATE 4 FEB 1866\n2 PLAC Škofja Loka\n",
);

function reportOf(text: string, root: string): ReportData {
  const data = buildDescendants(dataset(text), root, nameOf, NOW, { occupation: true });
  expect(data).toBeDefined();
  return data!;
}

function rootEntry(data: ReportData): ReportEntry {
  return data.generations[0].entries[0];
}

describe("en date phrases", () => {
  const phrase = (raw: string) => narrativeEn.datePhrase(parseDate(raw));
  it.each([
    ["5 MAY 1848", "on 5 May 1848"],
    ["MAY 1848", "in May 1848"],
    ["1848", "in 1848"],
    ["ABT 1848", "about 1848"],
    ["BEF 5 MAY 1848", "before 5 May 1848"],
    ["AFT MAY 1848", "after May 1848"],
    ["BET 1848 AND 1850", "between 1848 and 1850"],
  ])("%s → %s", (raw, expected) => {
    expect(phrase(raw)).toBe(expected);
  });
});

describe("sl date phrases", () => {
  const phrase = (raw: string) => narrativeSl.datePhrase(parseDate(raw));
  it.each([
    // genitive months; year-only dates get "leta"
    ["5 MAY 1848", "5. maja 1848"],
    ["MAY 1848", "maja 1848"],
    ["1848", "leta 1848"],
    ["ABT 1848", "okoli leta 1848"],
    // pred + instrumental, po + locative
    ["BEF 5 MAY 1848", "pred 5. majem 1848"],
    ["AFT MAY 1848", "po maju 1848"],
    ["AFT 1848", "po letu 1848"],
    // two bare years take the dual
    ["BET 1848 AND 1850", "med letoma 1848 in 1850"],
    ["BET MAY 1848 AND JUN 1850", "med majem 1848 in junijem 1850"],
    ["FROM 1848 TO 1850", "od leta 1848 do leta 1850"],
  ])("%s → %s", (raw, expected) => {
    expect(phrase(raw)).toBe(expected);
  });

  it("counts children in the accusative after 'imeti'", () => {
    expect([1, 2, 3, 4, 5, 101].map((n) => narrativeSl.childCount(n))).toEqual([
      "1 otroka",
      "2 otroka",
      "3 otroke",
      "4 otroke",
      "5 otrok",
      "101 otroka",
    ]);
  });
});

describe("planEntry", () => {
  const data = reportOf(FAMILY, "@I1@");
  const groups = childGroups(data);
  const root = rootEntry(data);
  const plan = planEntry(root, groups.get(root.num));

  it("fuses vitals and pairs children with their union's marriage", () => {
    expect(plan.map((s) => s.kind)).toEqual(["bornBaptized", "married", "children", "occupation", "diedBuried"]);
  });

  it("names the person once, then switches to the short subject", () => {
    expect(plan.map((s) => s.subject)).toEqual(["name", "pronoun", "pronoun", "pronoun", "pronoun"]);
  });

  it("plans nothing for duplicate entries", () => {
    expect(planEntry({ ...root, dupOf: 1 })).toEqual([]);
  });

  it("keeps the couple children form for an undated union with a known partner", () => {
    // The partner alone now earns the ⚭ fact — the marriage exists, only its
    // date is unrecorded — so the children still follow the couple wording.
    const noMarr = FAMILY.replace("1 MARR\n2 DATE 4 FEB 1866\n2 PLAC Škofja Loka\n", "");
    const d = reportOf(noMarr, "@I1@");
    const r = rootEntry(d);
    const kinds = planEntry(r, childGroups(d).get(r.num));
    expect(kinds.map((s) => `${s.kind}${s.kind === "children" ? `:${s.couple ? "couple" : "solo"}` : ""}`)).toEqual([
      "bornBaptized",
      "married",
      "children:couple",
      "occupation",
      "diedBuried",
    ]);
  });

  it("uses the single-parent children form when the union has no partner at all", () => {
    const soloParent = FAMILY
      .replace("1 MARR\n2 DATE 4 FEB 1866\n2 PLAC Škofja Loka\n", "")
      .replace("1 WIFE @I2@\n", "");
    const d = reportOf(soloParent, "@I1@");
    const r = rootEntry(d);
    const kinds = planEntry(r, childGroups(d).get(r.num));
    expect(kinds.map((s) => `${s.kind}${s.kind === "children" ? `:${s.couple ? "couple" : "solo"}` : ""}`)).toEqual([
      "bornBaptized",
      "children:solo",
      "occupation",
      "diedBuried",
    ]);
  });
});

describe("narrativeParagraph", () => {
  const data = reportOf(FAMILY, "@I1@");
  const groups = childGroups(data);
  const paragraph = (t: Translate, lng: "en" | "sl", e: ReportEntry) =>
    narrativeParagraph(t, narrativeLangFor(lng), e, planEntry(e, groups.get(e.num)));

  it("tells Franc's story in English", () => {
    expect(paragraph(tEn, "en", rootEntry(data))).toBe(
      "Franc Novak was born on 5 May 1848 in Škofja Loka and baptized on 7 May 1848. " +
        "He married Marija Oblak (1846–1900) on 4 February 1866 in Škofja Loka. " +
        "They had 2 children: Ana Novak and Janez Novak. " +
        "He worked as kmet in 1880. " +
        "He died on 3 January 1912 in Ljubljana and was buried on 5 January 1912.",
    );
  });

  it("tells Franc's story in Slovenian (gendered verbs, declined months, nominative places/names)", () => {
    expect(paragraph(tSl, "sl", rootEntry(data))).toBe(
      "Franc Novak se je rodil 5. maja 1848 v kraju Škofja Loka, krščen je bil 7. maja 1848. " +
        "Njegova žena je bila Marija Oblak (1846–1900); poročila sta se 4. februarja 1866 v kraju Škofja Loka. " +
        "Imela sta 2 otroka: Ana Novak in Janez Novak. " +
        "Bil je kmet leta 1880. " +
        "Umrl je 3. januarja 1912 v kraju Ljubljana, pokopan je bil 5. januarja 1912.",
    );
  });

  it("tells the partner's parents right after the marriage, keyed to the partner's sex", () => {
    const withParents = FAMILY
      .replace("1 DEAT\n2 DATE 1900\n1 FAMS @F1@\n", "1 DEAT\n2 DATE 1900\n1 FAMS @F1@\n1 FAMC @F2@\n")
      .replace(
        "0 TRLR\n",
        "0 @I5@ INDI\n1 NAME Alojz /Oblak/\n1 SEX M\n1 BIRT\n2 DATE 1820\n1 DEAT\n2 DATE 1890\n1 FAMS @F2@\n" +
          "0 @I6@ INDI\n1 NAME Roza /Kalan/\n1 SEX F\n1 BIRT\n2 DATE 1825\n1 DEAT\n2 DATE 1895\n1 FAMS @F2@\n" +
          "0 @F2@ FAM\n1 HUSB @I5@\n1 WIFE @I6@\n1 CHIL @I2@\n0 TRLR\n",
      );
    const d = reportOf(withParents, "@I1@");
    const g = childGroups(d);
    const r = rootEntry(d);
    const en = narrativeParagraph(tEn, narrativeLangFor("en"), r, planEntry(r, g.get(r.num)));
    expect(en).toContain(
      "He married Marija Oblak (1846–1900) on 4 February 1866 in Škofja Loka. " +
        "Her parents were Alojz Oblak and Roza Kalan. " +
        "They had 2 children:",
    );
    const slText = narrativeParagraph(tSl, narrativeLangFor("sl"), r, planEntry(r, g.get(r.num)));
    expect(slText).toContain(
      "Njegova žena je bila Marija Oblak (1846–1900); poročila sta se 4. februarja 1866 v kraju Škofja Loka. " +
        "Njena starša sta bila Alojz Oblak in Roza Kalan. " +
        "Imela sta 2 otroka:",
    );
  });

  it("uses feminine forms for a female subject", () => {
    // Ana is generation 1, first child.
    const ana = data.generations[1].entries.find((e) => e.id === "@I3@")!;
    const text = paragraph(tSl, "sl", ana);
    expect(text).toBe("Ana Novak se je rodila leta 1867. Umrla je leta 1940.");
  });

  it("always names a person of unknown sex and falls back to the /-a forms", () => {
    const noSex = FAMILY.replace("1 NAME Franc /Novak/\n1 SEX M\n", "1 NAME Franc /Novak/\n");
    const d = reportOf(noSex, "@I1@");
    const text = paragraph(tSl, "sl", rootEntry(d));
    expect(text).toContain("Franc Novak se je rodil/-a 5. maja 1848");
    expect(text).toContain("Franc Novak je umrl/-a");
  });

  it("gives the ahnentafel root their own marriage (their spouse is no ancestor)", () => {
    const ds = dataset(LIVING);
    const anc = buildAhnentafel(ds, "@I1@", nameOf, 2026)!;
    const root = anc.generations[0].entries[0];
    expect(root.facts.some((f) => f.tag === "MARR")).toBe(true);
    const text = narrativeParagraph(tSl, narrativeLangFor("sl"), root, planEntry(root, childGroups(anc).get(root.num)));
    // Present tense (both living), no children sentence (ancestors direction).
    expect(text).toContain("Njegova žena je Silvija Sekušak (1976); poročila sta se 18. aprila 1998");
    expect(text).not.toContain("otrok");
  });

  it("feeds the ahnentafel too (marriage on the father's entry, no children sentences)", () => {
    const ds = dataset(FAMILY);
    const anc = buildAhnentafel(ds, "@I3@", nameOf, NOW)!;
    const father = anc.generations[1].entries.find((e) => e.id === "@I1@")!;
    const plan = planEntry(father, childGroups(anc).get(father.num));
    expect(plan.map((s) => s.kind)).toEqual(["bornBaptized", "married", "diedBuried"]);
    expect(narrativeParagraph(tEn, narrativeLangFor("en"), father, plan)).toContain(
      "He married Marija Oblak on 4 February 1866",
    );
  });
});

// Luka (M, living): unspaced and duplicated place hierarchy, three dated
// residences with street addresses, a living wife and two living children —
// the fixture behind the place-cleanup, variation-ladder and tense rules.
const LIVING = wrap(
  "0 @I1@ INDI\n1 NAME Luka /Renko/\n1 SEX M\n1 BIRT\n2 DATE 16 MAR 1974\n2 PLAC Kranj,Kranj,Slovenia\n" +
    "1 RESI\n2 DATE 1974\n2 PLAC Stražišče,Kranj,Slovenia\n2 ADDR Hafnarjeva pot 21a\n" +
    "1 RESI\n2 DATE OCT 1997\n2 PLAC Ljubljana,Ljubljana,Slovenia\n2 ADDR Cesta v Pečale 50\n" +
    "1 RESI\n2 DATE JUN 2014\n2 PLAC Ljubljana,Ljubljana,Slovenia\n2 ADDR Ulica bratov Martinec 12\n" +
    "1 FAMS @F1@\n" +
    "0 @I2@ INDI\n1 NAME Silvija /Sekušak/\n1 SEX F\n1 BIRT\n2 DATE 1976\n1 FAMS @F1@\n" +
    "0 @I3@ INDI\n1 NAME Živa /Renko/\n1 SEX F\n1 BIRT\n2 DATE 1999\n1 FAMC @F1@\n" +
    "0 @I4@ INDI\n1 NAME Hana /Renko/\n1 SEX F\n1 BIRT\n2 DATE 2001\n1 FAMC @F1@\n" +
    "0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n1 CHIL @I3@\n1 CHIL @I4@\n1 MARR\n2 DATE 18 APR 1998\n2 PLAC Stražišče,Kranj,Slovenia\n",
);

describe("living people, addresses and repeated residences", () => {
  const data = buildDescendants(dataset(LIVING), "@I1@", nameOf, 2026, { residence: true })!;
  const groups = childGroups(data);
  const root = rootEntry(data);
  const plan = planEntry(root, groups.get(root.num));
  const paragraph = (t: Translate, lng: "en" | "sl") =>
    narrativeParagraph(t, narrativeLangFor(lng), root, plan);

  it("climbs the residence variation ladder (plain → then → finally)", () => {
    expect(plan.filter((s) => s.kind === "residence").map((s) => s.variant)).toEqual([
      undefined,
      "then",
      "finally",
    ]);
  });

  it("keeps the present tense and tidies places in Slovenian", () => {
    expect(paragraph(tSl, "sl")).toBe(
      "Luka Renko se je rodil 16. marca 1974 v kraju Kranj, Slovenia. " +
        "Njegova žena je Silvija Sekušak (1976); poročila sta se 18. aprila 1998 v kraju Stražišče, Kranj, Slovenia. " +
        "Imata 2 otroka: Živa Renko in Hana Renko. " +
        "Živel je leta 1974 na naslovu Hafnarjeva pot 21a, Stražišče, Kranj, Slovenia. " +
        "Pozneje je živel oktobra 1997 na naslovu Cesta v Pečale 50, Ljubljana, Slovenia. " +
        "Nazadnje je živel junija 2014 na naslovu Ulica bratov Martinec 12, Ljubljana, Slovenia.",
    );
  });

  it("keeps the present tense and tidies places in English", () => {
    expect(paragraph(tEn, "en")).toBe(
      "Luka Renko was born on 16 March 1974 in Kranj, Slovenia. " +
        "He married Silvija Sekušak (1976) on 18 April 1998 in Stražišče, Kranj, Slovenia. " +
        "They have 2 children: Živa Renko and Hana Renko. " +
        "He lived in 1974 at Hafnarjeva pot 21a, Stražišče, Kranj, Slovenia. " +
        "He later lived in October 1997 at Cesta v Pečale 50, Ljubljana, Slovenia. " +
        "He last lived in June 2014 at Ulica bratov Martinec 12, Ljubljana, Slovenia.",
    );
  });

  it("keeps living parents in the present tense, and privacy drops years and living parents", () => {
    const withParents = LIVING
      .replace("1 NAME Silvija /Sekušak/\n1 SEX F\n1 BIRT\n2 DATE 1976\n1 FAMS @F1@\n", "1 NAME Silvija /Sekušak/\n1 SEX F\n1 BIRT\n2 DATE 1976\n1 FAMS @F1@\n1 FAMC @F2@\n")
      .replace(
        "0 TRLR\n",
        "0 @I5@ INDI\n1 NAME Ivan /Sekušak/\n1 SEX M\n1 BIRT\n2 DATE 1950\n1 FAMS @F2@\n" +
          "0 @I6@ INDI\n1 NAME Vera /Horvat/\n1 SEX F\n1 BIRT\n2 DATE 1952\n1 FAMS @F2@\n" +
          "0 @F2@ FAM\n1 HUSB @I5@\n1 WIFE @I6@\n1 CHIL @I2@\n0 TRLR\n",
      );
    const d = buildDescendants(dataset(withParents), "@I1@", nameOf, 2026)!;
    const g = childGroups(d);
    const r = rootEntry(d);
    const open = narrativeParagraph(tSl, narrativeLangFor("sl"), r, planEntry(r, g.get(r.num)));
    // Both parents presumed living: the origin sentence stays in the present.
    expect(open).toContain("Njegova žena je Silvija Sekušak (1976); poročila sta se");
    expect(open).toContain("Njena starša sta Ivan Sekušak in Vera Horvat.");
    // Privacy: the living wife keeps her name but loses the years, and her
    // living parents' names stay out — the origin sentence disappears whole.
    const priv = narrativeParagraph(tSl, narrativeLangFor("sl"), r, planEntry(r, g.get(r.num), { privacyLiving: true }));
    expect(priv).toContain("Njegova žena je Silvija Sekušak; poročila sta se");
    expect(priv).not.toContain("starša");
  });

  it("returns to the past tense once the spouse is deceased", () => {
    const widowed = LIVING.replace(
      "1 NAME Silvija /Sekušak/\n1 SEX F\n1 BIRT\n2 DATE 1976\n",
      "1 NAME Silvija /Sekušak/\n1 SEX F\n1 BIRT\n2 DATE 1976\n1 DEAT\n2 DATE 2020\n",
    );
    const d = buildDescendants(dataset(widowed), "@I1@", nameOf, 2026)!;
    const r = rootEntry(d);
    const text = narrativeParagraph(tSl, narrativeLangFor("sl"), r, planEntry(r, childGroups(d).get(r.num)));
    expect(text).toContain("Njegova žena je bila Silvija Sekušak");
    expect(text).toContain("Imela sta 2 otroka");
  });
});

// Sourced and noted events: a person source, a paged birth citation with a
// short note, a baptism with an AGNC, and a death with CAUS + a long note.
const SOURCED = wrap(
  "0 @I1@ INDI\n1 NAME Franc /Novak/\n1 SEX M\n1 SOUR @S1@\n1 NOTE Rodbina iz Poljanske doline.\n" +
    "1 BIRT\n2 DATE 5 MAY 1848\n2 SOUR @S1@\n3 PAGE 23\n2 NOTE Born at home.\n" +
    "1 BAPM\n2 DATE 7 MAY 1848\n2 AGNC Župnija Stražišče\n" +
    "1 DEAT\n2 DATE 1912\n2 CAUS pljučnica\n2 SOUR @S2@\n3 PAGE 114\n2 NOTE Selil se je večkrat.\n3 CONT Podrobnosti v arhivu.\n" +
    "0 @S1@ SOUR\n1 TITL Krstna knjiga\n" +
    "0 @S2@ SOUR\n1 TITL Mrliška knjiga\n",
);

describe("notes and sources in the narrative", () => {
  const data = buildDescendants(dataset(SOURCED), "@I1@", nameOf, NOW, { notes: true, sources: true })!;
  const root = rootEntry(data);
  const nt = (t: Translate, lng: "en" | "sl") =>
    narrativeEntry(t, narrativeLangFor(lng), root, planEntry(root, childGroups(data).get(root.num)));

  it("marks sentences with superscript footnotes, weaves short notes in, numbers long ones", () => {
    const en = nt(tEn, "en");
    expect(en.paragraph).toBe(
      "Franc Novak was born on 5 May 1848 and baptized on 7 May 1848 at Župnija Stražišče.¹ ² (Born at home.) " +
        "He died in 1912 (cause: pljučnica).³ ⁴",
    );
    // Record-level source first (¹), the paged birth citation (²), the death
    // citation (³), then the multi-line death note as a footnote (⁴).
    expect(en.footnotes).toEqual([
      { source: { text: "§ Krstna knjiga", page: undefined, url: undefined } },
      { source: { text: "§ Krstna knjiga", page: "23", url: undefined } },
      { source: { text: "§ Mrliška knjiga", page: "114", url: undefined } },
      { note: "Selil se je večkrat.\nPodrobnosti v arhivu." },
    ]);
  });

  it("phrases agency and cause in Slovenian frames", () => {
    expect(nt(tSl, "sl").paragraph).toBe(
      "Franc Novak se je rodil 5. maja 1848, krščen je bil 7. maja 1848 (Župnija Stražišče).¹ ² (Born at home.) " +
        "Umrl je leta 1912 (vzrok: pljučnica).³ ⁴",
    );
  });

  it("gives a repeat citation its first number", () => {
    const twice = SOURCED.replace("2 SOUR @S2@\n3 PAGE 114\n", "2 SOUR @S1@\n3 PAGE 23\n");
    const d = buildDescendants(dataset(twice), "@I1@", nameOf, NOW, { sources: true })!;
    const r = rootEntry(d);
    const e = narrativeEntry(tEn, narrativeLangFor("en"), r, planEntry(r, childGroups(d).get(r.num)));
    expect(e.footnotes).toHaveLength(2); // person source + the one paged citation
    expect(e.paragraph).toContain("at Župnija Stražišče.¹ ²");
    expect(e.paragraph).toContain("He died in 1912 (cause: pljučnica).²");
  });

  it("labels the cited page in the report language", () => {
    expect(sourceLabel(tEn, { text: "§ Krstna knjiga", page: "23" })).toBe("§ Krstna knjiga, page 23");
    expect(sourceLabel(tSl, { text: "§ Krstna knjiga", page: "23" })).toBe("§ Krstna knjiga, stran 23");
  });
});

describe("reportToText narrative style", () => {
  it("replaces the glyph fact lines with the paragraph and numbers the citations", () => {
    const data = buildDescendants(dataset(SOURCED), "@I1@", nameOf, NOW, { notes: true, sources: true })!;
    const groups = childGroups(data);
    const lang = narrativeLangFor("en");
    const text = reportToText(tEn, data, "descendants", "Title", {
      narrativeOf: (e) => narrativeEntry(tEn, lang, e, planEntry(e, groups.get(e.num))),
    });
    expect(text).toContain("Franc Novak was born on 5 May 1848");
    // Person-level notes and sources: the note as its own block under the
    // paragraph, the source as footnote ¹ on the opening sentence.
    expect(text).toContain("Rodbina iz Poljanske doline.");
    expect(text).toContain("¹ § Krstna knjiga");
    expect(text).toContain("² § Krstna knjiga, page 23");
    expect(text).toContain("⁴ Selil se je večkrat.");
    expect(text).not.toContain("⚭");
  });
});
