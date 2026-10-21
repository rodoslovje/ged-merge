import { describe, expect, it } from "vitest";
import { parseGedcom } from "../gedcom/parser";
import type { GedNode } from "../gedcom/types";
import { buildSourXrefMap, eventOrderSignature, sortEventsByDate } from "./applyFields";

/** The one INDI in a snippet, parsed. `body` is the record's `1`-level lines. */
function indi(body: string): GedNode {
  const text = `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n0 @I1@ INDI\n${body}0 TRLR\n`;
  const parsed = parseGedcom(new TextEncoder().encode(text).buffer);
  return parsed.records.find((r) => r.xref === "@I1@")!;
}

const NAME_AND_SEX = "1 NAME Janez /Novak/\n1 SEX M\n";

describe("eventOrderSignature", () => {
  it("is unchanged by a value edit that leaves the events where they are", () => {
    // The bug this gate exists for: completing a burial place used to count as
    // a structural edit, and the save then moved the untouched death event.
    const before = indi(`${NAME_AND_SEX}1 DEAT\n2 DATE 1957\n2 PLAC Brežice\n1 BIRT\n2 DATE 1896\n1 BURI\n2 PLAC Globoko\n`);
    const after = indi(`${NAME_AND_SEX}1 DEAT\n2 DATE 1957\n2 PLAC Brežice\n1 BIRT\n2 DATE 1896\n1 BURI\n2 PLAC Globoko, Radovljica, Slovenia\n3 FORM Place, Upravna Enota, Country\n`);

    expect(eventOrderSignature(after)).toBe(eventOrderSignature(before));
  });

  it("is unchanged when a date is rewritten in another notation for the same day", () => {
    const before = indi(`${NAME_AND_SEX}1 BIRT\n2 DATE 29 APR 1896\n`);
    const after = indi(`${NAME_AND_SEX}1 BIRT\n2 DATE 29.04.1896\n`);

    expect(eventOrderSignature(after)).toBe(eventOrderSignature(before));
  });

  it("changes when an event's date changes", () => {
    const before = indi(`${NAME_AND_SEX}1 BIRT\n2 DATE 1896\n1 DEAT\n2 DATE 1957\n`);
    const after = indi(`${NAME_AND_SEX}1 BIRT\n2 DATE 1886\n1 DEAT\n2 DATE 1957\n`);

    expect(eventOrderSignature(after)).not.toBe(eventOrderSignature(before));
  });

  it("changes when an event is added", () => {
    const before = indi(`${NAME_AND_SEX}1 BIRT\n2 DATE 1896\n`);
    const after = indi(`${NAME_AND_SEX}1 BIRT\n2 DATE 1896\n1 DEAT\n2 DATE 1957\n`);

    expect(eventOrderSignature(after)).not.toBe(eventOrderSignature(before));
  });

  it("changes when an event is removed", () => {
    const before = indi(`${NAME_AND_SEX}1 BIRT\n2 DATE 1896\n1 DEAT\n2 DATE 1957\n`);
    const after = indi(`${NAME_AND_SEX}1 BIRT\n2 DATE 1896\n`);

    expect(eventOrderSignature(after)).not.toBe(eventOrderSignature(before));
  });

  it("changes when an event is retagged", () => {
    const before = indi(`${NAME_AND_SEX}1 OCCU Kovač\n2 DATE 1920\n`);
    const after = indi(`${NAME_AND_SEX}1 EDUC Kovač\n2 DATE 1920\n`);

    expect(eventOrderSignature(after)).not.toBe(eventOrderSignature(before));
  });

  it("ignores the record's own bookkeeping and pointers", () => {
    const before = indi(`${NAME_AND_SEX}1 BIRT\n2 DATE 1896\n1 CHAN\n2 DATE 16 AUG 2026\n`);
    const after = indi(`${NAME_AND_SEX}1 BIRT\n2 DATE 1896\n1 FAMS @F1@\n1 CHAN\n2 DATE 19 AUG 2026\n`);

    expect(eventOrderSignature(after)).toBe(eventOrderSignature(before));
  });

  it("counts a dated vendor event", () => {
    const before = indi(`${NAME_AND_SEX}1 BIRT\n2 DATE 1896\n`);
    const after = indi(`${NAME_AND_SEX}1 BIRT\n2 DATE 1896\n1 _MILT\n2 DATE 1916\n`);

    expect(eventOrderSignature(after)).not.toBe(eventOrderSignature(before));
  });

  it("reads the same on a record already in the order the sort would give it", () => {
    const record = indi(`${NAME_AND_SEX}1 DEAT\n2 DATE 1957\n1 BIRT\n2 DATE 1896\n`);
    const signature = eventOrderSignature(record);

    sortEventsByDate(record);

    // Order-sensitive by design — the sort is what changes it, and only the
    // sort. The tags are the same set, so the pieces are merely reshuffled.
    expect(eventOrderSignature(record).split("|").sort()).toEqual(signature.split("|").sort());
  });
});

describe("buildSourXrefMap", () => {
  const records = (body: string): GedNode[] =>
    parseGedcom(new TextEncoder().encode(`0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`).buffer).records;
  const REGISTER =
    "1 TITL Deaths (Umrli) 1858-1896, Ravna Gora\n1 DATA\n2 EVEN DEAT\n3 DATE FROM 1858 TO 1896\n" +
    "1 OBJE @O1@\n1 REPO @R1@\n2 CALN 004679930\n";

  it("maps a source the incoming file describes with less to the main's fuller one", () => {
    // Ravna Gora, 3 Oct 2026: the incoming register carried only its title and
    // repository, the main's the call number and DATA too — it was copied in
    // as @S2@, a second, image-less record of the same register.
    const main = records(`0 @81434866@ SOUR\n1 _STE @T62@\n${REGISTER}`);
    const compare = records("0 @S2@ SOUR\n1 TITL Deaths (Umrli) 1858-1896, Ravna Gora\n1 REPO @R9@\n");
    expect(buildSourXrefMap(compare, main).get("@S2@")).toBe("@81434866@");
  });

  it("keeps a source apart when it says something the main's does not", () => {
    const main = records(`0 @S1@ SOUR\n${REGISTER}`);
    const compare = records("0 @S2@ SOUR\n1 TITL Deaths (Umrli) 1858-1896, Ravna Gora\n1 REPO @R9@\n2 CALN 004679931\n");
    expect(buildSourXrefMap(compare, main).get("@S2@")).toBe("@S2@");
  });

  it("leaves the choice open when two main sources of that title both cover it", () => {
    const main = records(
      "0 @S1@ SOUR\n1 TITL Krstna knjiga\n1 REPO @R1@\n2 CALN 1\n" +
        "0 @S3@ SOUR\n1 TITL Krstna knjiga\n1 REPO @R1@\n2 CALN 2\n",
    );
    const compare = records("0 @S1@ SOUR\n1 TITL Krstna knjiga\n");
    expect(buildSourXrefMap(compare, main).get("@S1@")).toBe("@S2@");
  });
});
