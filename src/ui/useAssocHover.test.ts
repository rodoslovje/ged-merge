import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { buildAssociationIndex } from "../gedcom/assoc";
import type { Individual } from "../gedcom/types";
import { assocHoverLines } from "./useAssocHover";

const dataset = (text: string) => buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
// The key with its context, so a test reads which form was asked for.
const t = (key: string, opts?: Record<string, unknown>) => (opts?.context ? `${key}_${opts.context as string}` : key);
const nameOf = (indi: Individual) => indi.id;

describe("assocHoverLines", () => {
  const ds = dataset(
    `0 HEAD\n1 GEDC\n2 VERS 7.0\n` +
      `0 @C@ INDI\n1 SEX M\n1 BIRT\n2 ASSO @G@\n3 ROLE GODP\n2 ASSO @H@\n3 ROLE GODP\n2 ASSO @VOID@\n3 PHRASE Marina\n3 ROLE GODP\n` +
      `1 ASSO @P@\n2 ROLE OTHER\n` +
      `0 @D@ INDI\n1 BIRT\n2 ASSO @G@\n3 ROLE GODP\n` +
      `0 @G@ INDI\n1 SEX M\n1 FAMS @F1@\n0 @H@ INDI\n1 SEX F\n0 @P@ INDI\n` +
      `0 @F1@ FAM\n1 HUSB @G@\n1 MARR\n2 ASSO @H@\n3 ROLE WITN\n` +
      `0 TRLR\n`,
  );
  const index = buildAssociationIndex(ds);
  const lines = (id: string) => assocHoverLines(t, ds, ds.individuals.get(id)!, index.get(id), nameOf);

  it("names a person's own associates, each in their own form of the role", () => {
    // The record's own associate first; "other" is no role worth a word; a
    // godmother the file only names is named too.
    expect(lines("@C@")).toEqual(["@P@, assoc.role.GODP_M @G@, assoc.role.GODP_F @H@, assoc.role.GODP Marina"]);
  });

  it("counts where they are named, by role, in their own form", () => {
    expect(lines("@G@")).toEqual(["Assoc.role.GODP_M 2×"]);
    expect(lines("@H@")).toEqual(["Assoc.role.GODP_F 1×, assoc.role.WITN_F 1×"]);
  });

  it("says nothing of a person no association touches", () => {
    expect(lines("@D@")).toEqual(["Assoc.role.GODP_M @G@"]);
    expect(lines("@P@")).toEqual(["Assoc.role.OTHER 1×"]);
    const lone = dataset(`0 HEAD\n1 GEDC\n2 VERS 7.0\n0 @A@ INDI\n0 TRLR\n`);
    expect(assocHoverLines(t, lone, lone.individuals.get("@A@")!, undefined, nameOf)).toEqual([]);
  });
});
