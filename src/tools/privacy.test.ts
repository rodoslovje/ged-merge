import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import { findLiving, privatizeDataset, defaultPrivacyOptions, type PrivacyOptions } from "./privacy";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

function opts(over: Partial<PrivacyOptions> = {}): PrivacyOptions {
  return { ...defaultPrivacyOptions(), ...over };
}

const NOW = 2026;

// A small tree: I1 deceased ancestor, I2 his living son (no death, dated birth),
// I3 living grandchild with NO birth date (estimable from parent), I4 an old
// person with no death and a birth long ago (presumed dead).
const SAMPLE = `0 HEAD
1 CHAR UTF-8
1 SUBM @U1@
0 @U1@ SUBM
1 NAME Researcher
1 EMAIL me@example.com
0 @I1@ INDI
1 NAME Jože /Novak/
1 SEX M
1 BIRT
2 DATE 1900
1 DEAT
2 DATE 1970
1 FAMS @F1@
0 @I2@ INDI
1 NAME Anton /Novak/
1 SEX M
1 BIRT
2 DATE 1960
1 OCCU Teacher
1 NOTE Likes hiking
1 _UID ABC-123
1 FAMC @F1@
1 FAMS @F2@
0 @I3@ INDI
1 NAME Maja /Novak/
1 SEX F
1 FAMC @F2@
0 @I4@ INDI
1 NAME Stari /Mož/
1 SEX M
1 BIRT
2 DATE 1850
0 @F1@ FAM
1 HUSB @I1@
1 CHIL @I2@
0 @F2@ FAM
1 HUSB @I2@
1 CHIL @I3@
1 MARR
2 DATE 1990
2 PLAC Ljubljana
0 TRLR`;

describe("findLiving", () => {
  it("flags living people by birth year, by relative estimate, and by assume-living", () => {
    const ds = dataset(SAMPLE);
    const flagged = findLiving(ds, opts(), NOW);
    const byId = new Map(flagged.map((f) => [f.id, f.reason]));

    expect(byId.get("@I2@")).toBe("birth"); // born 1960, no death
    expect(byId.get("@I3@")).toBe("relative"); // undated, but parent born 1960
    expect(byId.has("@I1@")).toBe(false); // has a death event
    expect(byId.has("@I4@")).toBe(false); // born 1850 → older than threshold
  });

  it("assume-living vs skip controls undated, relative-less people", () => {
    const ds = dataset(`0 HEAD
0 @I9@ INDI
1 NAME Ghost /Person/
1 SEX U
0 TRLR`);
    expect(findLiving(ds, opts({ unknownBirthPolicy: "living" }), NOW).map((f) => f.id)).toEqual(["@I9@"]);
    expect(findLiving(ds, opts({ unknownBirthPolicy: "skip" }), NOW)).toEqual([]);
  });

  it("optionally flags recently deceased people", () => {
    const ds = dataset(SAMPLE);
    const flagged = findLiving(ds, opts({ alsoRecentlyDeceasedYears: 100 }), NOW);
    expect(flagged.find((f) => f.id === "@I1@")?.reason).toBe("recentDeath"); // died 1970
  });
});

describe("privatizeDataset — sanitize", () => {
  it("replaces names, strips details, keeps structure and stamps RESN", () => {
    const ds = dataset(SAMPLE);
    const { records, report } = privatizeDataset(ds, opts({ nameStrategy: "private" }), NOW);
    const out = serializeGedcom(records);

    expect(report.sanitized).toBe(2); // I2 and I3
    // Living son: name redacted, occupation/note/_uid gone, family links kept.
    expect(out).toMatch(/0 @I2@ INDI\n1 RESN privacy\n1 NAME Private/);
    expect(out).not.toContain("Teacher");
    expect(out).not.toContain("Likes hiking");
    expect(out).not.toContain("ABC-123");
    expect(out).toContain("1 FAMC @F1@");
    expect(out).toContain("1 FAMS @F2@");
    // Deceased ancestor untouched.
    expect(out).toContain("1 NAME Jože /Novak/");
  });

  it("privatizes a family with a living spouse (marriage details removed)", () => {
    const ds = dataset(SAMPLE);
    const { records, report } = privatizeDataset(ds, opts(), NOW);
    const out = serializeGedcom(records);
    expect(report.familiesPrivatized).toBe(1); // F2 (I2 lives)
    expect(out).not.toContain("1 MARR");
    expect(out).not.toContain("Ljubljana");
    expect(out).toMatch(/0 @F2@ FAM\n1 RESN privacy/);
    expect(out).toContain("1 HUSB @I2@"); // structure kept
  });

  it("honors the name strategy", () => {
    const ds = dataset(SAMPLE);
    const render = (s: PrivacyOptions["nameStrategy"]) =>
      serializeGedcom(privatizeDataset(ds, opts({ nameStrategy: s }), NOW).records);
    expect(render("living")).toContain("1 NAME Living");
    expect(render("surnameOnly")).toContain("1 NAME /Novak/");
    expect(render("initials")).toContain("1 NAME A.N."); // Anton Novak
    expect(render("initialSurname")).toContain("1 NAME A. /Novak/");
  });

  it("uses custom replacement text for the private strategy", () => {
    const ds = dataset(SAMPLE);
    const out = serializeGedcom(privatizeDataset(ds, opts({ nameStrategy: "private", customName: "Zasebno" }), NOW).records);
    expect(out).toContain("1 NAME Zasebno");
    // Empty custom text falls back to "Private".
    const fallback = serializeGedcom(privatizeDataset(ds, opts({ nameStrategy: "private", customName: "  " }), NOW).records);
    expect(fallback).toContain("1 NAME Private");
  });

  it("retains a detail category when its strip flag is off", () => {
    const ds = dataset(SAMPLE);
    const keepNotes = opts({ strip: { events: true, notes: false, sources: true, media: true, contact: true } });
    const out = serializeGedcom(privatizeDataset(ds, keepNotes, NOW).records);
    expect(out).toContain("1 NOTE Likes hiking");
    expect(out).not.toContain("Teacher"); // events still stripped
  });

  it("uses upper-case RESN for GEDCOM 7.0", () => {
    const ds = dataset(SAMPLE.replace("1 CHAR UTF-8", "1 GEDC\n2 VERS 7.0"));
    const out = serializeGedcom(privatizeDataset(ds, opts(), NOW).records);
    expect(out).toContain("1 RESN PRIVACY");
  });
});

describe("privatizeDataset — RESN modes", () => {
  it("mark-only keeps data and only adds the notice", () => {
    const ds = dataset(SAMPLE);
    const { records, report } = privatizeDataset(ds, opts({ resn: "markOnly" }), NOW);
    const out = serializeGedcom(records);
    expect(report.sanitized).toBe(0);
    expect(out).toContain("Teacher"); // data intact
    expect(out).toMatch(/0 @I2@ INDI\n1 RESN privacy/);
  });

  it("strip-only redacts without a notice", () => {
    const ds = dataset(SAMPLE);
    const out = serializeGedcom(privatizeDataset(ds, opts({ resn: "stripOnly" }), NOW).records);
    expect(out).not.toContain("1 RESN");
    expect(out).not.toContain("Teacher");
  });
});

describe("privatizeDataset — remove", () => {
  it("removes flagged records and scrubs family pointers", () => {
    const ds = dataset(SAMPLE);
    const { records, report } = privatizeDataset(ds, opts({ action: "remove" }), NOW);
    const out = serializeGedcom(records);
    expect(report.removed).toBe(2); // I2, I3
    expect(out).not.toContain("@I2@ INDI");
    expect(out).not.toContain("@I3@ INDI");
    expect(out).not.toContain("1 CHIL @I2@"); // pointer scrubbed from F1
    // F2 had only I2 (husband) + I3 (child) → empty → dropped.
    expect(out).not.toContain("@F2@ FAM");
    expect(report.familiesRemoved).toBe(1);
  });

  it("cascades to descendants when requested", () => {
    const ds = dataset(SAMPLE);
    const { report } = privatizeDataset(ds, opts({ action: "removeDescendants" }), NOW);
    // I2 flagged → its descendant I3 also removed (both already flagged here),
    // but the cascade path is exercised and both go.
    expect(report.removed).toBe(2);
  });
});

describe("privatizeDataset — file-level scrubs", () => {
  it("strips the submitter record and HEAD pointer", () => {
    const ds = dataset(SAMPLE);
    const { records, report } = privatizeDataset(ds, opts({ file: { stripSubmitter: true, stripExternalIds: false, scrubAddress: false, scrubEmail: false, scrubPhone: false } }), NOW);
    const out = serializeGedcom(records);
    expect(report.submitterRemoved).toBe(true);
    expect(out).not.toContain("@U1@ SUBM");
    expect(out).not.toContain("1 SUBM @U1@");
  });

  it("strips external ids globally", () => {
    const ds = dataset(SAMPLE);
    // mark-only so the _UID survives phase 1 and must be removed by the scrub.
    const o = opts({ resn: "markOnly", file: { stripSubmitter: false, stripExternalIds: true, scrubAddress: false, scrubEmail: false, scrubPhone: false } });
    const { records, report } = privatizeDataset(ds, o, NOW);
    expect(serializeGedcom(records)).not.toContain("ABC-123");
    expect(report.externalIdsStripped).toBe(1);
  });

  it("global contact scrub removes emails everywhere", () => {
    const ds = dataset(SAMPLE);
    const o = opts({ file: { stripSubmitter: false, stripExternalIds: false, scrubAddress: false, scrubEmail: true, scrubPhone: false } });
    const { records, report } = privatizeDataset(ds, o, NOW);
    expect(serializeGedcom(records)).not.toContain("me@example.com");
    expect(report.contactScrubbed).toBe(1);
  });
});
