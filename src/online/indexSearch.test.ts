import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { inferMainProfile } from "../normalize/profile";
import { normalizeDataset } from "../normalize/normalize";
import { validateConformance } from "../tools/conformance/conformance";
import { hitGedcom, hitXref, hitsDataset, indexApiUrl, indexPersonUrl, rankHits, type IndexHit } from "./indexSearch";
import { personQuery, searchUrl } from "./searchLinks";

const enc = (text: string) => new TextEncoder().encode(text).buffer;
const parse = (text: string) => buildDataset(parseGedcom(enc(text)));

const MAIN = `0 HEAD
1 GEDC
2 VERS 5.5.1
2 FORM LINEAGE-LINKED
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Janez /Penko/
1 SEX M
1 BIRT
2 DATE 4 MAY 1862
2 PLAC Petelinje, Kranjska
0 @I2@ INDI
1 NAME Jožef /Novak/
1 DEAT
2 DATE ABT 1900
0 @I3@ INDI
1 NAME Marija /Kos/
1 FAMS @F1@
0 @I4@ INDI
1 NAME Ana /Kos/
1 BIRT
2 DATE 1801
1 FAMC @F1@
0 @F1@ FAM
1 WIFE @I3@
1 CHIL @I4@
0 TRLR
`;

const PENKO: IndexHit = {
  id: 14331347,
  ext_id: "@I19364@",
  contributor: "Bandelj",
  name: "Janez",
  surname: "Penko",
  alt_surname: "",
  sex: "m",
  date_of_birth: "4 MAY 1862",
  place_of_birth: "Petelinje, Vojvodina Kranjska",
  date_of_death: "5 APR 1927",
  place_of_death: "Petelinje",
  parents_list: [
    { id: "@I19012@", sex: "m", name: "Jurij", surname: "Penko", date_of_birth: "11 APR 1820" },
    { id: "@I18998@", sex: "f", name: "Jožefa", surname: "Čelhar", date_of_birth: "11 FEB 1831" },
  ],
  partners_list: [{ id: "@I19369@", sex: "f", name: "Marija", surname: "Penko", date_of_birth: "23 AUG 1865" }],
  links: null,
};

const BENKO: IndexHit = {
  id: 21072134,
  ext_id: "eb4c3216",
  contributor: "Markovič-matricula",
  name: "Ivan",
  surname: "Benko",
  date_of_birth: "6 JUN 1760",
  place_of_birth: "Beltinci, Dokležovje",
  date_of_baptism: "6 JUN 1760",
  parents_list: [
    { sex: "m", name: "Jurij", surname: "Benko", date_of_birth: "" },
    { sex: "f", name: "Agata", surname: "Janči", date_of_birth: "" },
  ],
  partners_list: null,
  links: ["https://data.matricula-online.eu/sl/slovenia/maribor/beltinci/00050/?pg=1"],
};

describe("personQuery", () => {
  const ds = parse(MAIN);
  it("takes the name, a two-year birth window and the birth village", () => {
    expect(personQuery(ds.individuals.get("@I1@")!, ds)).toEqual({
      given: "Janez", surname: "Penko", birthFrom: 1860, birthTo: 1864, birthPlace: "Petelinje",
    });
  });
  it("falls back to a wider death window for an approximate death", () => {
    expect(personQuery(ds.individuals.get("@I2@")!, ds)).toMatchObject({ deathFrom: 1895, deathTo: 1905 });
  });
  it("estimates a birth window from relatives when nothing is dated", () => {
    const q = personQuery(ds.individuals.get("@I3@")!, ds)!;
    expect(q.birthFrom).toBeLessThan(1801);
    expect(q.birthTo).toBeGreaterThan(1760);
  });
});

describe("search addresses", () => {
  const q = { given: "Janez", surname: "Penko", birthFrom: 1860, birthTo: 1864, birthPlace: "Petelinje" };
  it("asks the API for name and years, never the place", () => {
    const url = new URL(indexApiUrl(q));
    expect(url.searchParams.get("surname")).toBe("Penko");
    expect(url.searchParams.get("date_of_birth")).toBe("1860");
    expect(url.searchParams.get("date_of_birth_to")).toBe("1864");
    expect(url.searchParams.has("place_of_birth")).toBe(false);
  });
  it("prefills each site", () => {
    expect(searchUrl("familysearchTree", q)).toContain("/search/tree/results?q.givenName=Janez&q.surname=Penko&q.birthLikeDate.from=1860");
    expect(searchUrl("familysearchRecords", q)).toContain("/search/record/results?");
    expect(searchUrl("geni", q)).toBe("https://www.geni.com/search?search_type=people&names=Janez+Penko");
    expect(searchUrl("wikitree", q)).toBe("https://www.wikitree.com/index.php?title=Special%3ASearchPerson&wpFirst=Janez&wpLast=Penko");
    expect(searchUrl("index", q)).toBe("https://indeks.rodoslovje.si/?t=person&n=Janez&sn=Penko&dob=1860&dobt=1864&ex=0");
  });
  it("links a hit to its own index page", () => {
    expect(indexPersonUrl(PENKO)).toBe("https://indeks.rodoslovje.si/?t=person&n=Janez&sn=Penko&id=%40I19364%40&c=Bandelj&ex=1");
  });
});

describe("hit records", () => {
  it("builds the person with parents, partner and links", () => {
    const ds = hitsDataset([PENKO, BENKO]);
    const penko = ds.individuals.get(hitXref(0))!;
    expect(penko.childOf).toHaveLength(1);
    expect(penko.spouseOf).toHaveLength(1);
    const parents = ds.families.get(penko.childOf[0])!;
    expect(ds.individuals.get(parents.husband!)!.names[0].given).toBe("Jurij");
    expect(ds.individuals.get(parents.wife!)!.names[0].given).toBe("Jožefa");
    const spouseFam = ds.families.get(penko.spouseOf[0])!;
    expect(spouseFam.husband).toBe(penko.id);
    expect(penko.links).toContain(indexPersonUrl(PENKO));
    const benko = ds.individuals.get(hitXref(1))!;
    expect(benko.events.map((e) => e.tag)).toEqual(["BIRT", "CHR"]);
  });

  it("ranks the matching person first", () => {
    const main = parse(MAIN);
    const ranked = rankHits(main.individuals.get("@I1@")!, main, [BENKO, PENKO]);
    expect(ranked.map((r) => r.hit.id)).toEqual([PENKO.id, BENKO.id]);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it("writes a compare file that reads back", () => {
    const back = parse(hitGedcom(PENKO));
    expect(back.individuals.size).toBe(4);
    expect(back.families.size).toBe(2);
  });

  for (const version of ["5.5.1", "7.0"] as const) {
    it(`normalizes to valid ${version} lines`, () => {
      const form = version === "5.5.1" ? "2 FORM LINEAGE-LINKED\n1 CHAR UTF-8\n" : "";
      const head = `0 HEAD\n1 GEDC\n2 VERS ${version}\n${form}1 SOUR test\n`;
      const main = parse(`${head}0 TRLR\n`);
      for (const hit of [PENKO, BENKO]) {
        const { dataset: out } = normalizeDataset(parse(hitGedcom(hit)), inferMainProfile(main));
        expect(validateConformance({ records: [main.records[0], ...out.records.filter((r) => r.tag !== "HEAD")] })).toEqual([]);
      }
    });
  }
});
