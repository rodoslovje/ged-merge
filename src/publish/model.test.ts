import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { buildPublishedTree, buildPublishedTreeSteps, defaultPublishOptions, type PublishOptions } from "./model";
import { hydrateTree, pubId } from "./hydrate";
import { inlineSafe, publishedHtml, scriptSafeJson, siteFileName } from "./page";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

const NOW = new Date("2026-06-01");

// I1 + I2 married (dead), children I3 (dead, married to in-law I5) and I4
// (living). I6 is I3's living daughter; I7 is flagged private; I8 is unrelated.
const SAMPLE = `0 HEAD
1 GEDC
2 VERS 5.5.1
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Jože /Novak/
1 SEX M
1 _UID ABC-123
1 BIRT
2 DATE 12 MAR 1880
2 PLAC Ljubljana, Slovenija
3 MAP
4 LATI N46.05
4 LONG E14.5
2 SOUR @S1@
1 OCCU kmet
1 DEAT
2 DATE 1950
2 CAUS pljučnica
1 NOTE A private research note
1 FAMS @F1@
0 @I2@ INDI
1 NAME Marija /Kranjc/
1 SEX F
1 BIRT
2 DATE 1885
1 DEAT
2 DATE 1960
1 FAMS @F1@
0 @I3@ INDI
1 NAME Janez /Novak/
1 SEX M
1 BIRT
2 DATE 1910
1 DEAT
2 DATE 1990
1 FAMC @F1@
1 FAMS @F2@
0 @I4@ INDI
1 NAME Ana /Novak/
1 SEX F
1 BIRT
2 DATE 1960
1 RESI
2 ADDR Slovenska cesta 1
1 FAMC @F1@
0 @I5@ INDI
1 NAME Mojca /Zupan/
1 SEX F
1 BIRT
2 DATE 1915
1 DEAT
2 DATE 1999
1 FAMS @F2@
0 @I6@ INDI
1 NAME Petra /Novak/
1 SEX F
1 BIRT
2 DATE 1950
1 FAMC @F2@
0 @I7@ INDI
1 NAME Skrita /Oseba/
1 RESN privacy
1 FAMC @F2@
0 @I8@ INDI
1 NAME Tujec /Drugi/
1 BIRT
2 DATE 1800
1 DEAT
2 DATE 1870
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 CHIL @I3@
1 CHIL @I4@
1 MARR
2 DATE 1905
2 PLAC Kranj
0 @F2@ FAM
1 HUSB @I3@
1 WIFE @I5@
1 CHIL @I6@
1 CHIL @I7@
0 @S1@ SOUR
1 TITL Matična knjiga
0 TRLR
`;

const ds = dataset(SAMPLE);
const opts = (over: Partial<PublishOptions> = {}): PublishOptions => ({ ...defaultPublishOptions("Rodbina Novak", "sl"), ...over });
const build = (over: Partial<PublishOptions> = {}, start = "@I1@") => buildPublishedTree(ds, opts(over), start, NOW);
const byName = (tree: ReturnType<typeof build>["tree"], given: string) => tree.people.find((p) => p.given === given);

describe("buildPublishedTree", () => {
  it("publishes names, events and families as display data only", () => {
    const { tree } = build({ living: "all" });
    const joze = byName(tree, "Jože")!;
    expect(joze).toMatchObject({ given: "Jože", surname: "Novak", sex: "M" });
    expect(joze.events).toEqual([
      { tag: "BIRT", date: "12 MAR 1880", place: "Ljubljana, Slovenija", lat: 46.05, lon: 14.5 },
      { tag: "OCCU", value: "kmet" },
      { tag: "DEAT", date: "1950", cause: "pljučnica" },
    ]);
    const json = JSON.stringify(tree);
    // No sources, notes, addresses, record ids or sync ids.
    for (const leak of ["Matična", "research note", "Slovenska cesta", "@I1@", "ABC-123", "@S1@"]) {
      expect(json).not.toContain(leak);
    }
    expect(tree.format).toBe("gedmerge-site");
    expect(tree.created).toBe("2026-06-01");
    expect(tree.start).toBe(joze.id);
  });

  it("gives stable opaque ids", () => {
    const a = build().tree;
    const b = build().tree;
    expect(a.people.map((p) => p.id)).toEqual(b.people.map((p) => p.id));
    expect(new Set(a.people.map((p) => p.id)).size).toBe(a.people.length);
    for (const p of a.people) expect(p.id).toMatch(/^p[0-9a-z]+$/);
  });

  it("keeps the opening page only when it has the person it needs", () => {
    expect(build().tree.startPage).toBeUndefined();
    expect(build({ startPage: "charts" }).tree.startPage).toBe("charts");
    expect(buildPublishedTree(ds, opts({ startPage: "person" }), undefined, NOW).tree.startPage).toBeUndefined();
    expect(buildPublishedTree(ds, opts({ startPage: "stats" }), undefined, NOW).tree.startPage).toBe("stats");
  });

  it("never publishes a person flagged private", () => {
    const { tree, summary } = build({ living: "all" });
    expect(byName(tree, "Skrita")).toBeUndefined();
    expect(summary.privateHidden).toBe(1);
  });

  it("reduces living people to their initials", () => {
    const { tree, summary } = build({ living: "initials" });
    const ana = tree.people.find((p) => p.living && p.given === "A.");
    expect(ana).toEqual({ id: ana!.id, given: "A.", surname: "N.", sex: "F", living: true });
    expect(summary.livingReduced).toBe(2);
  });

  it("keeps a living person's given name only", () => {
    const { tree } = build({ living: "given" });
    expect(byName(tree, "Ana")).toEqual({ id: byName(tree, "Ana")!.id, given: "Ana", sex: "F", living: true });
  });

  it("carries the export switch and the site's address", () => {
    expect(build().tree).not.toHaveProperty("exports");
    expect(build({ exports: true, url: " https://tree.example.org " }).tree).toMatchObject({ exports: true, url: "https://tree.example.org" });
  });

  it("keeps a living person's name only", () => {
    const { tree } = build({ living: "name" });
    expect(byName(tree, "Ana")).toMatchObject({ surname: "Novak", living: true });
    expect(byName(tree, "Ana")!.events).toBeUndefined();
  });

  it("leaves living people out, and their families when nothing links", () => {
    const { tree, summary } = build({ living: "hide" });
    expect(byName(tree, "Ana")).toBeUndefined();
    expect(byName(tree, "Petra")).toBeUndefined();
    expect(summary.livingHidden).toBe(2);
    // F2 still links Janez and Mojca.
    expect(tree.families).toHaveLength(2);
  });

  it("drops a living spouse's marriage unless details are published", () => {
    const living = dataset(SAMPLE.replace("2 DATE 1885\n1 DEAT\n2 DATE 1960", "2 DATE 1950"));
    const reduced = buildPublishedTree(living, opts(), "@I1@", NOW).tree;
    expect(reduced.families.find((f) => f.children?.length === 2 && f.events)).toBeUndefined();
    const full = buildPublishedTree(living, opts({ living: "all" }), "@I1@", NOW).tree;
    expect(full.families.some((f) => f.events?.[0]?.tag === "MARR")).toBe(true);
  });

  it("scopes to blood relatives, with or without partners", () => {
    const blood = build({ scope: "blood", partners: false }, "@I3@").tree;
    expect(blood.people.map((p) => p.given).sort()).toEqual(["A.", "Janez", "Jože", "Marija", "P."].sort());
    const withPartners = build({ scope: "blood", partners: true }, "@I3@").tree;
    expect(byName(withPartners, "Mojca")).toBeDefined();
    expect(byName(withPartners, "Tujec")).toBeUndefined();
  });

  it("scopes to the direct line", () => {
    const line = build({ scope: "line", partners: false, living: "all" }, "@I6@").tree;
    expect(line.people.map((p) => p.given).sort()).toEqual(["Janez", "Jože", "Marija", "Mojca", "Petra"]);
    expect(byName(line, "Ana")).toBeUndefined();
  });
});

describe("buildPublishedTreeSteps", () => {
  it("reports its progress and ends on the whole file", () => {
    const seen: [number, number][] = [];
    const steps = buildPublishedTreeSteps(ds, opts(), "@I1@", NOW, (done, total) => seen.push([done, total]));
    let r = steps.next();
    while (!r.done) r = steps.next();
    expect(r.value).toEqual(build());
    expect(seen.at(-1)).toEqual([18, 18]);
  });
});

describe("sources, notes and addresses", () => {
  const withAll = (over: Partial<PublishOptions["include"]>) =>
    build({ living: "all", include: { sources: false, notes: false, addresses: false, ...over } }).tree;

  it("stay out unless chosen", () => {
    const joze = byName(withAll({}), "Jože")!;
    expect(joze.notes).toBeUndefined();
    expect(joze.events![0].sources).toBeUndefined();
    expect(byName(withAll({}), "Ana")!.events!.find((e) => e.tag === "RESI")?.address).toBeUndefined();
  });

  it("go in when chosen", () => {
    const tree = withAll({ sources: true, notes: true, addresses: true });
    const joze = byName(tree, "Jože")!;
    expect(joze.notes).toEqual(["A private research note"]);
    expect(joze.events![0].sources).toEqual([{ title: "Matična knjiga" }]);
    expect(byName(tree, "Ana")!.events!.find((e) => e.tag === "RESI")?.address).toBe("Slovenska cesta 1");
    expect(tree.sources).toBe(true);
  });

  it("never publish a note marked private", () => {
    const hidden = dataset(SAMPLE.replace("1 NOTE A private research note", "1 NOTE A private research note\n2 RESN privacy"));
    const tree = buildPublishedTree(hidden, opts({ living: "all", include: { sources: false, notes: true, addresses: false } }), "@I1@", NOW).tree;
    expect(byName(tree, "Jože")!.notes).toBeUndefined();
  });

  // Kranj has its own coordinate; a birth at a Kranj house carries the
  // house's. Črni vrh has none, and its house sits inside the place value.
  const HOUSES = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 NAME Franc /Kos/
1 BIRT
2 DATE 1850
2 PLAC Kranj
3 MAP
4 LATI N46.24
4 LONG E14.35
1 DEAT
2 DATE 1910
2 PLAC Kranj
3 MAP
4 LATI N46.23912
4 LONG E14.35561
2 ADDR Glavni trg 1
0 @I2@ INDI
1 NAME Ana /Kos/
1 BIRT
2 DATE 1855
2 PLAC Črni vrh 35
3 MAP
4 LATI N45.94321
4 LONG E14.07654
1 DEAT
2 DATE 1920
0 TRLR
`;
  const houses = dataset(HOUSES);
  const site = (addresses: boolean) =>
    buildPublishedTree(houses, opts({ living: "all", include: { sources: false, notes: false, addresses } }), undefined, NOW).tree;

  it("show a house at its settlement when addresses stay out", () => {
    const tree = site(false);
    const franc = byName(tree, "Franc")!.events!;
    expect(franc[1]).toMatchObject({ place: "Kranj", lat: 46.24, lon: 14.35 });
    expect(franc[1].address).toBeUndefined();
    const ana = byName(tree, "Ana")!.events![0];
    expect(ana).toMatchObject({ place: "Črni vrh", lat: 45.94, lon: 14.08 });
  });

  it("show the house itself when addresses go in", () => {
    const tree = site(true);
    expect(byName(tree, "Franc")!.events![1]).toMatchObject({ place: "Kranj", address: "Glavni trg 1", lat: 46.23912, lon: 14.35561 });
    expect(byName(tree, "Ana")!.events![0]).toMatchObject({ place: "Črni vrh 35", lat: 45.94321 });
  });
});

describe("married surnames", () => {
  const wed = dataset(SAMPLE.replace("1 NAME Marija /Kranjc/", "1 NAME Marija /Kranjc/\n1 NAME /Novak/\n2 TYPE married"));
  it("are published with the name, and read back as married names", () => {
    const { tree } = buildPublishedTree(wed, opts({ living: "all" }), "@I1@", NOW);
    const marija = byName(tree, "Marija")!;
    expect(marija.married).toEqual(["Novak"]);
    const back = hydrateTree(tree).individuals.get(`@${marija.id}@`)!;
    expect(back.names[1]).toMatchObject({ surname: "Novak", type: "married" });
  });

  it("carry the author's display settings", () => {
    const display = { ...defaultPublishOptions("x", "sl").display, showAge: true, order: "surname-given" as const };
    expect(build({ display }).tree.display).toEqual(display);
  });
});

describe("hydrateTree", () => {
  it("reads the published data back as a dataset", () => {
    const { tree } = build({ living: "initials" });
    const back = hydrateTree(tree);
    expect(back.individuals.size).toBe(tree.people.length);
    const joze = byName(tree, "Jože")!;
    const indi = back.individuals.get(`@${joze.id}@`)!;
    expect(pubId(indi.id)).toBe(joze.id);
    expect(indi.names[0]).toMatchObject({ given: "Jože", surname: "Novak" });
    const birth = indi.events.find((e) => e.tag === "BIRT")!;
    expect(birth.date?.year).toBe(1880);
    expect(birth.place?.coord).toEqual({ lat: 46.05, lon: 14.5 });
    expect(indi.events.find((e) => e.tag === "DEAT")?.cause).toBe("pljučnica");
    expect(indi.spouseOf).toHaveLength(1);
    const fam = back.families.get(indi.spouseOf[0])!;
    expect(fam.children).toHaveLength(2);
    expect(fam.events[0]).toMatchObject({ tag: "MARR" });
  });
});

describe("publishedHtml", () => {
  it("embeds the data and the viewer so nothing can close a tag early", () => {
    const { tree } = build({ title: "Rodbina </script> & co", intro: { sl: "<b>hi</b>" } });
    const html = publishedHtml(tree, { js: 'const s = "</script>";', css: "a{}/*</style>*/" });
    expect(html).toContain("<title>Rodbina &lt;/script&gt; &amp; co</title>");
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(html.match(/<\/script>/g)).toHaveLength(3);
    expect(html.match(/<\/style>/g)).toHaveLength(1);
    const json = html.match(/<script type="application\/json"[^>]*>(.*?)<\/script>/s)![1];
    expect(JSON.parse(json).intro).toEqual({ sl: "<b>hi</b>" });
  });

  it("escapes helpers", () => {
    expect(scriptSafeJson({ a: "</script>\u2028" })).toBe('{"a":"\\u003c/script>\\u2028"}');
    expect(inlineSafe("x</SCRIPT>", "script")).toBe("x<\\/SCRIPT>");
    expect(siteFileName("Rodbina Žnidaršič")).toBe("rodbina-znidarsic.html");
    expect(siteFileName("")).toBe("family-tree.html");
  });
});
