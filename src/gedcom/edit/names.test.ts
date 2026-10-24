import { describe, expect, it } from "vitest";
import { parseGedcom } from "../parser";
import { buildDataset } from "../builder";
import { addAdditionalName, removeAdditionalName, setAdditionalName } from "./names";
import { rebuildIndividual } from "./cache";

function load(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

/** The record as its lines read, for asserting on placement. */
function lines(dataset: ReturnType<typeof load>, id = "@I1@") {
  return dataset.individuals.get(id)!.raw.children.map((c) => `${c.tag}${c.value ? ` ${c.value}` : ""}`);
}

// Records that open with a vendor tag the canonical child order doesn't know
// (MyHeritage's _UID, Ancestry's RIN) used to send a newly added NAME to the
// very front of the record — where it became the *primary* name, and the
// variant editor, which addresses an additional name by position, then wrote
// the typed variant over the real name and lost it.
const VENDOR_FIRST = `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 _UID 8F3C1D
1 NAME Frančišek /Sajovic/
1 SEX M
0 TRLR
`;

describe("addAdditionalName", () => {
  it("adds the new name after the primary, not ahead of it", () => {
    const dataset = load(VENDOR_FIRST);
    addAdditionalName(dataset.individuals.get("@I1@")!, "variation");
    rebuildIndividual(dataset, dataset.individuals.get("@I1@")!);

    expect(lines(dataset)).toEqual(["_UID 8F3C1D", "NAME Frančišek /Sajovic/", "NAME", "SEX M"]);
    expect(dataset.individuals.get("@I1@")!.names[0].given).toBe("Frančišek");
  });

  it("keeps the primary name when the variant is then typed in", () => {
    const dataset = load(VENDOR_FIRST);
    addAdditionalName(dataset.individuals.get("@I1@")!, "variation");
    rebuildIndividual(dataset, dataset.individuals.get("@I1@")!);
    setAdditionalName(dataset.individuals.get("@I1@")!, 0, { given: "Franci", surname: "" });
    rebuildIndividual(dataset, dataset.individuals.get("@I1@")!);

    const names = dataset.individuals.get("@I1@")!.names;
    expect(names[0]).toMatchObject({ given: "Frančišek", surname: "Sajovic" });
    expect(names[1]).toMatchObject({ given: "Franci", type: "variation" });
  });

  it("removes the added name again, leaving the primary alone", () => {
    const dataset = load(VENDOR_FIRST);
    addAdditionalName(dataset.individuals.get("@I1@")!, "variation");
    rebuildIndividual(dataset, dataset.individuals.get("@I1@")!);
    removeAdditionalName(dataset.individuals.get("@I1@")!, 0);
    rebuildIndividual(dataset, dataset.individuals.get("@I1@")!);

    expect(lines(dataset)).toEqual(["_UID 8F3C1D", "NAME Frančišek /Sajovic/", "SEX M"]);
  });

  it("still groups the names together in a canonically ordered record", () => {
    const dataset = load(VENDOR_FIRST.replace("1 _UID 8F3C1D\n", ""));
    addAdditionalName(dataset.individuals.get("@I1@")!, "aka");
    rebuildIndividual(dataset, dataset.individuals.get("@I1@")!);

    expect(lines(dataset)).toEqual(["NAME Frančišek /Sajovic/", "NAME", "SEX M"]);
  });
});

describe("a name's TYPE in the file's version", () => {
  const typeOf = (dataset: ReturnType<typeof load>, i: number) =>
    dataset.individuals.get("@I1@")!.raw.children.filter((c) => c.tag === "NAME")[i]
      .children.find((c) => c.tag === "TYPE")?.value;

  it("writes 7.0's upper-case enumeration, and 5.5.1's lower case", () => {
    const dataset = load(VENDOR_FIRST);
    const indi = dataset.individuals.get("@I1@")!;
    addAdditionalName(indi, "aka", "7.0");
    expect(typeOf(dataset, 1)).toBe("AKA");
    setAdditionalName(indi, 0, { type: "married" }, "7.0");
    expect(typeOf(dataset, 1)).toBe("MARRIED");
    setAdditionalName(indi, 0, { type: "maiden" }, "5.5.1");
    expect(typeOf(dataset, 1)).toBe("maiden");
  });

  it("leaves a word 7.0 does not enumerate as written", () => {
    const dataset = load(VENDOR_FIRST);
    addAdditionalName(dataset.individuals.get("@I1@")!, "variation", "7.0");
    expect(typeOf(dataset, 1)).toBe("variation");
  });
});
