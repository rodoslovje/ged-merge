import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { applyPlaceRename, collectPlaceSegments, previewPlaceRename } from "./placeEdit";
import { buildPlaceTree, collectNodeUseIds, UNSPECIFIED } from "./places";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;

/** One individual with a single BIRT.PLAC — the smallest thing that exercises a rename. */
const withPlace = (plac: string) =>
  dataset(wrap(`0 @I1@ INDI\n1 NAME A /B/\n1 BIRT\n2 PLAC ${plac}\n`));

/** The transformed value of the first (only) place in the dataset. */
function renamed(plac: string, from: string, to: string): string | undefined {
  const preview = previewPlaceRename(withPlace(plac), from, to);
  return preview.examples[0]?.after;
}

describe("renaming a comma segment", () => {
  it("replaces an exact segment and leaves its siblings alone", () => {
    expect(renamed("Sveti Nikole, Macedonia (FYR)", "Macedonia (FYR)", "North Macedonia"))
      .toBe("Sveti Nikole, North Macedonia");
  });

  it("matches on the trimmed segment but preserves the original spacing", () => {
    expect(renamed("Kranj,  Slovenija ", "Slovenija", "Slovenia")).toBe("Kranj,  Slovenia ");
  });

  it("renames every occurrence of the segment in one value", () => {
    expect(renamed("Kranj, SI, Vrba, SI", "SI", "Slovenia")).toBe("Kranj, Slovenia, Vrba, Slovenia");
  });

  it("does not match a partial or differently-cased segment", () => {
    expect(renamed("Kranjska Gora", "Kranj", "Kranj mesto")).toBeUndefined();
    expect(renamed("Kranj", "kranj", "x")).toBeUndefined();
  });

  it("leaves a value with no match untouched", () => {
    expect(previewPlaceRename(withPlace("Ljubljana"), "Kranj", "X").examples).toEqual([]);
  });
});

describe("renaming a parenthetical country", () => {
  it("replaces the country inside parentheses", () => {
    expect(renamed("Skopje (Macedonia)", "Macedonia", "North Macedonia")).toBe("Skopje (North Macedonia)");
  });

  it("replaces the country inside square brackets, keeping the bracket kind", () => {
    expect(renamed("Skopje [Macedonia]", "Macedonia", "North Macedonia")).toBe("Skopje [North Macedonia]");
    // Mismatched brackets aren't a country parenthetical — left alone.
    expect(renamed("Skopje (Macedonia]", "Macedonia", "North Macedonia")).toBeUndefined();
  });

  it("tolerates padding inside the parentheses", () => {
    expect(renamed("Skopje ( Macedonia )", "Macedonia", "North Macedonia")).toBe("Skopje ( North Macedonia )");
  });

  it("treats regex metacharacters in the search term literally", () => {
    // "Macedonia (FYR)" carries parens of its own — it must be escaped, not
    // compiled as a group, or the lookup would silently match nothing.
    expect(renamed("Sveti Nikole (Macedonia (FYR))", "Macedonia (FYR)", "North Macedonia"))
      .toBe("Sveti Nikole (North Macedonia)");
  });

  it("handles both forms appearing in one value", () => {
    expect(renamed("Skopje (Macedonia), Macedonia", "Macedonia", "North Macedonia"))
      .toBe("Skopje (North Macedonia), North Macedonia");
  });
});

describe("appending jurisdiction levels", () => {
  it("appends the extra level when it is absent", () => {
    expect(renamed("London, England", "England", "England,United Kingdom"))
      .toBe("London, England,United Kingdom");
  });

  it("skips a segment whose following levels already match, avoiding a duplicate parent", () => {
    expect(renamed("London, England, United Kingdom", "England", "England,United Kingdom"))
      .toBeUndefined();
  });

  it("ignores empty segments when looking ahead", () => {
    // "England,,United Kingdom" must read the same as "England, United Kingdom".
    expect(renamed("London, England,,United Kingdom", "England", "England,United Kingdom"))
      .toBeUndefined();
  });

  it("compares the following levels case-insensitively", () => {
    expect(renamed("London, England, UNITED KINGDOM", "England", "England,United Kingdom"))
      .toBeUndefined();
  });

  it("still appends when only some of the following levels match", () => {
    expect(renamed("London, England, Scotland", "England", "England,United Kingdom"))
      .toBe("London, England,United Kingdom, Scotland");
  });
});

describe("deleting a segment", () => {
  it("removes the segment rather than leaving an empty slot", () => {
    expect(renamed("Kranj, Slovenija, Europe", "Europe", "")).toBe("Kranj, Slovenija");
  });

  it("removes every occurrence", () => {
    expect(renamed("A, X, B, X", "X", "")).toBe("A, B");
  });

  it("leaves a parenthetical alone, so deletion never produces an empty ()", () => {
    expect(renamed("Skopje (Macedonia)", "Macedonia", "")).toBeUndefined();
  });
});

describe("previewPlaceRename", () => {
  const ds = dataset(
    wrap(
      "0 @I1@ INDI\n1 NAME A /B/\n1 BIRT\n2 PLAC Kranj, SI\n1 DEAT\n2 PLAC Bled, SI\n" +
        "0 @I2@ INDI\n1 NAME C /D/\n1 BIRT\n2 PLAC Ljubljana, SI\n" +
        "0 @I3@ INDI\n1 NAME E /F/\n1 BIRT\n2 PLAC Wien, AT\n" +
        "0 @F1@ FAM\n1 MARR\n2 PLAC Vrba, SI\n",
    ),
  );

  it("counts affected records, not affected values", () => {
    // @I1@ has two matching places but is one record; @I2@ one; @F1@ one.
    expect(previewPlaceRename(ds, "SI", "Slovenia").affectedCount).toBe(3);
  });

  it("includes families as well as individuals", () => {
    expect(previewPlaceRename(ds, "Vrba", "Vrba vas").affectedCount).toBe(1);
  });

  it("reports zero for a segment nothing carries", () => {
    const preview = previewPlaceRename(ds, "Nowhere", "X");
    expect(preview).toEqual({ affectedCount: 0, examples: [] });
  });

  it("honours a scope set", () => {
    const scoped = previewPlaceRename(ds, "SI", "Slovenia", new Set(["@I2@"]));
    expect(scoped.affectedCount).toBe(1);
    expect(scoped.examples).toEqual([{ before: "Ljubljana, SI", after: "Ljubljana, Slovenia" }]);
  });

  it("caps the examples at five", () => {
    const many = dataset(
      wrap(
        Array.from({ length: 9 }, (_, i) => `0 @I${i}@ INDI\n1 NAME A /B/\n1 BIRT\n2 PLAC Town${i}, SI\n`).join(""),
      ),
    );
    const preview = previewPlaceRename(many, "SI", "Slovenia");
    expect(preview.affectedCount).toBe(9);
    expect(preview.examples).toHaveLength(5);
  });

  it("does not mutate the dataset", () => {
    const fresh = withPlace("Kranj, SI");
    previewPlaceRename(fresh, "SI", "Slovenia");
    const plac = fresh.individuals.get("@I1@")!.raw.children[1].children[0];
    expect(plac.value).toBe("Kranj, SI");
  });
});

describe("applyPlaceRename", () => {
  const build = () =>
    dataset(
      wrap(
        "0 @I1@ INDI\n1 NAME A /B/\n1 BIRT\n2 PLAC Kranj, SI\n2 ADDR Glavna 1, SI\n" +
          "0 @I2@ INDI\n1 NAME C /D/\n1 BIRT\n2 PLAC Wien, AT\n" +
          "0 @F1@ FAM\n1 MARR\n2 PLAC Vrba, SI\n",
      ),
    );

  it("rewrites PLAC and ADDR alike, in individuals and families", () => {
    const ds = build();
    applyPlaceRename(ds, "SI", "Slovenia");
    const birt = ds.individuals.get("@I1@")!.raw.children[1];
    expect(birt.children[0].value).toBe("Kranj, Slovenia");
    expect(birt.children[1].value).toBe("Glavna 1, Slovenia");
    expect(ds.families.get("@F1@")!.raw.children[0].children[0].value).toBe("Vrba, Slovenia");
  });

  it("returns one patch per touched record and none for untouched ones", () => {
    const ds = build();
    const patches = applyPlaceRename(ds, "SI", "Slovenia");
    expect(patches.map((p) => p.id).sort()).toEqual(["@F1@", "@I1@"]);
    expect(patches.find((p) => p.id === "@I1@")?.type).toBe("individual");
    expect(patches.find((p) => p.id === "@F1@")?.type).toBe("family");
  });

  it("produces patches whose `before` is the pre-rename state and `after` the new one", () => {
    const ds = build();
    const patch = applyPlaceRename(ds, "SI", "Slovenia").find((p) => p.id === "@I1@")!;
    expect(patch.before).not.toBeNull();
    // `before` must be an independent snapshot, not an alias of the mutated node.
    const beforePlac = patch.before!.children[1].children[0];
    const afterPlac = patch.after!.children[1].children[0];
    expect(beforePlac.value).toBe("Kranj, SI");
    expect(afterPlac.value).toBe("Kranj, Slovenia");
  });

  it("returns no patches when nothing matches", () => {
    const ds = build();
    expect(applyPlaceRename(ds, "Nowhere", "X")).toEqual([]);
  });

  it("honours a scope set, leaving out-of-scope records untouched", () => {
    const ds = build();
    const patches = applyPlaceRename(ds, "SI", "Slovenia", new Set(["@I1@"]));
    expect(patches.map((p) => p.id)).toEqual(["@I1@"]);
    expect(ds.families.get("@F1@")!.raw.children[0].children[0].value).toBe("Vrba, SI");
  });

  it("agrees with what previewPlaceRename promised", () => {
    const preview = previewPlaceRename(build(), "SI", "Slovenia");
    const applied = applyPlaceRename(build(), "SI", "Slovenia");
    expect(applied).toHaveLength(preview.affectedCount);
  });

  it("deletes a segment across the file", () => {
    const ds = build();
    applyPlaceRename(ds, "SI", "");
    expect(ds.individuals.get("@I1@")!.raw.children[1].children[0].value).toBe("Kranj");
  });
});

describe("collectPlaceSegments", () => {
  it("returns distinct, trimmed, sorted segments from PLAC and ADDR", () => {
    const ds = dataset(
      wrap(
        "0 @I1@ INDI\n1 NAME A /B/\n1 BIRT\n2 PLAC Kranj, SI\n2 ADDR Glavna 1,  SI \n" +
          "0 @F1@ FAM\n1 MARR\n2 PLAC Bled, SI\n",
      ),
    );
    expect(collectPlaceSegments(ds)).toEqual(["Bled", "Glavna 1", "Kranj", "SI"]);
  });

  it("skips empty segments left by stray commas", () => {
    expect(collectPlaceSegments(withPlace("Kranj,,SI"))).toEqual(["Kranj", "SI"]);
  });

  it("returns nothing for a dataset with no places", () => {
    expect(collectPlaceSegments(dataset(wrap("0 @I1@ INDI\n1 NAME A /B/\n")))).toEqual([]);
  });
});

describe("rename scope of a family's own place", () => {
  // A marriage place lives on the FAM record but is browsed under its spouses,
  // so the Places tree hands the rename a scope built from the node's uses. If
  // that scope names the people instead of the record, the family is left out
  // of its own rename: the preview reports "no matching records" and applying
  // it changes nothing.
  const build = () =>
    dataset(
      wrap(
        "0 @I1@ INDI\n1 NAME A /B/\n1 FAMS @F1@\n" +
          "0 @I2@ INDI\n1 NAME C /D/\n1 FAMS @F1@\n" +
          "0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n1 MARR\n2 PLAC Sr. Bela\n2 ADDR Sr. Bela 16\n",
      ),
    );
  const placeNode = (ds: ReturnType<typeof build>) =>
    buildPlaceTree(ds).roots.find((r) => r.name === UNSPECIFIED)!.children.find((c) => c.name === "Sr. Bela")!;

  it("carries the FAM id, so the tree's scope reaches the record", () => {
    expect(collectNodeUseIds(placeNode(build()))).toEqual(new Set(["@F1@"]));
  });

  it("renames a place used only by a family, scoped to that node", () => {
    const ds = build();
    const scope = collectNodeUseIds(placeNode(ds));

    expect(previewPlaceRename(ds, "Sr. Bela", "Srednja Bela", scope).affectedCount).toBe(1);
    expect(applyPlaceRename(ds, "Sr. Bela", "Srednja Bela", scope)).toHaveLength(1);
    expect(ds.families.get("@F1@")!.raw.children[2].children[0].value).toBe("Srednja Bela");
  });

  it("renames the address written on a family too", () => {
    const ds = build();
    const addr = placeNode(ds).children.find((c) => c.name === "Sr. Bela 16")!;
    expect(addr.isAddress).toBe(true);
    applyPlaceRename(ds, "Sr. Bela 16", "Srednja Bela 16 (pd Prah)", collectNodeUseIds(addr));
    expect(ds.families.get("@F1@")!.raw.children[2].children[1].value).toBe("Srednja Bela 16 (pd Prah)");
  });
});
