import { describe, expect, it } from "vitest";
import { parseGedcom } from "./parser";
import { buildDataset } from "./builder";
import {
  buildAssociationIndex,
  isVoidAssociation,
  parseAssociation,
  repointAssociations,
  roleFromRela,
} from "./assoc";
import type { GedNode } from "./types";

function toBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

function node(tag: string, value?: string, children: GedNode[] = []): GedNode {
  return { level: 1, tag, value, children };
}

/** A 5.5.1 file whose baptism witnesses sit at record level, as the dialect requires. */
const V551 = `0 HEAD
1 GEDC
2 VERS 5.5.1
2 FORM LINEAGE-LINKED
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Janez /Renko/
1 BAPM
2 DATE 31 AUG 1958
1 ASSO @I2@
2 TYPE INDI
2 RELA botra
1 ASSO @F1@
2 TYPE FAM
2 RELA Witness at event _EVN 29
0 @I2@ INDI
1 NAME Jozefa /Pezdirc/
0 @F1@ FAM
1 HUSB @I1@
0 TRLR
`;

/** A 7.0 file with the association on the event it belongs to, plus a
 *  name-only godparent the file records as nobody. */
const V70 = `0 HEAD
1 GEDC
2 VERS 7.0
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Janez /Renko/
1 BAPM
2 DATE 31 AUG 1958
2 ASSO @I2@
3 ROLE GODP
2 ASSO @VOID@
3 PHRASE Anton Pezdirc, posestnik
3 ROLE GODP
2 ASSO @I3@
3 ROLE OTHER
4 PHRASE family lawyer
0 @I2@ INDI
1 NAME Jozefa /Pezdirc/
0 @I3@ INDI
1 NAME Franc /Presetnik/
0 TRLR
`;

describe("roleFromRela", () => {
  it("maps the vocabulary in both languages", () => {
    expect(roleFromRela("witness")).toBe("WITN");
    expect(roleFromRela("Witness")).toBe("WITN");
    expect(roleFromRela("boter")).toBe("GODP");
    expect(roleFromRela("botra")).toBe("GODP");
    expect(roleFromRela("priča")).toBe("WITN");
    expect(roleFromRela("duhovnik")).toBe("CLERGY");
  });

  it("reads the leading word of a vendor's sentence", () => {
    // 351 of the corpus's 411 associations are worded this way.
    expect(roleFromRela("Witness at event _EVN 29")).toBe("WITN");
  });

  it("falls back to OTHER rather than guessing", () => {
    expect(roleFromRela("family lawyer")).toBe("OTHER");
    expect(roleFromRela("")).toBe("OTHER");
  });
});

describe("parseAssociation", () => {
  it("reads a 5.5.1 RELA association, keeping the file's own wording", () => {
    const assoc = parseAssociation(
      node("ASSO", "@I2@", [node("TYPE", "INDI"), node("RELA", "botra")]),
    );
    expect(assoc).toMatchObject({ targetId: "@I2@", targetKind: "INDI", role: "GODP", roleText: "botra" });
  });

  it("reads a 7.0 ROLE association and its PHRASE", () => {
    const assoc = parseAssociation(
      node("ASSO", "@I3@", [node("ROLE", "OTHER", [node("PHRASE", "family lawyer")])]),
    );
    expect(assoc).toMatchObject({ role: "OTHER", roleText: "family lawyer" });
  });

  it("reads a name-only @VOID@ association", () => {
    const assoc = parseAssociation(
      node("ASSO", "@VOID@", [node("PHRASE", "Anton Pezdirc"), node("ROLE", "GODP")]),
    )!;
    expect(assoc.name).toBe("Anton Pezdirc");
    expect(assoc.role).toBe("GODP");
    expect(isVoidAssociation(assoc)).toBe(true);
  });

  it("ignores an ASSO that names no target", () => {
    expect(parseAssociation(node("ASSO", undefined, [node("RELA", "witness")]))).toBeUndefined();
  });
});

describe("builder", () => {
  it("puts 5.5.1 record-level associations on the individual", () => {
    const ds = buildDataset(parseGedcom(toBuffer(V551)));
    const indi = ds.individuals.get("@I1@")!;
    expect(indi.associations).toHaveLength(2);
    expect(indi.associations![0]).toMatchObject({ targetId: "@I2@", role: "GODP" });
    expect(indi.associations![1]).toMatchObject({ targetId: "@F1@", targetKind: "FAM", role: "WITN" });
    expect(indi.events[0].associations).toBeUndefined();
  });

  it("puts 7.0 event-level associations on the event", () => {
    const ds = buildDataset(parseGedcom(toBuffer(V70)));
    const indi = ds.individuals.get("@I1@")!;
    expect(indi.associations).toBeUndefined();
    const bapm = indi.events.find((e) => e.tag === "BAPM")!;
    expect(bapm.associations).toHaveLength(3);
    expect(bapm.associations![1].name).toBe("Anton Pezdirc, posestnik");
  });

  it("does not mistake an association for a record-level link", () => {
    const ds = buildDataset(parseGedcom(toBuffer(V551)));
    expect(ds.individuals.get("@I1@")!.links).toBeUndefined();
  });
});

describe("buildAssociationIndex", () => {
  it("indexes record-level and event-level associations by who they name", () => {
    const ds551 = buildDataset(parseGedcom(toBuffer(V551)));
    const index551 = buildAssociationIndex(ds551);
    expect(index551.get("@I2@")).toMatchObject([{ fromId: "@I1@", fromKind: "individual" }]);
    expect(index551.get("@I2@")![0].eventTag).toBeUndefined();
    expect(index551.get("@F1@")).toHaveLength(1);

    const ds70 = buildDataset(parseGedcom(toBuffer(V70)));
    const index70 = buildAssociationIndex(ds70);
    expect(index70.get("@I2@")).toMatchObject([{ fromId: "@I1@", eventTag: "BAPM" }]);
  });

  it("leaves a name-only association out — it points at no record", () => {
    const index = buildAssociationIndex(buildDataset(parseGedcom(toBuffer(V70))));
    expect(index.has("@VOID@")).toBe(false);
  });
});

describe("repointAssociations", () => {
  it("repoints a merged duplicate onto its survivor, at both levels", () => {
    for (const text of [V551, V70]) {
      const ds = buildDataset(parseGedcom(toBuffer(text)));
      expect(repointAssociations(ds.records, "@I2@", "@I9@")).toEqual(["@I1@"]);
      // The index reads the raw nodes the repoint mutated, so re-indexing the
      // same dataset shows the move.
      const again = buildAssociationIndex(ds);
      expect(again.has("@I2@")).toBe(false);
      expect(again.get("@I9@")).toHaveLength(1);
    }
  });

  it("drops the association when the person is gone for good", () => {
    const ds = buildDataset(parseGedcom(toBuffer(V70)));
    expect(repointAssociations(ds.records, "@I2@")).toEqual(["@I1@"]);
    const bapm = ds.records.find((r) => r.xref === "@I1@")!.children.find((c) => c.tag === "BAPM")!;
    expect(bapm.children.filter((c) => c.tag === "ASSO")).toHaveLength(2);
  });

  it("leaves records that name nobody alone", () => {
    const ds = buildDataset(parseGedcom(toBuffer(V70)));
    expect(repointAssociations(ds.records, "@I404@", "@I9@")).toEqual([]);
  });
});
