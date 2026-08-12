import { describe, expect, it } from "vitest";
import {
  AddressCollector,
  readStoredIndex,
  scopeToParents,
  searchBucket,
  streetKey,
  type AddressBucket,
} from "./addressRegister";
import {
  parseAddressMember,
  parseAdminUnitNames,
  parsePostalDescriptors,
  parseThoroughfareNames,
} from "./hrAd";

// Fixtures cut down from the real INSPIRE download — the same element order and
// namespaces, with the boilerplate a member carries but this parser ignores
// (lifespan dates, nil-reason spellings) left in, since that is what it has to
// read past.

const ADMIN_UNITS = `<?xml version="1.0" encoding="UTF-8"?><wfs:FeatureCollection>
<wfs:member><ad:AdminUnitName gml:id="AdminUnitName.5000585"><ad:inspireId><base:Identifier><base:localId>NA.0005000585</base:localId></base:Identifier></ad:inspireId><ad:name><gn:GeographicalName><gn:spelling><gn:SpellingOfName><gn:text>Andraševec</gn:text><gn:script>Latn</gn:script></gn:SpellingOfName></gn:spelling></gn:GeographicalName></ad:name><ad:level xlink:href="http://inspire.ec.europa.eu/codelist/AdministrativeHierarchyLevel/4thOrder" xlink:title="4thOrder"/></ad:AdminUnitName></wfs:member>
<wfs:member><ad:AdminUnitName gml:id="AdminUnitName.5000900"><ad:name><gn:GeographicalName><gn:spelling><gn:SpellingOfName><gn:text>Bapča</gn:text></gn:SpellingOfName></gn:spelling></gn:GeographicalName></ad:name><ad:level xlink:href="http://inspire.ec.europa.eu/codelist/AdministrativeHierarchyLevel/4thOrder" xlink:title="4thOrder"/></ad:AdminUnitName></wfs:member>
<wfs:member><ad:AdminUnitName gml:id="AdminUnitName.2196271073"><ad:name><gn:GeographicalName><gn:spelling><gn:SpellingOfName><gn:text>Republika Hrvatska</gn:text></gn:SpellingOfName></gn:spelling></gn:GeographicalName></ad:name><ad:level xlink:href="http://inspire.ec.europa.eu/codelist/AdministrativeHierarchyLevel/1stOrder" xlink:title="1stOrder"/></ad:AdminUnitName></wfs:member>
</wfs:FeatureCollection>`;

const STREETS = `<wfs:FeatureCollection>
<wfs:member><ad:ThoroughfareName gml:id="ThoroughfareName.2156774419"><ad:name><ad:ThoroughfareNameValue><ad:name><gn:GeographicalName><gn:spelling><gn:SpellingOfName><gn:text>Brežna ulica</gn:text></gn:SpellingOfName></gn:spelling></gn:GeographicalName></ad:name></ad:ThoroughfareNameValue></ad:name></ad:ThoroughfareName></wfs:member>
<wfs:member><ad:ThoroughfareName gml:id="ThoroughfareName.2156774454"><ad:name><ad:ThoroughfareNameValue><ad:name><gn:GeographicalName><gn:spelling><gn:SpellingOfName><gn:text>Kamenjačka ulica</gn:text></gn:SpellingOfName></gn:spelling></gn:GeographicalName></ad:name></ad:ThoroughfareNameValue></ad:name></ad:ThoroughfareName></wfs:member>
<wfs:member><ad:ThoroughfareName gml:id="ThoroughfareName.9000001"><ad:name><ad:ThoroughfareNameValue><ad:name><gn:GeographicalName><gn:spelling><gn:SpellingOfName><gn:text>Bapča</gn:text></gn:SpellingOfName></gn:spelling></gn:GeographicalName></ad:name></ad:ThoroughfareNameValue></ad:name></ad:ThoroughfareName></wfs:member>
</wfs:FeatureCollection>`;

const POSTS = `<wfs:FeatureCollection>
<wfs:member><ad:PostalDescriptor gml:id="PostalDescriptor.2136004769"><ad:postName><gn:GeographicalName><gn:spelling><gn:SpellingOfName><gn:text>Oroslavje</gn:text></gn:SpellingOfName></gn:spelling></gn:GeographicalName></ad:postName><ad:postCode>49243</ad:postCode></ad:PostalDescriptor></wfs:member>
<wfs:member><ad:PostalDescriptor gml:id="PostalDescriptor.2136004999"><ad:postName><gn:GeographicalName><gn:spelling><gn:SpellingOfName><gn:text>Velika Gorica</gn:text></gn:SpellingOfName></gn:spelling></gn:GeographicalName></ad:postName><ad:postCode>10410</ad:postCode></ad:PostalDescriptor></wfs:member>
</wfs:FeatureCollection>`;

/** One `ad:Address` member, as the register writes it. `pos` is northing then
 *  easting, which is the axis order the CRS declares. */
function addressMember(opts: {
  id: number;
  north: number;
  east: number;
  designators: [string, string][];
  streetId: number;
  postId: number;
  settlementId: number;
}): string {
  const locators = opts.designators
    .map(
      ([value, type]) =>
        `<ad:designator><ad:LocatorDesignator><ad:designator>${value}</ad:designator><ad:type xlink:href="http://inspire.ec.europa.eu/codelist/LocatorDesignatorTypeValue/${type}" xlink:title="${type}"/></ad:LocatorDesignator></ad:designator>`,
    )
    .join("");
  return (
    `<wfs:member><ad:Address gml:id="Address.${opts.id}">` +
    `<ad:position><ad:GeographicPosition><ad:geometry><gml:Point gml:id="gad.${opts.id}" srsDimension="2" srsName="http://www.opengis.net/def/crs/EPSG/0/3035">` +
    `<gml:pos>${opts.north} ${opts.east}</gml:pos></gml:Point></ad:geometry>` +
    `<ad:specification xsi:nil="true" nilReason="other:unpopulated"/><ad:default>true</ad:default></ad:GeographicPosition></ad:position>` +
    `<ad:locator><ad:AddressLocator>${locators}<ad:level xlink:href="http://inspire.ec.europa.eu/codelist/LocatorLevelValue/siteLevel"/></ad:AddressLocator></ad:locator>` +
    `<ad:component xlink:href="#ThoroughfareName.${opts.streetId}"/>` +
    `<ad:component xlink:href="#PostalDescriptor.${opts.postId}"/>` +
    `<ad:component xlink:href="#AdminUnitName.${opts.settlementId}"/>` +
    `<ad:component xlink:href="#AdminUnitName.2196271073"/>` +
    `</ad:Address></wfs:member>`
  );
}

const settlements = parseAdminUnitNames(ADMIN_UNITS);
const streets = parseThoroughfareNames(STREETS);
const posts = parsePostalDescriptors(POSTS);
const TABLES = { settlements, streets, posts };

describe("parsing the register's side tables", () => {
  it("keeps the settlements and leaves the country out", () => {
    // Both are AdminUnitName features; only the 4th-order ones are villages,
    // and that is what decides which of an address's two links is its own.
    expect([...settlements.values()]).toEqual(["Andraševec", "Bapča"]);
    expect(settlements.has(2196271073)).toBe(false);
  });

  it("reads street names and post lines", () => {
    expect(streets.get(2156774419)).toBe("Brežna ulica");
    expect(posts.get(2136004769)).toEqual({ line: "49243 Oroslavje", name: "Oroslavje" });
  });
});

describe("parseAddressMember", () => {
  const parse = (member: string) => parseAddressMember(member, TABLES);

  it("reads a town address, projecting its position", () => {
    const row = parse(
      addressMember({
        id: 1,
        north: 2561799.19395499,
        east: 4781765.61686003,
        designators: [["33", "addressNumber"]],
        streetId: 2156774419,
        postId: 2136004769,
        settlementId: 5000585,
      }),
    );
    expect(row).toMatchObject({ settlementId: "5000585", settlement: "Andraševec", street: "Brežna ulica", post: "49243 Oroslavje", number: 33, ext: "", ext2: 0 });
    expect(row?.lat).toBeCloseTo(46.00325, 4);
    expect(row?.lon).toBeCloseTo(15.94829, 4);
  });

  it("reads both number extensions", () => {
    const letter = parse(
      addressMember({
        id: 2,
        north: 2561799,
        east: 4781765,
        designators: [
          ["45", "addressNumber"],
          ["A", "addressNumberExtension"],
        ],
        streetId: 2156774419,
        postId: 2136004769,
        settlementId: 5000585,
      }),
    );
    expect(letter).toMatchObject({ number: 45, ext: "a", ext2: 0 });

    const second = parse(
      addressMember({
        id: 3,
        north: 2561799,
        east: 4781765,
        designators: [
          ["22", "addressNumber"],
          ["1", "addressNumber2ndExtension"],
        ],
        streetId: 9000001,
        postId: 2136004999,
        settlementId: 5000900,
      }),
    );
    expect(second).toMatchObject({ number: 22, ext: "", ext2: 1 });
  });

  it("drops a row it cannot place", () => {
    // A position outside the country the register covers — a mis-read pos, or
    // the axis order taken the wrong way round.
    expect(
      parse(
        addressMember({
          id: 4,
          north: 4781765.61686003,
          east: 2561799.19395499,
          designators: [["33", "addressNumber"]],
          streetId: 2156774419,
          postId: 2136004769,
          settlementId: 5000585,
        }),
      ),
    ).toBeUndefined();
    // A member naming no settlement this register knows.
    expect(
      parse(
        addressMember({
          id: 5,
          north: 2561799,
          east: 4781765,
          designators: [["1", "addressNumber"]],
          streetId: 2156774419,
          postId: 2136004769,
          settlementId: 999999,
        }),
      ),
    ).toBeUndefined();
    expect(parse("<wfs:member><ad:Address gml:id=\"Address.6\"/></wfs:member>")).toBeUndefined();
  });
});

/** Build the buckets a list of members collects into. */
function bucketsOf(members: string[]): AddressBucket[] {
  const collector = new AddressCollector("HR");
  for (const m of members) {
    const row = parseAddressMember(m, TABLES);
    if (row) collector.add(row);
  }
  return collector.buckets();
}

const ANDRASEVEC = bucketsOf([
  addressMember({ id: 1, north: 2561799, east: 4781765, designators: [["33", "addressNumber"]], streetId: 2156774419, postId: 2136004769, settlementId: 5000585 }),
  addressMember({ id: 2, north: 2561850, east: 4781700, designators: [["33", "addressNumber"]], streetId: 2156774454, postId: 2136004769, settlementId: 5000585 }),
  addressMember({ id: 3, north: 2561900, east: 4781600, designators: [["45", "addressNumber"], ["A", "addressNumberExtension"]], streetId: 2156774419, postId: 2136004769, settlementId: 5000585 }),
  addressMember({ id: 4, north: 2561950, east: 4781500, designators: [["45", "addressNumber"]], streetId: 2156774419, postId: 2136004769, settlementId: 5000585 }),
])[0];

const BAPCA = bucketsOf([
  addressMember({ id: 5, north: 2530000, east: 4790000, designators: [["22", "addressNumber"], ["1", "addressNumber2ndExtension"]], streetId: 9000001, postId: 2136004999, settlementId: 5000900 }),
])[0];

describe("searchBucket", () => {
  it("narrows a number to the street the file names", () => {
    const hits = searchBucket(ANDRASEVEC, { number: 33, street: "Brežna ulica" });
    expect(hits.map((h) => h.address)).toEqual(["Brežna ulica 33"]);
    expect(hits[0].label).toBe("Brežna ulica 33, Andraševec, 49243 Oroslavje");
  });

  it("matches an abbreviated street as a prefix", () => {
    expect(searchBucket(ANDRASEVEC, { number: 33, street: "Brežna" }).map((h) => h.address)).toEqual([
      "Brežna ulica 33",
    ]);
  });

  it("sees through the street-type word either side writes", () => {
    // Vrbovsko has exactly two houses numbered 75 — Senjsko 75 and Ivana Gorana
    // Kovačića 75 — and a file writing "Ul. Senjsko 75" used to match neither,
    // so the widest rung offered both. The type word identifies nothing.
    for (const street of ["Ul. Brežna", "Ulica Brežna", "Brežna ul."]) {
      expect(searchBucket(ANDRASEVEC, { number: 33, street }).map((h) => h.address)).toEqual([
        "Brežna ulica 33",
      ]);
    }
  });

  it("keeps a street named after nothing but a type word comparable", () => {
    // "Trg" and "Obala" are real street names; reduced to their identifying
    // words they are empty, so those are compared as written instead.
    expect(streetKey("Trg")).toBe("");
    expect(streetKey("Ul. Senjsko")).toBe("senjsko");
    expect(streetKey("Ivana Gorana Kovačića")).toBe("ivana gorana kovacica");
  });

  it("answers nothing for a street this settlement does not have", () => {
    // Andraševec numbers a 33 on two streets, and neither is Jamnička. A value
    // naming a street is not asking which house 33 is meant — it is saying the
    // house is somewhere this bucket does not describe, and offering another
    // street's 33 would both answer the row wrongly and hide the misfiling from
    // the compliance check. The ladder above reads the name as a settlement of
    // its own instead.
    expect(searchBucket(ANDRASEVEC, { number: 33, street: "Jamnička" })).toEqual([]);
  });

  it("offers every street's house when the file names no street", () => {
    // Andraševec has streets, so a bare "Andraševec 33" cannot say which house
    // is meant — both are offered rather than one picked arbitrarily.
    expect(searchBucket(ANDRASEVEC, { number: 33 }).map((h) => h.address).sort()).toEqual([
      "Brežna ulica 33",
      "Kamenjačka ulica 33",
    ]);
  });

  it("reads village numbering as the address it is", () => {
    // The register files these under a "street" named after the village; that
    // must not turn into "Bapča, Bapča" in the label.
    const hits = searchBucket(BAPCA, { number: 22 });
    expect(hits.map((h) => h.address)).toEqual(["Bapča 22/1"]);
    expect(hits[0].label).toBe("Bapča 22/1, 10410 Velika Gorica");
  });

  it("prefers the file's suffix and falls back to the bare number", () => {
    expect(searchBucket(ANDRASEVEC, { number: 45, suffix: "a", street: "Brežna" }).map((h) => h.address)).toEqual([
      "Brežna ulica 45a",
    ]);
    // The plain number means the plain number, not "45 and everything after it".
    expect(searchBucket(ANDRASEVEC, { number: 45, street: "Brežna" }).map((h) => h.address)).toEqual([
      "Brežna ulica 45",
    ]);
    // A suffix the register does not record still finds the house.
    expect(searchBucket(ANDRASEVEC, { number: 33, suffix: "b", street: "Brežna" }).map((h) => h.address)).toEqual([
      "Brežna ulica 33",
    ]);
  });

  it("finds nothing for a number the settlement does not have", () => {
    expect(searchBucket(ANDRASEVEC, { number: 999 })).toEqual([]);
  });
});

describe("scopeToParents", () => {
  const hits = searchBucket(ANDRASEVEC, { number: 33, street: "Brežna ulica" });
  const known = {
    parentNames: new Set(["oroslavje", "velika gorica", "metlika"]),
    settlementNames: new Set(["andrasevec", "bapca"]),
  };

  it("keeps hits whose post office the place names", () => {
    expect(scopeToParents(hits, ["Oroslavje"], known)).toEqual(hits);
  });

  it("keeps them when the parent is a level the register does not hold", () => {
    // A županija contradicts nothing — the register files no address under one.
    expect(scopeToParents(hits, ["Krapinsko-zagorska županija"], known)).toEqual(hits);
  });

  it("discards them when a parent the register knows says otherwise", () => {
    expect(scopeToParents(hits, ["Metlika"], known)).toEqual([]);
  });

  it("keeps everything when the place names no parent", () => {
    expect(scopeToParents(hits, undefined, known)).toEqual(hits);
  });
});

describe("readStoredIndex", () => {
  it("reads a register stored before Slovenia existed here", () => {
    // The first release held Croatia alone: the parent names were post offices
    // and were called that, and the settlement ids were numbers. Read strictly,
    // such a store threw on every lookup — an 85 MB download lost to a rename.
    const legacy = {
      country: "HR",
      count: 1681462,
      importedAt: 1000,
      settlements: [{ id: 5000585, name: "Andraševec", count: 24 }],
      postNames: ["Oroslavje"],
    };
    expect(readStoredIndex(legacy)).toEqual({
      country: "HR",
      count: 1681462,
      importedAt: 1000,
      settlements: [{ id: "5000585", name: "Andraševec", count: 24 }],
      parentNames: ["Oroslavje"],
    });
  });

  it("reads the current shape unchanged, and refuses what is not an index", () => {
    const current = {
      country: "SI" as const,
      count: 2,
      importedAt: 5,
      settlements: [{ id: "110300000100999436", name: "Kočevje", count: 2 }],
      parentNames: ["Kočevje"],
    };
    expect(readStoredIndex(current)).toEqual(current);
    expect(readStoredIndex(undefined)).toBeUndefined();
    expect(readStoredIndex({ country: "HR" })).toBeUndefined();
  });
});
