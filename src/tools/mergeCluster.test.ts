import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import {
  clusterDuplicates,
  findDuplicates,
  makeDuplicatePair,
  membersWithoutDirectPair,
} from "./duplicates";
import { mergeDuplicateChain } from "./mergeDuplicate";
import {
  clusterMergeSteps,
  clusterRelativeGroups,
  mergeCluster,
  pickClusterSurvivor,
  RELATED_CHILD_MIN_SCORE,
} from "./mergeCluster";
import { validateDataset } from "./validate";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}
const tr = (key: string) => key;
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;

/** The whole file as text, for comparing two ways of reaching the same state. */
function snapshot(ds: ReturnType<typeof dataset>): string {
  const ids = [...ds.individuals.keys(), ...ds.families.keys()].sort();
  return ids
    .map((id) => serializeGedcom([(ds.individuals.get(id) ?? ds.families.get(id))!.raw]))
    .join("");
}

/** Four copies of one woman, each carrying a little more than the last. */
const fourCopies = wrap(
  "0 @I1@ INDI\n1 NAME Frančiška /Stopar/\n1 SEX F\n1 BIRT\n2 DATE 22 FEB 1888\n2 PLAC Poljane\n" +
    "1 FAMS @F1@\n" +
    "0 @I2@ INDI\n1 NAME Franciska /Stopar/\n1 SEX F\n1 BIRT\n2 DATE 22 FEB 1888\n1 DEAT\n2 DATE 1944\n" +
    "0 @I3@ INDI\n1 NAME Frančiška /Stopar/\n1 SEX F\n1 BIRT\n2 DATE 22 FEB 1888\n1 OCCU Šivilja\n" +
    "0 @I4@ INDI\n1 NAME Francisca /Stopar/\n1 SEX F\n1 BIRT\n2 DATE 22 FEB 1888\n" +
    "0 @I9@ INDI\n1 NAME Franc /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1885\n1 FAMS @F1@\n" +
    "0 @F1@ FAM\n1 HUSB @I9@\n1 WIFE @I1@\n",
);

/**
 * Three copies of a wife, each married to her own copy of one husband — the
 * shape that makes a cluster merge fail without the relative groups: merge only
 * the wives and the survivor ends up in three unfoldable marriages.
 */
const threeCouples = wrap(
  "0 @W1@ INDI\n1 NAME Neža /Gutovnik/\n1 SEX F\n1 BIRT\n2 DATE 3 MAR 1890\n1 FAMS @F1@\n" +
    "0 @W2@ INDI\n1 NAME Neža /Gutovnik/\n1 SEX F\n1 BIRT\n2 DATE 3 MAR 1890\n1 FAMS @F2@\n" +
    "0 @W3@ INDI\n1 NAME Neza /Gutovnik/\n1 SEX F\n1 BIRT\n2 DATE 3 MAR 1890\n1 FAMS @F3@\n" +
    "0 @H1@ INDI\n1 NAME Franc /Stopar/\n1 SEX M\n1 BIRT\n2 DATE 8 AUG 1886\n1 FAMS @F1@\n" +
    "0 @H2@ INDI\n1 NAME Franc /Stopar/\n1 SEX M\n1 BIRT\n2 DATE 8 AUG 1886\n1 FAMS @F2@\n" +
    "0 @H3@ INDI\n1 NAME Franc /Stopar/\n1 SEX M\n1 BIRT\n2 DATE 8 AUG 1886\n1 FAMS @F3@\n" +
    "0 @F1@ FAM\n1 HUSB @H1@\n1 WIFE @W1@\n1 MARR\n2 DATE 1910\n" +
    "0 @F2@ FAM\n1 HUSB @H2@\n1 WIFE @W2@\n" +
    "0 @F3@ FAM\n1 HUSB @H3@\n1 WIFE @W3@\n",
);

describe("pickClusterSurvivor", () => {
  it("keeps the record with the most linked relatives", () => {
    const ds = dataset(fourCopies);
    expect(pickClusterSurvivor(ds, ["@I1@", "@I2@", "@I3@", "@I4@"])).toBe("@I1@");
  });

  it("breaks a tie on the fuller record, then on the id — never on order", () => {
    const ds = dataset(fourCopies);
    const forward = pickClusterSurvivor(ds, ["@I2@", "@I3@", "@I4@"]);
    const reversed = pickClusterSurvivor(ds, ["@I4@", "@I3@", "@I2@"]);
    expect(forward).toBe(reversed);
    // @I2@ and @I3@ both carry one line more than @I4@; @I2@ wins on the id.
    expect(forward).toBe("@I2@");
  });

  it("ignores ids that are no longer in the dataset", () => {
    const ds = dataset(fourCopies);
    expect(pickClusterSurvivor(ds, ["@GONE@", "@I3@"])).toBe("@I3@");
  });
});

describe("mergeCluster", () => {
  it("leaves exactly one record, and it is the chosen survivor", () => {
    const ds = dataset(fourCopies);
    const members = ["@I1@", "@I2@", "@I3@", "@I4@"];
    mergeCluster(ds, "@I1@", members, [], tr);

    expect(members.filter((id) => ds.individuals.has(id))).toEqual(["@I1@"]);
    expect(validateDataset(ds).counts.brokenLink).toBe(0);
  });

  it("keeps every fact any copy carried", () => {
    const ds = dataset(fourCopies);
    mergeCluster(ds, "@I1@", ["@I1@", "@I2@", "@I3@", "@I4@"], [], tr);

    const survivor = ds.individuals.get("@I1@")!;
    // Birth from the survivor, death from @I2@, occupation from @I3@.
    expect(survivor.events.find((e) => e.tag === "BIRT")?.date?.day).toBe(22);
    expect(survivor.events.some((e) => e.tag === "DEAT" && e.date?.year === 1944)).toBe(true);
    expect(survivor.events.some((e) => e.tag === "OCCU")).toBe(true);
    // And the marriage it already had.
    expect(survivor.spouseOf).toEqual(["@F1@"]);
  });

  it("is exactly the same as running the pairwise merges by hand", () => {
    const members = ["@I1@", "@I2@", "@I3@", "@I4@"];
    const viaCluster = dataset(fourCopies);
    mergeCluster(viaCluster, "@I1@", members, [], tr);

    // The steps the planner produced, replayed through the pairwise chain the
    // Merge button uses. A cluster merge must never be able to drift from it.
    const byHand = dataset(fourCopies);
    const steps = clusterMergeSteps(byHand, "@I1@", members, []);
    mergeDuplicateChain(byHand, steps, tr);

    expect(snapshot(viaCluster)).toBe(snapshot(byHand));
  });

  it("composes one undo entry that restores the whole cluster", () => {
    const ds = dataset(fourCopies);
    const original = new Map(
      [...ds.individuals.keys(), ...ds.families.keys()].map((id) => [
        id,
        serializeGedcom([(ds.individuals.get(id) ?? ds.families.get(id))!.raw]),
      ]),
    );

    const { patches, removedIds } = mergeCluster(ds, "@I1@", ["@I1@", "@I2@", "@I3@", "@I4@"], [], tr);

    // Each record appears once, and its `before` is the state from before the
    // first step that touched it — so a single undo puts the file back.
    const ids = patches.map((p) => `${p.type}:${p.id}`);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of patches) {
      expect(p.before === null ? null : serializeGedcom([p.before])).toBe(original.get(p.id) ?? null);
    }
    expect(patches.filter((p) => p.after === null).map((p) => p.id).sort()).toEqual([
      "@I2@",
      "@I3@",
      "@I4@",
    ]);
    expect([...removedIds].sort()).toEqual(["@I2@", "@I3@", "@I4@"]);
  });

  it("does nothing when the cluster is a single record", () => {
    const ds = dataset(fourCopies);
    expect(mergeCluster(ds, "@I1@", ["@I1@"], [], tr).patches).toEqual([]);
    expect(ds.individuals.size).toBe(5);
  });

  it("absorbs in a fixed order, whatever order the members arrive in", () => {
    const forward = dataset(fourCopies);
    mergeCluster(forward, "@I1@", ["@I1@", "@I2@", "@I3@", "@I4@"], [], tr);
    const shuffled = dataset(fourCopies);
    mergeCluster(shuffled, "@I1@", ["@I4@", "@I2@", "@I1@", "@I3@"], [], tr);

    expect(snapshot(shuffled)).toBe(snapshot(forward));
  });
});

describe("clusterRelativeGroups", () => {
  it("gathers one relative's copies across the whole cluster into one tick", () => {
    const ds = dataset(threeCouples);
    const groups = clusterRelativeGroups(ds, "@W1@", ["@W1@", "@W2@", "@W3@"], tr);

    expect(groups.length).toBe(1);
    expect(groups[0].memberIds).toEqual(["@H1@", "@H2@", "@H3@"]);
    expect(groups[0].relation).toBe("partner");
    expect(groups[0].when).toBe("before");
    expect(groups[0].score).toBeGreaterThan(0);
  });

  it("leaves the survivor in three unfoldable marriages when the group is not ticked", () => {
    const ds = dataset(threeCouples);
    mergeCluster(ds, "@W1@", ["@W1@", "@W2@", "@W3@"], [], tr);

    // Each husband is still his own record, so nothing can fold: this is the
    // outcome the tick exists to prevent.
    expect(ds.individuals.get("@W1@")!.spouseOf.length).toBe(3);
    expect(validateDataset(ds).counts.brokenLink).toBe(0);
  });

  it("folds the marriages into one when the group is ticked", () => {
    const ds = dataset(threeCouples);
    const groups = clusterRelativeGroups(ds, "@W1@", ["@W1@", "@W2@", "@W3@"], tr);
    mergeCluster(ds, "@W1@", ["@W1@", "@W2@", "@W3@"], groups, tr);

    const wife = ds.individuals.get("@W1@")!;
    expect(wife.spouseOf.length).toBe(1);
    const fam = ds.families.get(wife.spouseOf[0])!;
    expect(fam.husband).toBe("@H1@");
    // The marriage fact from the one family that had it survives the fold.
    expect(fam.events.some((e) => e.tag === "MARR" && e.date?.year === 1910)).toBe(true);
    expect(["@H2@", "@H3@"].some((id) => ds.individuals.has(id))).toBe(false);
    expect(validateDataset(ds).counts.brokenLink).toBe(0);
  });

  it("runs partner groups before the cluster's own records", () => {
    const ds = dataset(threeCouples);
    const groups = clusterRelativeGroups(ds, "@W1@", ["@W1@", "@W2@", "@W3@"], tr);
    const steps = clusterMergeSteps(ds, "@W1@", ["@W1@", "@W2@", "@W3@"], groups);

    const firstWifeStep = steps.findIndex((s) => s.survivorId === "@W1@");
    const lastHusbandStep = steps.map((s) => s.survivorId).lastIndexOf("@H1@");
    expect(lastHusbandStep).toBeLessThan(firstWifeStep);
    expect([...new Set(steps.map((s) => s.removedId))].sort()).toEqual(["@H2@", "@H3@", "@W2@", "@W3@"]);
  });

  it("does not follow a relative's own relatives — the cascade stops at one hop", () => {
    // Each husband copy also has his own copy of a father. Those fathers are a
    // duplicate too, but they are the husbands' relatives, not the wives': one
    // tick must not walk the whole file.
    const ds = dataset(wrap(
      "0 @W1@ INDI\n1 NAME Neža /Gutovnik/\n1 SEX F\n1 BIRT\n2 DATE 3 MAR 1890\n1 FAMS @F1@\n" +
        "0 @W2@ INDI\n1 NAME Neža /Gutovnik/\n1 SEX F\n1 BIRT\n2 DATE 3 MAR 1890\n1 FAMS @F2@\n" +
        "0 @H1@ INDI\n1 NAME Franc /Stopar/\n1 SEX M\n1 BIRT\n2 DATE 8 AUG 1886\n1 FAMS @F1@\n1 FAMC @P1@\n" +
        "0 @H2@ INDI\n1 NAME Franc /Stopar/\n1 SEX M\n1 BIRT\n2 DATE 8 AUG 1886\n1 FAMS @F2@\n1 FAMC @P2@\n" +
        "0 @D1@ INDI\n1 NAME Ožbolt /Stopar/\n1 SEX M\n1 BIRT\n2 DATE 1860\n1 FAMS @P1@\n" +
        "0 @D2@ INDI\n1 NAME Ožbolt /Stopar/\n1 SEX M\n1 BIRT\n2 DATE 1860\n1 FAMS @P2@\n" +
        "0 @F1@ FAM\n1 HUSB @H1@\n1 WIFE @W1@\n" +
        "0 @F2@ FAM\n1 HUSB @H2@\n1 WIFE @W2@\n" +
        "0 @P1@ FAM\n1 HUSB @D1@\n1 CHIL @H1@\n" +
        "0 @P2@ FAM\n1 HUSB @D2@\n1 CHIL @H2@\n",
    ));
    const groups = clusterRelativeGroups(ds, "@W1@", ["@W1@", "@W2@"], tr);
    const touched = new Set(groups.flatMap((g) => g.memberIds));

    expect(touched).toEqual(new Set(["@H1@", "@H2@"]));
    expect(touched.has("@D1@")).toBe(false);
  });

  it("offers a duplicated child with its score, to merge after the chain", () => {
    // A child is aligned across the two sides by name and date, so the pair
    // carries its own score for the user to judge — and it is held to
    // RELATED_CHILD_MIN_SCORE, the same floor the pairwise panel applies.
    const ds = dataset(wrap(
      "0 @W1@ INDI\n1 NAME Ana /Kos/\n1 SEX F\n1 BIRT\n2 DATE 4 APR 1870\n1 FAMS @F1@\n" +
        "0 @W2@ INDI\n1 NAME Ana /Kos/\n1 SEX F\n1 BIRT\n2 DATE 4 APR 1870\n1 FAMS @F2@\n" +
        "0 @C1@ INDI\n1 NAME Jože /Kos/\n1 SEX M\n1 BIRT\n2 DATE 1 JAN 1900\n1 FAMC @F1@\n" +
        "0 @C2@ INDI\n1 NAME Jože /Kos/\n1 SEX M\n1 BIRT\n2 DATE 1 JAN 1900\n1 FAMC @F2@\n" +
        "0 @F1@ FAM\n1 WIFE @W1@\n1 CHIL @C1@\n" +
        "0 @F2@ FAM\n1 WIFE @W2@\n1 CHIL @C2@\n",
    ));
    const groups = clusterRelativeGroups(ds, "@W1@", ["@W1@", "@W2@"], tr);
    const child = groups.find((g) => g.relation === "child");

    expect(child).toBeDefined();
    expect(child!.when).toBe("after");
    expect(child!.score).toBeGreaterThanOrEqual(RELATED_CHILD_MIN_SCORE);
    // A child whose birth date disagrees is not even lined up as one row — the
    // comparison keeps the namesake-after-a-death case apart on its own.
    expect(makeDuplicatePair(ds, "@C1@", "@C2@")!.score).toBeGreaterThan(0);
  });
});

describe("membersWithoutDirectPair", () => {
  it("names the members that only joined through a chain", () => {
    const ds = dataset(threeCouples);
    const cluster = clusterDuplicates(findDuplicates(ds))[0];
    // Every wife matched every other wife, so nothing is indirect.
    expect(membersWithoutDirectPair(cluster, cluster.memberIds[0])).toEqual([]);
  });

  it("reports a chain-only member against the record it never met", () => {
    const cluster = clusterDuplicates([
      { aId: "@A@", bId: "@B@", aLabel: "a", bLabel: "b", score: 95, category: "strong" },
      { aId: "@B@", bId: "@C@", aLabel: "b", bLabel: "c", score: 95, category: "strong" },
    ])[0];

    expect(membersWithoutDirectPair(cluster, "@A@")).toEqual(["@C@"]);
    expect(membersWithoutDirectPair(cluster, "@B@")).toEqual([]);
  });
});
