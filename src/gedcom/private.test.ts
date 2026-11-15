import { describe, expect, it } from "vitest";
import type { GedNode } from "./types";
import { detectPrivacyStyle, isPrivateNode, privateFlagWritable, setPrivateFlag } from "./private";
import { parseGedcom } from "./parser";
import { validateConformance } from "../tools/conformance/conformance";

function node(tag: string, value?: string, children: GedNode[] = []): GedNode {
  return { level: 1, tag, value, children };
}
function rec(children: GedNode[]): GedNode {
  return { level: 0, tag: "INDI", xref: "@I1@", children };
}

describe("isPrivateNode", () => {
  it("recognizes every dialect", () => {
    expect(isPrivateNode(rec([node("PRIV")]))).toBe(true); // MacFamilyTree, bare
    expect(isPrivateNode(rec([node("PRIV", "Y")]))).toBe(true);
    expect(isPrivateNode(rec([node("_PRIV", "Y")]))).toBe(true); // MyHeritage
    expect(isPrivateNode(rec([node("RESN", "privacy")]))).toBe(true);
    expect(isPrivateNode(rec([node("RESN", "CONFIDENTIAL")]))).toBe(true);
    expect(isPrivateNode(rec([node("RESN", "CONFIDENTIAL, LOCKED")]))).toBe(true); // 7.0 list
  });

  it("does not mistake non-privacy restrictions for private", () => {
    expect(isPrivateNode(rec([node("RESN", "NONE")]))).toBe(false); // webtrees noise
    expect(isPrivateNode(rec([node("RESN", "locked")]))).toBe(false); // edit-protection
    expect(isPrivateNode(rec([node("RESN", "NONE, LOCKED")]))).toBe(false);
    expect(isPrivateNode(rec([node("NOTE", "PRIV mentioned in text")]))).toBe(false);
  });
});

describe("detectPrivacyStyle", () => {
  it("follows the file's own dialect, standard RESN when there is none", () => {
    expect(detectPrivacyStyle([rec([node("PRIV")]), rec([node("PRIV")])])).toBe("PRIV");
    expect(detectPrivacyStyle([rec([node("_PRIV", "Y")])])).toBe("_PRIV");
    expect(detectPrivacyStyle([rec([node("RESN", "confidential")])])).toBe("RESN");
    expect(detectPrivacyStyle([rec([node("RESN", "NONE")])])).toBe("RESN"); // no markers at all
    expect(detectPrivacyStyle([rec([])])).toBe("RESN");
  });
});

describe("setPrivateFlag", () => {
  it("writes the file's dialect and clears all dialects", () => {
    const r = rec([node("NAME", "Ana /Novak/")]);
    setPrivateFlag(r, true, "PRIV", "5.5.1");
    expect(r.children.some((c) => c.tag === "PRIV" && c.value === undefined)).toBe(true);
    setPrivateFlag(r, false, "PRIV", "5.5.1");
    expect(isPrivateNode(r)).toBe(false);

    setPrivateFlag(r, true, "_PRIV", "5.5.1");
    expect(r.children.some((c) => c.tag === "_PRIV" && c.value === "Y")).toBe(true);
  });

  it("keeps non-privacy RESN list entries when clearing", () => {
    const r = rec([node("RESN", "CONFIDENTIAL, LOCKED")]);
    setPrivateFlag(r, false, "RESN", "5.5.1");
    expect(r.children.find((c) => c.tag === "RESN")?.value).toBe("LOCKED");
    expect(isPrivateNode(r)).toBe(false);
  });

  it("RESN casing follows the GEDCOM version", () => {
    const r = rec([]);
    setPrivateFlag(r, true, "RESN", "7.0");
    expect(r.children.find((c) => c.tag === "RESN")?.value).toBe("PRIVACY");
    const r2 = rec([]);
    setPrivateFlag(r2, true, "RESN", "5.5.1");
    expect(r2.children.find((c) => c.tag === "RESN")?.value).toBe("privacy");
  });
});

describe("privateFlagWritable", () => {
  const strict = (version: "5.5.1" | "7.0") => ({ strict: true, version });

  it("is unavailable in a strict target where the version has no RESN", () => {
    for (const version of ["5.5.1", "7.0"] as const) {
      expect(privateFlagWritable(strict(version), { level: 0, tag: "INDI" })).toBe(true);
      expect(privateFlagWritable(strict(version), { level: 1, tag: "BIRT" })).toBe(true);
      expect(privateFlagWritable(strict(version), { level: 1, tag: "NOTE" })).toBe(false);
      expect(privateFlagWritable(strict(version), { level: 0, tag: version === "7.0" ? "SNOTE" : "NOTE" })).toBe(false);
      expect(privateFlagWritable(strict(version), { level: 1, tag: "OBJE" })).toBe(false);
    }
    // A media record takes RESN in 7.0 only.
    expect(privateFlagWritable(strict("5.5.1"), { level: 0, tag: "OBJE" })).toBe(false);
    expect(privateFlagWritable(strict("7.0"), { level: 0, tag: "OBJE" })).toBe(true);
  });

  it("keeps every lock in the file's own format", () => {
    expect(privateFlagWritable({ strict: false, version: "7.0" }, { level: 1, tag: "NOTE" })).toBe(true);
  });

  it.each(["5.5.1", "7.0"] as const)("where it is writable, strict %s finds nothing in the marker", (version) => {
    const records = parseGedcom(new TextEncoder().encode(
      `0 HEAD\n1 GEDC\n2 VERS ${version}\n0 @I1@ INDI\n1 BIRT\n2 DATE 1900\n1 NOTE a note\n0 @O1@ OBJE\n1 FILE a.jpg\n2 FORM ${version === "7.0" ? "image/jpeg" : "jpg"}\n0 TRLR\n`).buffer).records;
    const before = validateConformance({ records });
    const indi = records.find((r) => r.tag === "INDI")!;
    const lines = [indi, ...indi.children, records.find((r) => r.tag === "OBJE")!];
    let set = 0;
    for (const line of lines) {
      if (!privateFlagWritable(strict(version), line)) continue;
      setPrivateFlag(line, true, "RESN", version);
      set++;
    }
    expect(set).toBe(version === "7.0" ? 3 : 2);
    expect(validateConformance({ records })).toEqual(before);
  });
});
