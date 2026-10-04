import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import { removeIndividual } from "../gedcom/edit";
import { decisionKey, type CandidateDecision } from "../review/types";
import { applyRecordPatches } from "../ui/historyTypes";
import { mergeDecisions } from "./merge";
import { materializeAdds } from "./materialize";

const dataset = (text: string) => buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;
const tr = (key: string) => key;

// A couple both files have, with one child both know and one only the
// incoming file knows (Marko, P4).
const MAIN = wrap(
  "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n1 FAMS @F1@\n" +
    "0 @I2@ INDI\n1 NAME Ana /Kos/\n1 SEX F\n1 BIRT\n2 DATE 1855\n1 FAMS @F1@\n" +
    "0 @I3@ INDI\n1 NAME Peter /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1880\n1 FAMC @F1@\n" +
    "0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n1 CHIL @I3@\n",
);
const COMPARE = wrap(
  "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n1 FAMS @G1@\n1 FAMC @G2@\n" +
    "0 @P2@ INDI\n1 NAME Ana /Kos/\n1 SEX F\n1 BIRT\n2 DATE 1855\n1 FAMS @G1@\n" +
    "0 @P3@ INDI\n1 NAME Peter /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1880\n1 FAMC @G1@\n" +
    "0 @P4@ INDI\n1 NAME Marko /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1883\n2 PLAC Kranj\n1 FAMC @G1@\n" +
    "0 @P5@ INDI\n1 NAME Jakob /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1820\n1 FAMS @G2@\n" +
    "0 @G1@ FAM\n1 HUSB @P1@\n1 WIFE @P2@\n1 CHIL @P3@\n1 CHIL @P4@\n" +
    "0 @G2@ FAM\n1 HUSB @P5@\n1 CHIL @P1@\n",
);
const MATCHES = {
  individuals: [
    { mainId: "@I1@", compareId: "@P1@" },
    { mainId: "@I2@", compareId: "@P2@" },
    { mainId: "@I3@", compareId: "@P3@" },
  ],
} as never;

const FATHER = decisionKey("individual", "@I1@", "@P1@");
const MOTHER = decisionKey("individual", "@I2@", "@P2@");

function step(
  main: ReturnType<typeof dataset>,
  compare: ReturnType<typeof dataset>,
  before: Map<string, CandidateDecision>,
  key: string,
  value: CandidateDecision,
) {
  const after = new Map(before).set(key, value);
  return materializeAdds(main, compare, MATCHES, before, after, tr);
}

const namesIn = (text: string, name: string) => text.split(`1 NAME ${name}`).length - 1;

describe("materializeAdds", () => {
  it("adds a ticked child at once, linked into the family, and the other parent's tick adds nobody", () => {
    const main = dataset(MAIN);
    const compare = dataset(COMPARE);
    // Keep the father's own parent out of this test.
    const first = step(main, compare, new Map(), FATHER, { status: "confirmed", fields: { father: "main" }, takenChildren: ["@P4@"] });
    const markoId = first.decisions.get(FATHER)?.added?.["@P4@"];
    expect(markoId).toBeDefined();
    const marko = main.individuals.get(markoId!);
    expect(marko?.childOf).toEqual(["@F1@"]);
    expect(main.families.get("@F1@")?.children).toContain(markoId);
    expect(serializeGedcom(main.records)).toContain("2 PLAC Kranj");

    // The mother lists the same child: it is already in her family.
    const second = step(main, compare, first.decisions, MOTHER, { status: "confirmed", fields: {}, takenChildren: ["@P4@"] });
    expect(second.decisions.get(MOTHER)?.added).toBeUndefined();
    expect(namesIn(serializeGedcom(main.records), "Marko /Novak/")).toBe(1);

    // And the save does not add him again.
    const { records } = mergeDecisions(main, compare, second.decisions, MATCHES, tr);
    const out = serializeGedcom(records);
    expect(namesIn(out, "Marko /Novak/")).toBe(1);
    expect(out.match(new RegExp(`1 CHIL ${markoId}`, "g"))?.length).toBe(1);
  });

  it("keeps edits made to an added person through the save", () => {
    const main = dataset(MAIN);
    const compare = dataset(COMPARE);
    const { decisions } = step(main, compare, new Map(), FATHER, { status: "confirmed", fields: { father: "main" }, takenChildren: ["@P4@"] });
    const markoId = decisions.get(FATHER)!.added!["@P4@"];
    const name = main.individuals.get(markoId)!.raw.children.find((c) => c.tag === "NAME")!;
    name.value = "Marko Anton /Novak/";
    const out = serializeGedcom(mergeDecisions(main, compare, decisions, MATCHES, tr).records);
    expect(out).toContain("1 NAME Marko Anton /Novak/");
    expect(namesIn(out, "Marko /Novak/")).toBe(0);
  });

  it("does not bring back an added person deleted in Edit", () => {
    const main = dataset(MAIN);
    const compare = dataset(COMPARE);
    const { decisions } = step(main, compare, new Map(), FATHER, { status: "confirmed", fields: { father: "main" }, takenChildren: ["@P4@"] });
    removeIndividual(main, main.individuals.get(decisions.get(FATHER)!.added!["@P4@"])!);
    const out = serializeGedcom(mergeDecisions(main, compare, decisions, MATCHES, tr).records);
    expect(namesIn(out, "Marko /Novak/")).toBe(0);
  });

  it("adds an incoming parent with a family of their own, and takes it all back on unconfirm", () => {
    const main = dataset(MAIN);
    const compare = dataset(COMPARE);
    const original = serializeGedcom(main.records);
    const confirmed: CandidateDecision = { status: "confirmed", fields: {} };
    const first = step(main, compare, new Map(), FATHER, confirmed);
    const jakobId = first.decisions.get(FATHER)?.added?.["@P5@"];
    expect(jakobId).toBeDefined();
    expect(main.individuals.get("@I1@")?.childOf).toHaveLength(1);
    expect(main.families.get(main.individuals.get("@I1@")!.childOf[0])?.husband).toBe(jakobId);

    const second = step(main, compare, first.decisions, FATHER, { ...first.decisions.get(FATHER)!, status: "undecided" });
    expect(second.decisions.get(FATHER)?.added).toBeUndefined();
    expect(serializeGedcom(main.records)).toBe(original);
  });

  it("keeps track of an added child when the decision is rebuilt without it, and an untick removes them", () => {
    const main = dataset(MAIN);
    const compare = dataset(COMPARE);
    const original = serializeGedcom(main.records);
    const first = step(main, compare, new Map(), FATHER, { status: "confirmed", fields: { father: "main" }, takenChildren: ["@P4@"] });
    // A field choice, emitted as a fresh decision that knows nothing of `added`.
    const second = step(main, compare, first.decisions, FATHER, { status: "confirmed", fields: { father: "main", sex: "main" }, takenChildren: ["@P4@"] });
    expect(second.decisions.get(FATHER)?.added).toEqual(first.decisions.get(FATHER)?.added);
    expect(namesIn(serializeGedcom(main.records), "Marko /Novak/")).toBe(1);
    step(main, compare, second.decisions, FATHER, { status: "confirmed", fields: { father: "main" } });
    expect(serializeGedcom(main.records)).toBe(original);
  });

  it("undoes to the file as it was", () => {
    const main = dataset(MAIN);
    const compare = dataset(COMPARE);
    const original = serializeGedcom(main.records);
    const { patches } = step(main, compare, new Map(), FATHER, { status: "confirmed", fields: {}, takenChildren: ["@P4@"] });
    expect(serializeGedcom(main.records)).not.toBe(original);
    applyRecordPatches(main, patches, "undo");
    expect(serializeGedcom(main.records)).toBe(original);
    expect(main.individuals.size).toBe(3);
  });

  it("never links a person the main file already has — that stays the save's", () => {
    // Main has the husband alone; the incoming wife is matched to a main woman
    // who is not married to him there.
    const main = dataset(wrap(
      "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1850\n" +
        "0 @I2@ INDI\n1 NAME Ana /Kos/\n1 SEX F\n1 BIRT\n2 DATE 1855\n",
    ));
    const compare = dataset(COMPARE);
    const original = serializeGedcom(main.records);
    const { decisions, patches } = step(main, compare, new Map(), FATHER, { status: "confirmed", fields: { father: "main" } });
    expect(decisions.get(FATHER)?.added).toBeUndefined();
    expect(patches).toEqual([]);
    expect(serializeGedcom(main.records)).toBe(original);
  });
});
