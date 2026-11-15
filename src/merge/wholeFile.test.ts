import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import type { GedNode } from "../gedcom/types";
import { decisionKey, type CandidateDecision } from "../review/types";
import { mergeDecisions, type WholeFileImport } from "./merge";

const dataset = (text: string) => buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;
const tr = (key: string) => key;

function merge(
  mainBody: string,
  compareBody: string,
  opts: { pending?: WholeFileImport["pending"]; candidates?: [string, string][]; confirmed?: [string, string][]; rejected?: [string, string][] } = {},
) {
  const main = dataset(wrap(mainBody));
  const compare = dataset(wrap(compareBody));
  const decisions = new Map<string, CandidateDecision>();
  for (const [m, c] of opts.confirmed ?? []) decisions.set(decisionKey("individual", m, c), { status: "confirmed", fields: {} });
  for (const [m, c] of opts.rejected ?? []) decisions.set(decisionKey("individual", m, c), { status: "rejected", fields: {} });
  const pairs = [...(opts.candidates ?? []), ...(opts.confirmed ?? []), ...(opts.rejected ?? [])];
  const matches = { individuals: pairs.map(([mainId, compareId]) => ({ mainId, compareId })) } as never;
  const { records, report } = mergeDecisions(main, compare, decisions, matches, tr, [], undefined, { pending: opts.pending ?? "new" });
  const out = dataset(serializeGedcom(records));
  return { out, report, text: serializeGedcom(records) };
}

/** A person's name in the output, by xref. */
const nameOf = (out: ReturnType<typeof dataset>, id: string | undefined) => (id ? out.individuals.get(id)?.names[0]?.full : undefined);
const byName = (out: ReturnType<typeof dataset>, full: string) => [...out.individuals.values()].filter((i) => i.names[0]?.full === full);
const lines = (node: GedNode) => node.children.map((c) => `${c.tag} ${c.value ?? ""}`.trim());

const MAIN = "0 @I1@ INDI\n1 NAME Jože /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n";

describe("whole-file merge", () => {
  it("brings a family across with its own facts, sources and notes", () => {
    const { out } = merge(MAIN,
      "0 @P1@ INDI\n1 NAME Franc /Kos/\n1 SEX M\n1 FAMS @G1@\n" +
      "0 @P2@ INDI\n1 NAME Neža /Kos/\n1 SEX F\n1 FAMS @G1@\n" +
      "0 @G1@ FAM\n1 HUSB @P1@\n1 WIFE @P2@\n1 MARR\n2 DATE 3 MAY 1880\n2 PLAC Kranj\n2 SOUR @S1@\n3 PAGE fol. 7\n1 NOTE @N1@\n" +
      "0 @S1@ SOUR\n1 TITL Poročna knjiga\n" +
      "0 @N1@ NOTE Poročila sta se pozimi.\n");
    const fam = [...out.families.values()].find((f) => nameOf(out, f.husband) === "Franc Kos")!;
    expect(nameOf(out, fam.wife)).toBe("Neža Kos");
    const marr = fam.raw.children.find((c) => c.tag === "MARR")!;
    expect(lines(marr)).toEqual(["DATE 3 MAY 1880", "PLAC Kranj", "SOUR @S1@"]);
    const note = fam.raw.children.find((c) => c.tag === "NOTE")!.value!;
    expect(out.records.find((r) => r.xref === note)?.value).toBe("Poročila sta se pozimi.");
    expect(out.records.find((r) => r.xref === "@S1@")).toBeDefined();
  });

  it("keeps a family with children but no parents recorded", () => {
    const { out } = merge(MAIN,
      "0 @P1@ INDI\n1 NAME Ana /Kos/\n1 FAMC @G1@\n" +
      "0 @P2@ INDI\n1 NAME Tone /Kos/\n1 FAMC @G1@\n" +
      "0 @G1@ FAM\n1 CHIL @P1@\n1 CHIL @P2@\n");
    const fam = [...out.families.values()].find((f) => f.children.length === 2)!;
    expect(fam.children.map((id) => nameOf(out, id)).sort()).toEqual(["Ana Kos", "Tone Kos"]);
  });

  it("keeps an adopted child as one person in both families", () => {
    const { out } = merge(MAIN,
      "0 @P1@ INDI\n1 NAME Birth /Father/\n1 SEX M\n1 FAMS @G1@\n" +
      "0 @P2@ INDI\n1 NAME Adoptive /Father/\n1 SEX M\n1 FAMS @G2@\n" +
      "0 @P3@ INDI\n1 NAME Ana /Child/\n1 FAMC @G1@\n1 FAMC @G2@\n2 PEDI adopted\n" +
      "0 @G1@ FAM\n1 HUSB @P1@\n1 CHIL @P3@\n" +
      "0 @G2@ FAM\n1 HUSB @P2@\n1 CHIL @P3@\n");
    const [child] = byName(out, "Ana Child");
    expect(byName(out, "Ana Child")).toHaveLength(1);
    expect(child.childOf).toHaveLength(2);
    expect(child.raw.children.filter((c) => c.tag === "FAMC").map((c) => lines(c))).toContainEqual(["PEDI adopted"]);
  });

  it("keeps a person's two unions with no partner recorded apart", () => {
    const { out } = merge(MAIN,
      "0 @P1@ INDI\n1 NAME Franc /Kos/\n1 SEX M\n1 FAMS @G1@\n1 FAMS @G2@\n" +
      "0 @P2@ INDI\n1 NAME Ana /Kos/\n1 FAMC @G1@\n" +
      "0 @P3@ INDI\n1 NAME Tone /Kos/\n1 FAMC @G2@\n" +
      "0 @G1@ FAM\n1 HUSB @P1@\n1 CHIL @P2@\n" +
      "0 @G2@ FAM\n1 HUSB @P1@\n1 CHIL @P3@\n");
    const [franc] = byName(out, "Franc Kos");
    expect(franc.spouseOf).toHaveLength(2);
    expect(franc.spouseOf.map((f) => out.families.get(f)!.children.length)).toEqual([1, 1]);
  });

  it("joins a confirmed person and hangs their incoming family on them", () => {
    const { out, report } = merge(MAIN,
      "0 @P1@ INDI\n1 NAME Jože /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n1 FAMS @G1@\n" +
      "0 @P2@ INDI\n1 NAME Marija /Novak/\n1 SEX F\n1 FAMS @G1@\n" +
      "0 @P3@ INDI\n1 NAME Tone /Novak/\n1 FAMC @G1@\n" +
      "0 @G1@ FAM\n1 HUSB @P1@\n1 WIFE @P2@\n1 CHIL @P3@\n",
      { confirmed: [["@I1@", "@P1@"]] });
    expect(byName(out, "Jože Novak")).toHaveLength(1);
    expect(report.newPersons).toBe(2);
    const fam = out.families.get(out.individuals.get("@I1@")!.spouseOf[0])!;
    expect(nameOf(out, fam.wife)).toBe("Marija Novak");
    expect(fam.children.map((id) => nameOf(out, id))).toEqual(["Tone Novak"]);
    expect(out.families.size).toBe(1);
  });

  it("adds an unreviewed candidate as a new person, or joins them, as asked", () => {
    const compare = "0 @P1@ INDI\n1 NAME Jože /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n";
    const asNew = merge(MAIN, compare, { candidates: [["@I1@", "@P1@"]], pending: "new" });
    expect(byName(asNew.out, "Jože Novak")).toHaveLength(2);
    const joined = merge(MAIN, compare, { candidates: [["@I1@", "@P1@"]], pending: "join" });
    expect(byName(joined.out, "Jože Novak")).toHaveLength(1);
  });

  it("never joins a rejected pair, whatever is asked of the unreviewed", () => {
    const compare = "0 @P1@ INDI\n1 NAME Jože /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n";
    const { out } = merge(MAIN, compare, { rejected: [["@I1@", "@P1@"]], pending: "join" });
    expect(byName(out, "Jože Novak")).toHaveLength(2);
  });

  it("does not split a person whose parents the two files disagree on", () => {
    // Tone is confirmed as the main's Tone, born to Jože; the incoming file
    // gives him another father. He stays one person, under the main's parents.
    const { out, report } = merge(
      MAIN + "0 @I2@ INDI\n1 NAME Tone /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1880\n1 FAMC @F1@\n0 @F1@ FAM\n1 HUSB @I1@\n1 CHIL @I2@\n",
      "0 @P1@ INDI\n1 NAME Peter /Novak/\n1 SEX M\n1 FAMS @G1@\n" +
      "0 @P2@ INDI\n1 NAME Tone /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1880\n1 FAMC @G1@\n" +
      "0 @G1@ FAM\n1 HUSB @P1@\n1 CHIL @P2@\n",
      { candidates: [["@I2@", "@P2@"]], pending: "join" });
    expect(byName(out, "Tone Novak")).toHaveLength(1);
    expect(out.individuals.get("@I2@")!.childOf).toEqual(["@F1@"]);
    expect(report.deferred.some((d) => d.reasonKey === "merge.reason.childHasParents")).toBe(true);
  });

  it("brings every incoming source, repository, note and media record, used or not, once", () => {
    const { out } = merge(MAIN + "0 @S1@ SOUR\n1 TITL Krstna knjiga\n",
      "0 @P1@ INDI\n1 NAME Franc /Kos/\n" +
      "0 @S1@ SOUR\n1 TITL Krstna knjiga\n" +
      "0 @S2@ SOUR\n1 TITL Mrliška knjiga\n1 REPO @R1@\n" +
      "0 @R1@ REPO\n1 NAME Nadškofijski arhiv\n" +
      "0 @N1@ NOTE Nobody points here.\n" +
      "0 @O1@ OBJE\n1 FILE photo.jpg\n2 FORM jpg\n");
    const titles = out.records.filter((r) => r.tag === "SOUR").map((r) => r.children.find((c) => c.tag === "TITL")?.value);
    // The same baptism register is not copied a second time.
    expect(titles.sort()).toEqual(["Krstna knjiga", "Mrliška knjiga"]);
    expect(out.records.some((r) => r.tag === "REPO")).toBe(true);
    expect(out.records.some((r) => r.tag === "NOTE" && r.value === "Nobody points here.")).toBe(true);
    expect(out.records.some((r) => r.tag === "OBJE")).toBe(true);
  });
});
