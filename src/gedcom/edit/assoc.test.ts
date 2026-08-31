import { describe, expect, it } from "vitest";
import { parseGedcom } from "../parser";
import { buildDataset } from "../builder";
import { serializeGedcom } from "../serialize";
import { firstChild } from "../node";
import { associationsIn } from "../assoc";
import { addAssociation, canWriteNameOnly, moveAssociation, removeAssociation, writeAssociation } from "./assoc";
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

  it("writes a 5.5.1 association as TYPE + free-text RELA", () => {
    const ds = dataset("5.5.1", BODY);
    addAssociation(bapm(ds), { targetId: "@I2@", role: "GODP" }, ds.version);

    expect(serializeGedcom([ds.individuals.get("@I1@")!.raw])).toContain(
      "2 ASSO @I2@\n3 TYPE INDI\n3 RELA godparent",
    );
    // The dialect has no way to name someone it holds no record for.
    expect(canWriteNameOnly(ds.version)).toBe(false);
    expect(canWriteNameOnly("7.0")).toBe(true);
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
