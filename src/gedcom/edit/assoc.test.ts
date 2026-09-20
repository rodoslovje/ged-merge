import { describe, expect, it } from "vitest";
import { parseGedcom } from "../parser";
import { buildDataset } from "../builder";
import { serializeGedcom } from "../serialize";
import { firstChild } from "../node";
import { associationsIn } from "../assoc";
import {
  addAssociation,
  canWriteEventAssociation,
  canWriteFamilyAssociation,
  canWriteNameOnly,
  moveAssociation,
  removeAssociation,
  setAssociationNotes,
  writeAssociation,
} from "./assoc";
import { noteCtx } from "./notes";
import type { GedNode } from "../types";

function dataset(version: "5.5.1" | "7.0", body: string) {
  const head = version === "7.0" ? "0 HEAD\n1 GEDC\n2 VERS 7.0\n1 CHAR UTF-8\n" : "0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n";
  return buildDataset(parseGedcom(new TextEncoder().encode(`${head}${body}0 TRLR\n`).buffer));
}

const BODY =
  "0 @I1@ INDI\n1 NAME Janez /Renko/\n1 BAPM\n2 DATE 31 AUG 1958\n2 SOUR @S1@\n" +
  "0 @I2@ INDI\n1 NAME Jozefa /Pezdirc/\n0 @S1@ SOUR\n1 TITL Krstna knjiga\n";

/** The person's baptism node — where an association is written. */
function bapm(ds: ReturnType<typeof dataset>): GedNode {
  return ds.individuals.get("@I1@")!.raw.children.find((c) => c.tag === "BAPM")!;
}

describe("writing associations", () => {
  it("writes a 7.0 association as a ROLE enum under the event", () => {
    const ds = dataset("7.0", BODY);
    addAssociation(bapm(ds), { targetId: "@I2@", role: "GODP" }, ds.version);

    expect(serializeGedcom([ds.individuals.get("@I1@")!.raw])).toContain("2 ASSO @I2@\n3 ROLE GODP");
  });

  it("keeps the file's own wording as a PHRASE", () => {
    const ds = dataset("7.0", BODY);
    addAssociation(bapm(ds), { targetId: "@I2@", role: "OTHER", roleText: "botra" }, ds.version);

    const text = serializeGedcom([ds.individuals.get("@I1@")!.raw]);
    expect(text).toContain("3 ROLE OTHER\n4 PHRASE botra");
  });

  it("records a name-only associate as @VOID@ plus a PHRASE in 7.0", () => {
    const ds = dataset("7.0", BODY);
    addAssociation(bapm(ds), { name: "Anton Pezdirc, posestnik", role: "GODP" }, ds.version);

    const text = serializeGedcom([ds.individuals.get("@I1@")!.raw]);
    expect(text).toContain("2 ASSO @VOID@\n3 PHRASE Anton Pezdirc, posestnik\n3 ROLE GODP");
    // …and reading it back gives the name, not a pointer to chase.
    expect(associationsIn(bapm(ds))[0]).toMatchObject({ name: "Anton Pezdirc, posestnik", role: "GODP" });
  });

  it("writes a 5.5.1 association as a bare pointer plus free-text RELA", () => {
    const ds = dataset("5.5.1", BODY);
    // Record level, which is the only place 5.5.1 defines ASSO.
    const record = ds.individuals.get("@I1@")!.raw;
    addAssociation(record, { targetId: "@I2@", role: "GODP" }, ds.version);

    // No `TYPE`: 5.5 had it because its ASSO could point at any record, 5.5.1
    // dropped both, and the spec's own example is `ASSO @I2@` / `RELA Godfather`.
    expect(serializeGedcom([record])).toContain("1 ASSO @I2@\n2 RELA godparent");
    expect(serializeGedcom([record])).not.toContain("TYPE INDI");
    // The dialect has no way to name someone it holds no record for.
    expect(canWriteNameOnly(ds.version)).toBe(false);
    expect(canWriteNameOnly("7.0")).toBe(true);
  });

  it("keeps the TYPE FAM of an association that points at a family", () => {
    // 5.5-era files do this — a witness at that couple's marriage. Rewriting the
    // role must not cost the one line saying the pointer is not a person.
    const ds = dataset("5.5.1", "0 @I1@ INDI\n1 ASSO @F1@\n2 TYPE FAM\n2 RELA witness\n0 @F1@ FAM\n1 HUSB @I2@\n0 @I2@ INDI\n1 NAME Janez /Renko/\n");
    const record = ds.individuals.get("@I1@")!.raw;
    const assoc = associationsIn(record)[0];
    expect(assoc.targetKind).toBe("FAM");

    writeAssociation(assoc.raw, { targetId: "@F1@", role: "WITN", targetKind: assoc.targetKind }, ds.version);

    expect(serializeGedcom([record])).toContain("1 ASSO @F1@\n2 TYPE FAM\n2 RELA witness");
  });

  it("says which dialect can carry an association where", () => {
    // 7.0 lists ASSOCIATION_STRUCTURE under INDI, under FAM and inside
    // EVENT_DETAIL; 5.5.1 lists it under INDI and nowhere else. An unrecognised
    // version counts as the older dialect, like `canWriteNameOnly`.
    expect(canWriteEventAssociation("7.0")).toBe(true);
    expect(canWriteFamilyAssociation("7.0")).toBe(true);
    expect(canWriteEventAssociation("5.5.1")).toBe(false);
    expect(canWriteFamilyAssociation("5.5.1")).toBe(false);
    expect(canWriteEventAssociation("unknown")).toBe(false);
    expect(canWriteFamilyAssociation("unknown")).toBe(false);
  });

  it("puts a record-level association after the family links, before the notes", () => {
    const ds = dataset("7.0", "0 @I1@ INDI\n1 NAME Janez /Renko/\n1 FAMS @F1@\n1 NOTE later\n0 @I2@ INDI\n1 NAME Jozefa /Pezdirc/\n");
    const record = ds.individuals.get("@I1@")!.raw;
    addAssociation(record, { targetId: "@I2@", role: "OTHER", roleText: "DNA match" }, ds.version);

    expect(record.children.map((c) => c.tag)).toEqual(["NAME", "FAMS", "ASSO", "NOTE"]);
    expect(serializeGedcom([record])).toContain("1 ASSO @I2@\n2 ROLE OTHER\n3 PHRASE DNA match");
  });

  it("carries a family's own associates on the FAM record", () => {
    const ds = dataset("7.0", "0 @F1@ FAM\n1 HUSB @I1@\n1 MARR\n2 DATE 1899\n0 @I1@ INDI\n1 NAME Janez /Renko/\n0 @I2@ INDI\n1 NAME Jozefa /Pezdirc/\n");
    const fam = ds.families.get("@F1@")!.raw;
    addAssociation(fam, { targetId: "@I2@", role: "WITN" }, ds.version);

    expect(fam.children.map((c) => c.tag)).toEqual(["HUSB", "MARR", "ASSO"]);
    expect(associationsIn(fam)).toMatchObject([{ targetId: "@I2@", role: "WITN" }]);
  });

  it("puts the association before the event's citations, not after them", () => {
    const ds = dataset("7.0", BODY);
    addAssociation(bapm(ds), { targetId: "@I2@", role: "WITN" }, ds.version);

    const tags = bapm(ds).children.map((c) => c.tag);
    expect(tags).toEqual(["DATE", "ASSO", "SOUR"]);
  });

  it("rewrites a role in place, leaving the association's own evidence alone", () => {
    const ds = dataset("7.0", BODY);
    const node = addAssociation(bapm(ds), { targetId: "@I2@", role: "GODP" }, ds.version);
    node.children.push({ level: 3, tag: "NOTE", value: "from the register", children: [] });

    writeAssociation(node, { targetId: "@I2@", role: "WITN" }, ds.version);

    expect(firstChild(node, "ROLE")?.value).toBe("WITN");
    expect(firstChild(node, "NOTE")?.value).toBe("from the register");
    // No second ROLE left behind by the rewrite.
    expect(node.children.filter((c) => c.tag === "ROLE")).toHaveLength(1);
  });

  it("moves a record-level association onto an event, whole", () => {
    const ds = dataset("7.0", BODY);
    const record = ds.individuals.get("@I1@")!.raw;
    const node = addAssociation(record, { targetId: "@I2@", role: "GODP", roleText: "botra" }, ds.version);
    node.children.push({ level: 2, tag: "NOTE", value: "from the register", children: [] });

    moveAssociation(record, bapm(ds), node);

    expect(record.children.some((c) => c.tag === "ASSO")).toBe(false);
    const moved = associationsIn(bapm(ds));
    expect(moved).toHaveLength(1);
    // Role, wording and the note it carried all travel with it…
    expect(moved[0]).toMatchObject({ targetId: "@I2@", role: "GODP", roleText: "botra" });
    expect(firstChild(moved[0].raw, "NOTE")?.value).toBe("from the register");
    // …and it serializes at the event's depth, not the record's.
    expect(serializeGedcom([record])).toContain("2 ASSO @I2@\n3 ROLE GODP\n4 PHRASE botra\n3 NOTE from the register");
  });

  it("ignores a move to where it already is", () => {
    const ds = dataset("7.0", BODY);
    const node = addAssociation(bapm(ds), { targetId: "@I2@", role: "GODP" }, ds.version);
    moveAssociation(bapm(ds), bapm(ds), node);
    expect(associationsIn(bapm(ds))).toHaveLength(1);
  });

  it("keeps notes on the association itself, and reads them back", () => {
    // `ASSO` carries `<<NOTE_STRUCTURE>>` in both dialects, so the numbers
    // behind a DNA match belong on the association, not on the whole record.
    const ds = dataset("7.0", "0 @I1@ INDI\n1 NAME Janez /Renko/\n0 @I2@ INDI\n1 NAME Jozefa /Pezdirc/\n");
    const record = ds.individuals.get("@I1@")!.raw;
    const node = addAssociation(record, { targetId: "@I2@", role: "OTHER", roleText: "DNA match" }, ds.version);

    setAssociationNotes(noteCtx(ds.records), node, [{ text: "78 cM over 4 segments, largest 31 cM" }]);

    expect(serializeGedcom([record])).toContain(
      "1 ASSO @I2@\n2 ROLE OTHER\n3 PHRASE DNA match\n2 NOTE 78 cM over 4 segments, largest 31 cM",
    );
    // And the built dataset hands them to the editor like any other notes.
    const rebuilt = buildDataset(parseGedcom(new TextEncoder().encode(serializeGedcom(ds.records)).buffer));
    expect(rebuilt.individuals.get("@I1@")!.associations?.[0].noteRefs).toEqual([
      { text: "78 cM over 4 segments, largest 31 cM" },
    ]);
  });

  it("leaves an association's notes alone when its role is rewritten", () => {
    const ds = dataset("7.0", "0 @I1@ INDI\n1 ASSO @I2@\n2 ROLE GODP\n2 NOTE from the register\n0 @I2@ INDI\n");
    const node = ds.individuals.get("@I1@")!.associations![0].raw;

    writeAssociation(node, { targetId: "@I2@", role: "WITN" }, ds.version);

    expect(firstChild(node, "NOTE")?.value).toBe("from the register");
  });

  it("removes an association without touching its neighbours", () => {
    const ds = dataset("7.0", BODY);
    const first = addAssociation(bapm(ds), { targetId: "@I2@", role: "GODP" }, ds.version);
    addAssociation(bapm(ds), { name: "Anton Pezdirc", role: "GODP" }, ds.version);

    removeAssociation(bapm(ds), first);

    const left = associationsIn(bapm(ds));
    expect(left).toHaveLength(1);
    expect(left[0].name).toBe("Anton Pezdirc");
    expect(firstChild(bapm(ds), "SOUR")?.value).toBe("@S1@");
  });
});
