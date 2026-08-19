import { describe, expect, it } from "vitest";
import { parseGedcom } from "./parser";
import { buildDataset } from "./builder";
import { serializeGedcom } from "./serialize";
import {
  addAdditionalName,
  addPartner,
  ensurePrimaryName,
  rebuildIndividual,
  setAdditionalName,
  setMarriedName,
  setName,
} from "./edit";
import { primaryName } from "../match/relatives";
import { childrenByTag } from "./node";
import type { Dataset, Individual } from "./types";

function dataset(lines: string[]) {
  return buildDataset(parseGedcom(new TextEncoder().encode(lines.join("\n")).buffer));
}

/** What EditView's "add relative" does for the married-surname setting, once
 *  the wife's record exists — kept in step with the block in `addRelative`. */
function marriedFromPartner(ds: Dataset, husband: Individual, wife: Individual, marriedNameTag: boolean) {
  const husbandSurname = primaryName(husband)?.surname?.trim();
  if (!husbandSurname) return;
  ensurePrimaryName(wife);
  const nameCount = childrenByTag(wife.raw, "NAME").length;
  if (marriedNameTag) {
    setMarriedName(wife, husbandSurname);
  } else {
    addAdditionalName(wife, "married");
    setAdditionalName(wife, nameCount - 1, { surname: husbandSurname });
  }
  rebuildIndividual(ds, wife);
}

// The picker adds the wife either way: with her name typed into its search box
// (which seeds her NAME), or with "+ Add new person" on an empty box — and
// then her record has no NAME at all until the card is filled in. The married
// surname has to land in both cases; only the first one used to work.
describe("married surname from the partner", () => {
  const FILE = ["0 HEAD", "1 GEDC", "2 VERS 5.5.1", "0 @I1@ INDI", "1 NAME Janez /Košnjek/", "1 SEX M", "0 TRLR"];

  it("writes it as a TYPE married name beside the name she was added with", () => {
    const ds = dataset(FILE);
    const husband = ds.individuals.get("@I1@")!;
    const wife = addPartner(ds, husband, undefined);
    setName(wife, { given: "Marija", surname: "Pilar" });
    rebuildIndividual(ds, wife);
    expect(wife.sex).toBe("F");

    marriedFromPartner(ds, husband, wife, false);
    const written = serializeGedcom(ds.records);
    expect(written).toContain("1 NAME Marija /Pilar/");
    expect(written).toContain("1 NAME /Košnjek/\n2 TYPE married");
  });

  it("writes it for a wife added before her own name is typed", () => {
    const ds = dataset(FILE);
    const husband = ds.individuals.get("@I1@")!;
    const wife = addPartner(ds, husband, undefined);
    expect(childrenByTag(wife.raw, "NAME")).toHaveLength(0);

    marriedFromPartner(ds, husband, wife, false);
    // An empty primary name is opened for her, so the married one is a
    // variant of it rather than the name the file would show her under.
    expect(serializeGedcom(ds.records)).toContain("1 NAME\n1 NAME /Košnjek/\n2 TYPE married");

    // Typing her name into the card then fills that very line.
    const live = ds.individuals.get(wife.id)!;
    setName(live, { given: "Marija", surname: "Pilar" });
    rebuildIndividual(ds, live);
    const written = serializeGedcom(ds.records);
    expect(written).toContain("1 NAME Marija /Pilar/");
    expect(written).toContain("1 NAME /Košnjek/\n2 TYPE married");
    expect(childrenByTag(ds.individuals.get(wife.id)!.raw, "NAME")).toHaveLength(2);
  });

  it("writes it inline where the file keeps married names as _MARNM", () => {
    const ds = dataset(FILE);
    const husband = ds.individuals.get("@I1@")!;
    const wife = addPartner(ds, husband, undefined);
    marriedFromPartner(ds, husband, wife, true);
    expect(serializeGedcom(ds.records)).toContain("1 NAME\n2 _MARNM Košnjek");
  });

  it("says nothing when the husband has no surname to give", () => {
    const ds = dataset(["0 HEAD", "0 @I1@ INDI", "1 NAME Janez", "1 SEX M", "0 TRLR"]);
    const husband = ds.individuals.get("@I1@")!;
    const wife = addPartner(ds, husband, undefined);
    marriedFromPartner(ds, husband, wife, false);
    expect(childrenByTag(ds.individuals.get(wife.id)!.raw, "NAME")).toHaveLength(0);
  });
});
