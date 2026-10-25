import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import { migrateVersion } from "../normalize/migrate";
import { normalizeDataset } from "../normalize/normalize";
import { inferMainProfile } from "../normalize/profile";
import { applyFormatOverrides } from "../normalize/formatOverrides";
import { applyRecordPatches } from "../ui/historyTypes";
import { validateConformance } from "./conformance/conformance";
import { countFixableConformance, fixConformance } from "./fixConformance";
import { validateStructure } from "./structure";
import { normalizeRepairKinds } from "./normalizeRepairs";

// A source's filing number and periodical — MacFamilyTree's FILN/PERI, which
// neither standard has — in the standard's own forms: the repository link's
// call number and the title. Never the `_FILN`/`_PERI` extensions.

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer as ArrayBuffer));
}
const head = (version: "5.5.1" | "7.0") =>
  version === "7.0" ? "0 HEAD\n1 GEDC\n2 VERS 7.0\n" : "0 HEAD\n1 SOUR TEST\n1 GEDC\n2 VERS 5.5.1\n2 FORM LINEAGE-LINKED\n1 CHAR UTF-8\n";
const file = (version: "5.5.1" | "7.0", body: string) => dataset(`${head(version)}${body}0 TRLR\n`);
const SOURCES = `0 @R1@ REPO
1 NAME Archive
0 @S1@ SOUR
1 TITL Obituary
1 PERI Slovenec
1 FILN 123
1 REPO @R1@
0 @S2@ SOUR
1 TITL Register
1 _FILN 9
0 @S3@ SOUR
1 _PERI Domoljub
`;
/** The source records as text, without the header. */
const sources = (records: { tag: string; xref?: string }[]) =>
  serializeGedcom(records.filter((r) => r.tag === "SOUR") as never).trim();

describe("the health check's source-fields repair", () => {
  for (const version of ["5.5.1", "7.0"] as const) {
    it(`restates every source in a strict ${version} file, in one step, adding no finding`, () => {
      const ds = file(version, SOURCES);
      const strict = { standard: version };
      expect(countFixableConformance(ds, "sourceFields", strict)).toBe(3);
      const before = serializeGedcom(ds.records);
      const patches = fixConformance(ds, "sourceFields", undefined, strict);
      expect(sources(ds.records)).toBe(
        [
          "0 @S1@ SOUR\n1 TITL Obituary, Slovenec\n1 REPO @R1@\n2 CALN 123",
          `0 @S2@ SOUR\n1 TITL Register\n1 REPO${version === "7.0" ? " @VOID@" : ""}\n2 CALN 9`,
          "0 @S3@ SOUR\n1 TITL Domoljub",
        ].join("\n"),
      );
      expect(validateConformance(ds).filter((i) => i.recordTag === "SOUR")).toEqual([]);
      // Idempotent, and one undo brings the file back.
      expect(fixConformance(ds, "sourceFields", undefined, strict)).toEqual([]);
      applyRecordPatches(ds, patches, "undo");
      expect(serializeGedcom(ds.records)).toBe(before);
    });
  }

  it("keeps the file's own FILN and PERI with its variations, turning the old extensions into them", () => {
    const ds = file("5.5.1", SOURCES);
    fixConformance(ds, "sourceFields");
    expect(sources(ds.records)).toBe(
      [
        "0 @S1@ SOUR\n1 TITL Obituary\n1 PERI Slovenec\n1 FILN 123\n1 REPO @R1@",
        "0 @S2@ SOUR\n1 TITL Register\n1 FILN 9",
        "0 @S3@ SOUR\n1 PERI Domoljub",
      ].join("\n"),
    );
  });

  it("marks the rows it repairs", () => {
    const rows = validateStructure(file("5.5.1", SOURCES)).issues.filter((i) => i.sourceField);
    expect(rows.map((i) => i.sample).sort()).toEqual(["FILN", "PERI", "_FILN", "_PERI"]);
  });
});

describe("an incoming source's FILN/PERI", () => {
  const incoming = "0 @S1@ SOUR\n1 TITL Obituary\n1 PERI Slovenec\n1 FILN 123\n";
  it("takes the standard's forms in a main that writes none", () => {
    const main = file("7.0", "0 @S9@ SOUR\n1 TITL Book\n");
    const { dataset: out } = normalizeDataset(file("5.5.1", incoming), inferMainProfile(main));
    expect(sources(out.records)).toBe("0 @S1@ SOUR\n1 TITL Obituary, Slovenec\n1 REPO @VOID@\n2 CALN 123");
  });

  it("stays as it is in a MacFamilyTree main kept with its variations, but not in a strict one", () => {
    const main = file("5.5.1", "0 @S9@ SOUR\n1 TITL Book\n1 PERI Daily\n1 FILN 1\n");
    const kept = normalizeDataset(file("5.5.1", incoming), inferMainProfile(main)).dataset;
    expect(sources(kept.records)).toBe(incoming.trim());
    const strict = applyFormatOverrides(inferMainProfile(main), { standard: "5.5.1" });
    const converted = normalizeDataset(file("5.5.1", incoming), strict).dataset;
    expect(sources(converted.records)).toBe("0 @S1@ SOUR\n1 TITL Obituary, Slovenec\n1 REPO\n2 CALN 123");
  });
});

describe("the health check's 7.0 extensions repair", () => {
  const body = "0 @I1@ INDI\n1 NAME Ana /Novak/\n2 _MARNM Kos\n1 _UID 0123ABCD\n1 _FID GPZG-CXL\n1 _UPD 1 JAN 2020\n";
  it("writes each extension as the structure 7.0 has for it, in one step, adding no finding", () => {
    const ds = file("7.0", body);
    expect(countFixableConformance(ds, "extensions")).toBe(1);
    const before = serializeGedcom(ds.records);
    const patches = fixConformance(ds, "extensions");
    const text = serializeGedcom(ds.records);
    expect(text).toContain("1 UID 0123ABCD");
    expect(text).toContain("1 EXID GPZG-CXL\n2 TYPE https://www.familysearch.org/tree/person/");
    expect(text).toContain("1 NAME Ana /Kos/\n2 TYPE MARRIED");
    // An extension with nothing standard behind it stays.
    expect(text).toContain("1 _UPD 1 JAN 2020");
    expect(validateConformance(ds)).toEqual([]);
    expect(fixConformance(ds, "extensions")).toEqual([]);
    applyRecordPatches(ds, patches, "undo");
    expect(serializeGedcom(ds.records)).toBe(before);
  });

  it("runs in Normalize only for a strict 7.0 target", () => {
    const ds = file("7.0", body);
    expect(normalizeRepairKinds(ds, { standard: "7.0" })).toContain("extensions");
    expect(normalizeRepairKinds(ds, {})).not.toContain("extensions");
  });
});

describe("a repository link to no repository across versions", () => {
  it("is a pointer-less REPO in 5.5.1 and REPO @VOID@ in 7.0, call number kept", () => {
    const up = file("5.5.1", "0 @S1@ SOUR\n1 TITL Book\n1 REPO\n2 CALN 5\n");
    migrateVersion(up.records, "5.5.1", "7.0", () => {});
    expect(sources(up.records)).toBe("0 @S1@ SOUR\n1 TITL Book\n1 REPO @VOID@\n2 CALN 5");
    const down = file("7.0", "0 @S1@ SOUR\n1 TITL Book\n1 REPO @VOID@\n2 CALN 5\n");
    migrateVersion(down.records, "7.0", "5.5.1", () => {});
    expect(sources(down.records)).toBe("0 @S1@ SOUR\n1 TITL Book\n1 REPO\n2 CALN 5");
  });
});
