import { describe, expect, it } from "vitest";
import { detectParishIndex, gedcomDate, parseAssociates, parseNotePerson, parseParishIndexCsv } from "./parishIndex";
import type { Dataset, GedNode } from "../gedcom/types";

// The published marriage indexes come in two widths: the later files give the
// bride an address column of her own, the earlier ones carry one address for
// the record. Both are exercised here.
const P_HEADER =
  "zp. št.;župnija;datum poroke;naslov;ime ženina;priimek ženina;alt. priimek ženina;" +
  "naslov neveste;ime neveste;priimek neveste;alt. priimek neveste;url naslov;opombe;interpret";
const P_NARROW_HEADER =
  "zp. št.;župnija;datum poroke;naslov;ime ženina;priimek ženina;alt. priimek ženina;" +
  "ime neveste;priimek neveste;alt. priimek neveste;url naslov;opombe;interpret";
const K_HEADER =
  "zp. št.;župnija;datum rojstva;datum krsta;naslov;ime otroka;alt.ime otroka;ime očeta;" +
  "priimek očeta;alt.priimek očeta;ime matere;priimek matere;alt.priimek matere;url naslov;opombe;interpret";

const MATRICULA = "https://data.matricula-online.eu/sl/slovenia/ljubljana/podzemelj/04455/?pg=2";

function csv(header: string, ...rows: string[]): string {
  return `﻿${[header, ...rows].join("\r\n")}\r\n`;
}

function parse(text: string): Dataset {
  const out = parseParishIndexCsv(text);
  expect(out).toBeTruthy();
  return out!.dataset;
}

/** The one individual whose primary name reads "<given> <surname>". */
function person(ds: Dataset, full: string): GedNode {
  const hits = [...ds.individuals.values()].filter(
    (i) => `${i.names[0]?.given ?? ""} ${i.names[0]?.surname ?? ""}`.trim() === full,
  );
  expect(hits.length, `individuals named ${full}`).toBe(1);
  return hits[0].raw;
}

function child(node: GedNode, tag: string): GedNode | undefined {
  return node.children.find((c) => c.tag === tag);
}

function values(node: GedNode, tag: string): string[] {
  return node.children.filter((c) => c.tag === tag).map((c) => c.value ?? "");
}

describe("detectParishIndex", () => {
  it("reads the marriage layout by column name, not position", () => {
    const layout = detectParishIndex(P_HEADER.split(";"));
    expect(layout?.kind).toBe("marriage");
    expect(layout?.index.groomSurname).toBe(5);
    expect(layout?.index.brideAddress).toBe(7);
  });

  it("reads the baptism layout", () => {
    const layout = detectParishIndex(K_HEADER.split(";"));
    expect(layout?.kind).toBe("baptism");
    expect(layout?.index.childGiven).toBe(5);
    expect(layout?.index.motherSurname).toBe(11);
  });

  it("accepts the columns a file happens not to have", () => {
    const layout = detectParishIndex(P_NARROW_HEADER.split(";"));
    expect(layout?.kind).toBe("marriage");
    expect(layout?.index.brideAddress).toBeUndefined();
  });

  it("takes 'alt. priimek', 'alt.priimek' and 'alt priimek' as one column", () => {
    for (const spelling of ["alt. priimek očeta", "alt.priimek očeta", "ALT  PRIIMEK OČETA"]) {
      const header = ["župnija", "datum krsta", "ime otroka", "priimek očeta", spelling];
      expect(detectParishIndex(header)?.index.fatherAltSurname).toBe(4);
    }
  });

  it("declines a header that is not a parish index", () => {
    expect(detectParishIndex(["Ime", "Priimek", "Datum rojstva"])).toBeUndefined();
    // The parish alone is not enough: the record's own names must be there too.
    expect(detectParishIndex(["župnija", "opombe"])).toBeUndefined();
  });

  it("leaves a non-index CSV to the other importers", () => {
    expect(parseParishIndexCsv("Ime,Priimek\nJanez,Novak\n")).toBeUndefined();
  });
});

describe("gedcomDate", () => {
  it("reads the ISO the template asks for", () => {
    expect(gedcomDate("1873-06-11")).toBe("11 JUN 1873");
    expect(gedcomDate("1873-06")).toBe("JUN 1873");
    expect(gedcomDate("1873")).toBe("1873");
  });

  it("reads what a Slovenian spreadsheet writes instead", () => {
    expect(gedcomDate("11.6.1873")).toBe("11 JUN 1873");
    expect(gedcomDate("11.06.1873")).toBe("11 JUN 1873");
  });

  it("leaves an illegible cell undated rather than inventing a date", () => {
    expect(gedcomDate("??")).toBe("");
    expect(gedcomDate("")).toBe("");
    expect(gedcomDate("1873-13-11")).toBe("");
  });
});

describe("parseNotePerson", () => {
  it("reads the age and both parents", () => {
    const out = parseNotePerson("vdovec, 42 let, kmet; starša Matija Jakofčič, kmet, in Barbara Simec.");
    expect(out).toEqual({ age: 42, father: "Matija Jakofčič", mother: "Barbara Simec" });
  });

  it("reads parents joined without a comma", () => {
    const out = parseNotePerson("29 let; starša Jakob Žugelj in Katarina Žugelj.");
    expect(out.father).toBe("Jakob Žugelj");
    expect(out.mother).toBe("Katarina Žugelj");
  });

  it("drops the register's deceased and née shorthand", () => {
    // "in pok. Marija Simec." would otherwise end its sentence at "pok." and
    // leave the record with a mother named "pok".
    const out = parseNotePerson("48 let; starša pok. Janez Zrimšek, posestnik, in pok. Marija r. Vardnal.");
    expect(out.father).toBe("Janez Zrimšek");
    expect(out.mother).toBe("Marija Vardnal");
    expect(parseNotePerson("24 let; starša + Janez Segina, kmet, in † Doroteja Križan.")).toEqual({
      age: 24,
      father: "Janez Segina",
      mother: "Doroteja Križan",
    });
  });

  it("reads a single named parent", () => {
    expect(parseNotePerson("19 let, nezakonska; mati Marija Žugelj, samska.")).toEqual({
      age: 19,
      mother: "Marija Žugelj",
    });
    expect(parseNotePerson("32 let; oče Peter Grdešič, kmet.").father).toBe("Peter Grdešič");
  });

  it("takes the person's own age, not one standing in the parents' description", () => {
    const out = parseNotePerson("25 let; starša Martin Orlič, kmet, 60 let, in Ana Logar.");
    expect(out.age).toBe(25);
  });

  it("declines an age that cannot be one", () => {
    expect(parseNotePerson("Griblje 13, 8 let").age).toBeUndefined();
  });

  it("finds nothing in prose that follows no convention", () => {
    expect(parseNotePerson("druga žena Andreju, prvič poročena Dolinar")).toEqual({});
    expect(parseNotePerson("")).toEqual({});
  });
});

describe("parseAssociates", () => {
  it("keeps the names and drops what the witnesses did for a living", () => {
    expect(parseAssociates("Matija Jakofčič, Miha Križan, kmeta.")).toEqual([
      "Matija Jakofčič",
      "Miha Križan",
    ]);
    expect(parseAssociates("Franc Furlan, meščan v Metliki, in Martin Težak, kmet.")).toEqual([
      "Franc Furlan",
      "Martin Težak",
    ]);
  });

  it("stops at the end of the list's own sentence", () => {
    const names = parseAssociates(
      "Anton Kure, kmet, Andrej Totar. Nadvarstveno dovoljenje z dne 17. januarja 1874; preveri: opombe",
    );
    expect(names).toEqual(["Anton Kure", "Andrej Totar"]);
  });
});

describe("parseParishIndexCsv — marriage rows", () => {
  const text = csv(
    P_HEADER,
    `1;Podzemelj;1873-06-11;Griblje 13;Matija;Jakofčič;Jakoftschitsch;Griblje 62;Marija;Križan;;${MATRICULA};` +
      `"Ženin: vdovec, 42 let, kmet; starša Matija Jakofčič, kmet, in Barbara Simec. ` +
      `Nevesta: 32 let; starša Matija Križan, kmet, in Marija Milek. Priči: Miha Križan, Jurij Klepec, kmeta.";Renko_Luka`,
  );

  /** The wedding's own family, and the two records it marries. The groom shares
   *  his father's name, so he is taken from the wedding rather than by name. */
  function wedding(ds: Dataset): { fam: GedNode; groom: GedNode; bride: GedNode } {
    const fam = [...ds.families.values()].find((f) => child(f.raw, "MARR"))!.raw;
    return {
      fam,
      groom: ds.individuals.get(values(fam, "HUSB")[0])!.raw,
      bride: ds.individuals.get(values(fam, "WIFE")[0])!.raw,
    };
  }

  it("makes a couple with the wedding on their family", () => {
    const ds = parse(text);
    const { fam, groom, bride } = wedding(ds);
    expect(child(groom, "SEX")?.value).toBe("M");
    expect(child(bride, "SEX")?.value).toBe("F");
    expect(values(groom, "FAMS")).toEqual([fam.xref]);
    expect(values(bride, "FAMS")).toEqual([fam.xref]);
    const marr = child(fam, "MARR")!;
    expect(child(marr, "DATE")?.value).toBe("11 JUN 1873");
    expect(child(marr, "PLAC")?.value).toBe("Podzemelj");
    expect(child(marr, "WWW")?.value).toBe(MATRICULA);
  });

  it("dates each spouse's birth from the age the register gives them", () => {
    const { groom, bride } = wedding(parse(text));
    expect(child(child(groom, "BIRT")!, "DATE")?.value).toBe("ABT 1831");
    expect(child(child(bride, "BIRT")!, "DATE")?.value).toBe("ABT 1841");
  });

  it("records each spouse at the house the index files them under", () => {
    const { groom, bride } = wedding(parse(text));
    const resi = child(groom, "RESI")!;
    expect(child(resi, "PLAC")?.value).toBe("Griblje 13");
    expect(child(resi, "DATE")?.value).toBe("11 JUN 1873");
    expect(child(child(bride, "RESI")!, "PLAC")?.value).toBe("Griblje 62");
  });

  it("gives both spouses the parents their note names", () => {
    const ds = parse(text);
    const nameOf = (id: string): string => {
      const n = ds.individuals.get(id)!.names[0];
      return `${n?.given ?? ""} ${n?.surname ?? ""}`.trim();
    };
    const parentsOf = (spouse: GedNode): string[] => {
      const fam = ds.families.get(values(spouse, "FAMC")[0])!.raw;
      return [values(fam, "HUSB")[0], values(fam, "WIFE")[0]].map(nameOf);
    };
    const { groom, bride } = wedding(ds);
    expect(parentsOf(groom)).toEqual(["Matija Jakofčič", "Barbara Simec"]);
    expect(parentsOf(bride)).toEqual(["Matija Križan", "Marija Milek"]);
  });

  it("names the witnesses on the wedding without minting people for them", () => {
    const ds = parse(text);
    const assoc = child(wedding(ds).fam, "MARR")!.children.filter((c) => c.tag === "ASSO");
    expect(assoc.map((a) => a.value)).toEqual(["@VOID@", "@VOID@"]);
    expect(assoc.map((a) => child(a, "PHRASE")?.value)).toEqual(["Miha Križan", "Jurij Klepec"]);
    expect(assoc.map((a) => child(a, "ROLE")?.value)).toEqual(["WITN", "WITN"]);
    // A witness is named, not recorded: no INDI is created for one.
    expect([...ds.individuals.values()].some((i) => i.names[0]?.surname === "Klepec")).toBe(false);
  });

  it("carries the note verbatim onto the wedding", () => {
    const note = child(child(wedding(parse(text)).fam, "MARR")!, "NOTE")?.value ?? "";
    expect(note).toContain("Ženin: vdovec, 42 let, kmet");
    expect(note).toContain("Priči: Miha Križan, Jurij Klepec, kmeta.");
  });

  it("keeps the archival spelling as a name of its own", () => {
    const names = wedding(parse(text)).groom.children.filter((c) => c.tag === "NAME");
    expect(names.map((n) => n.value)).toEqual(["Matija /Jakofčič/", "Matija /Jakoftschitsch/"]);
    expect(child(names[1], "TYPE")?.value).toBe("aka");
  });

  it("gives the one address of a narrow file to the groom", () => {
    const ds = parse(
      csv(P_NARROW_HEADER, `1;Dobrova;1836-01-31;Šmartno 9;Andrej;Čergan;;Mica;Hribernik;;;;Kimovec_Lidija`),
    );
    expect(child(child(person(ds, "Andrej Čergan"), "RESI")!, "PLAC")?.value).toBe("Šmartno 9");
    expect(child(person(ds, "Mica Hribernik"), "RESI")).toBeUndefined();
  });

  it("makes siblings of two rows naming the same parents", () => {
    const ds = parse(
      csv(
        P_HEADER,
        `1;Podzemelj;1874-01-18;Griblje 4;Jakob;Pasič;;Griblje 19;Ana;Žunič;;;"Ženin: 24 let; starša Martin Žunič in Ana Bilič.";x`,
        `2;Podzemelj;1878-05-02;Griblje 7;Peter;Kralj;;Griblje 19;Marija;Žunič;;;"Nevesta: 22 let; starša Martin Žunič in Ana Bilič.";x`,
      ),
    );
    const parents = ds.families.get(values(person(ds, "Jakob Pasič"), "FAMC")[0])!.raw;
    expect(values(parents, "CHIL")).toHaveLength(2);
    expect(values(person(ds, "Marija Žunič"), "FAMC")[0]).toBe(parents.xref);
  });

  it("does not marry a grandson's parents into his grandparents' family", () => {
    // Both weddings name "Martin Žunič in Ana Bilič", but a groom of 24 in 1874
    // and one of 22 in 1930 cannot be brothers.
    const ds = parse(
      csv(
        P_HEADER,
        `1;Podzemelj;1874-01-18;Griblje 4;Jakob;Pasič;;Griblje 19;Ana;Novak;;;"Ženin: 24 let; starša Martin Žunič in Ana Bilič.";x`,
        `2;Podzemelj;1930-05-02;Griblje 7;Peter;Kralj;;Griblje 19;Marija;Kos;;;"Ženin: 22 let; starša Martin Žunič in Ana Bilič.";x`,
      ),
    );
    const first = values(person(ds, "Jakob Pasič"), "FAMC")[0];
    const second = values(person(ds, "Peter Kralj"), "FAMC")[0];
    expect(first).not.toBe(second);
  });

  it("imports a row the notes column says nothing useful about", () => {
    const ds = parse(
      csv(P_NARROW_HEADER, `1;Dobrova;1836-02-01;Šmartno 9;Andrej;Čergan;;Mica;Hribernik;;;druga žena Andreju;x`),
    );
    const groom = person(ds, "Andrej Čergan");
    expect(child(groom, "BIRT")).toBeUndefined();
    expect(values(groom, "FAMC")).toHaveLength(0);
    const fam = ds.families.get(values(groom, "FAMS")[0])!.raw;
    expect(child(child(fam, "MARR")!, "NOTE")?.value).toBe("druga žena Andreju");
  });
});

describe("parseParishIndexCsv — baptism rows", () => {
  const text = csv(
    K_HEADER,
    `1;Grahovo;1837-02-21;1837-02-24;Žerovnica 31;Matija;Anton;Anton;Šega;Schega;Elizabeta;Gornik;;${MATRICULA};;Modic_Mojca`,
  );

  it("makes the child, with the father's surname", () => {
    const ds = parse(text);
    const kid = person(ds, "Matija Šega");
    expect(child(kid, "SEX")?.value).toBe("M");
    expect(kid.children.filter((c) => c.tag === "NAME").map((n) => n.value)).toEqual([
      "Matija /Šega/",
      "Matija /Schega/",
      "Anton /Šega/",
    ]);
  });

  it("births the child at the house and baptises them in the parish", () => {
    const ds = parse(text);
    const kid = person(ds, "Matija Šega");
    const birt = child(kid, "BIRT")!;
    expect(child(birt, "DATE")?.value).toBe("21 FEB 1837");
    expect(child(birt, "PLAC")?.value).toBe("Žerovnica 31");
    const chr = child(kid, "CHR")!;
    expect(child(chr, "DATE")?.value).toBe("24 FEB 1837");
    expect(child(chr, "PLAC")?.value).toBe("Grahovo");
    expect(child(chr, "WWW")?.value).toBe(MATRICULA);
  });

  it("puts the child in the parents' family", () => {
    const ds = parse(text);
    const fam = ds.families.get(values(person(ds, "Matija Šega"), "FAMC")[0])!.raw;
    expect(values(fam, "HUSB")[0]).toBe(person(ds, "Anton Šega").xref);
    expect(values(fam, "WIFE")[0]).toBe(person(ds, "Elizabeta Gornik").xref);
  });

  it("gathers a couple's children into one family", () => {
    const ds = parse(
      csv(
        K_HEADER,
        `1;Grahovo;1837-02-21;1837-02-21;Žerovnica 31;Matija;;Anton;Šega;;Elizabeta;Gornik;;;;x`,
        `2;Grahovo;1839-06-02;1839-06-02;Žerovnica 31;Marija;;Anton;Šega;;Elizabeta;Gornik;;;;x`,
        `3;Grahovo;1841-11-30;1841-11-30;Žerovnica 31;Jera;;Anton;Šega;;Elizabeta;Gornik;;;;x`,
      ),
    );
    const fam = ds.families.get(values(person(ds, "Matija Šega"), "FAMC")[0])!.raw;
    expect(values(fam, "CHIL")).toHaveLength(3);
    expect(ds.families.size).toBe(1);
  });

  it("takes the mother's surname when the register names no father", () => {
    const ds = parse(
      csv(K_HEADER, `1;Grahovo;1840-04-01;1840-04-01;Bločice 14;Ana;;;;;Marjeta;Krašovic;;;Nezakonska;x`),
    );
    const kid = person(ds, "Ana Krašovic");
    expect(child(kid, "SEX")?.value).toBe("F");
    const fam = ds.families.get(values(kid, "FAMC")[0])!.raw;
    expect(values(fam, "HUSB")).toHaveLength(0);
    expect(values(fam, "WIFE")[0]).toBe(person(ds, "Marjeta Krašovic").xref);
  });

  it("names the godparents on the baptism", () => {
    const ds = parse(
      csv(K_HEADER, `1;Grahovo;1837-02-21;1837-02-21;Žerovnica 31;Matija;;Anton;Šega;;Elizabeta;Gornik;;;"Botra: Jera Lavrič, Miha Ileršič, kmeta.";x`),
    );
    const chr = child(person(ds, "Matija Šega"), "CHR")!;
    const assoc = chr.children.filter((c) => c.tag === "ASSO");
    expect(assoc.map((a) => child(a, "PHRASE")?.value)).toEqual(["Jera Lavrič", "Miha Ileršič"]);
    expect(assoc.every((a) => child(a, "ROLE")?.value === "GODP")).toBe(true);
  });
});

describe("parseParishIndexCsv — the file itself", () => {
  it("reads a comma-separated export as readily as a semicolon-separated one", () => {
    const ds = parse(
      `zp. št.,župnija,datum poroke,naslov,ime ženina,priimek ženina,ime neveste,priimek neveste,opombe\n` +
        `1,Podzemelj,1873-06-11,Griblje 13,Matija,Jakofčič,Marija,Križan,"Ženin: 42 let; starša Anton Jakofčič in Ana Kure."\n`,
    );
    expect(person(ds, "Marija Križan")).toBeTruthy();
    expect(person(ds, "Anton Jakofčič")).toBeTruthy();
  });

  it("skips the blank rows a spreadsheet export trails", () => {
    const ds = parse(
      csv(P_NARROW_HEADER, `1;Dobrova;1836-01-31;Šmartno 9;Andrej;Čergan;;Mica;Hribernik;;;;x`, ";;;;;;;;;;;;", ""),
    );
    expect(ds.families.size).toBe(1);
  });

  it("lets matching treat the import as a sparse-birth source", () => {
    expect(parse(csv(P_NARROW_HEADER, `1;Dobrova;1836-01-31;Šmartno 9;Andrej;Čergan;;Mica;Hribernik;;;;x`))
      .sparseBirthDates).toBe(true);
  });
});
